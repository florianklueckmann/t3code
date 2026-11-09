import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { CodexHomeLayout } from "./CodexHomeLayout.ts";
import {
  CODEX_NO_CHANGES_DISABLED_FEATURES,
  type CodexNoChangesHome,
  materializeCodexNoChangesHome,
  verifyCodexNoChangesProcess,
} from "./CodexNoChangesProfile.ts";

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-no-changes-" });
  const shared = path.join(root, "shared");
  const shadow = path.join(root, "shadow");
  const elsewhere = path.join(root, "elsewhere");
  for (const directory of [shared, shadow, elsewhere]) {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
  }
  yield* fileSystem.writeFileString(path.join(shadow, "auth.json"), "{}");
  yield* fileSystem.writeFileString(path.join(elsewhere, "config.toml"), "[mcp_servers.x]\n");
  const layout: CodexHomeLayout = {
    mode: "authOverlay",
    sharedHomePath: shared,
    effectiveHomePath: shadow,
    continuationKey: `codex:home:${shared}`,
  };
  return { root, shared, shadow, elsewhere, layout, homePath: path.join(root, "sealed") };
});

it.layer(NodeServices.layer)("CodexNoChangesProfile", (it) => {
  it.effect.skipIf(!symlinksSupported)(
    "links only the selected sign-in and the conversation store, and rewrites its config",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { shared, shadow, elsewhere, layout, homePath } = yield* fixture;
        // Planted entries: a credential copy, a linked config and a linked store.
        yield* fileSystem.makeDirectory(homePath, { recursive: true });
        yield* fileSystem.writeFileString(path.join(homePath, "auth.json"), '{"copied":true}');
        yield* fileSystem.symlink(
          path.join(elsewhere, "config.toml"),
          path.join(homePath, "config.toml"),
        );
        yield* fileSystem.symlink(elsewhere, path.join(homePath, "sessions"));

        const home = yield* materializeCodexNoChangesHome({ layout, homePath });

        const links: Record<string, string> = {};
        for (const name of yield* fileSystem.readDirectory(homePath)) {
          const target = yield* fileSystem
            .readLink(path.join(homePath, name))
            .pipe(Effect.orElseSucceed(() => undefined));
          if (target !== undefined) links[name] = target;
        }
        assert.deepEqual(links, {
          archived_sessions: path.join(shared, "archived_sessions"),
          "auth.json": path.join(shadow, "auth.json"),
          "auth.lock": path.join(shadow, "auth.lock"),
          sessions: path.join(shared, "sessions"),
          "thread-writer-locks": path.join(shared, "thread-writer-locks"),
        });
        assert.equal(yield* fileSystem.readFileString(home.configPath), home.configText);
        assert.equal(home.userConfig.sqlite_home, shadow);
        assert.include(home.configText, 'sandbox_mode = "read-only"');
        assert.notInclude(home.configText, "mcp_servers");
        assert.notInclude(home.configText, "projects");
        assert.equal(
          yield* fileSystem.readFileString(path.join(elsewhere, "config.toml")),
          "[mcp_servers.x]\n",
        );

        // An edit between runs never survives the next start.
        yield* fileSystem.writeFileString(home.configPath, "[mcp_servers.late]\n");
        yield* materializeCodexNoChangesHome({ layout, homePath });
        assert.equal(yield* fileSystem.readFileString(home.configPath), home.configText);
      }).pipe(Effect.scoped),
  );

  const home: CodexNoChangesHome = {
    homePath: "/sealed",
    configPath: "/sealed/config.toml",
    configText: "config text",
    userConfig: { sandbox_mode: "read-only" },
  };

  type Responses = Record<string, (params: any) => unknown>;
  const passing: Responses = {
    "account/read": () => ({ account: { type: "apiKey" } }),
    "config/read": () => ({
      config: { sandbox_mode: "read-only", approval_policy: "never", mcp_servers: {} },
      layers: [
        { name: { type: "user", file: home.configPath }, config: home.userConfig },
        { name: { type: "system", file: "/etc/codex/config.toml" }, config: {} },
        {
          name: { type: "project", dotCodexFolder: "/w/.codex" },
          disabledReason: "untrusted",
          config: { mcp_servers: { p: {} } },
        },
      ],
    }),
    "experimentalFeature/list": () => ({
      data: CODEX_NO_CHANGES_DISABLED_FEATURES.map((name) => ({ name, enabled: false })),
      nextCursor: null,
    }),
    "hooks/list": () => ({ data: [{ cwd: "/w", hooks: [] }] }),
    "command/exec": ({ command }: { command: ReadonlyArray<string> }) =>
      command[0] === "/bin/cat"
        ? { exitCode: 0, stdout: home.configText, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "Operation not permitted" },
  };
  const verify = (
    overrides: Responses = {},
    options: { readonly version?: string; readonly account?: Record<string, string> } = {},
  ) => {
    const requests: Array<string> = [];
    const responses = { ...passing, ...overrides };
    const client = {
      request: (method: string, params: unknown) =>
        Effect.sync(() => {
          requests.push(method);
          return responses[method]!(params);
        }),
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    return verifyCodexNoChangesProcess({
      client,
      home,
      version: options.version ?? "0.167.0",
      cwd: "/w",
      expectedAccount: { status: "authenticated", type: "apiKey", ...options.account },
    }).pipe(
      Effect.flip,
      Effect.map((error) => ({ reason: error.reason, requests })),
    );
  };

  it.effect("proves the process before any thread starts and refuses on every gap", () =>
    Effect.gen(function* () {
      const requests: Array<string> = [];
      yield* verifyCodexNoChangesProcess({
        client: {
          request: (method: string, params: unknown) =>
            Effect.sync(() => (requests.push(method), passing[method]!(params))),
        } as unknown as CodexClient.CodexAppServerClient["Service"],
        home,
        version: "0.167.0",
        cwd: "/w",
        expectedAccount: { status: "authenticated", type: "apiKey" },
      });
      assert.notInclude(requests, "thread/start");

      const featureOn = CODEX_NO_CHANGES_DISABLED_FEATURES.map((name) => ({
        name,
        enabled: name === "apps",
      }));
      const cases = [
        ["version", verify({}, { version: "0.166.9" })],
        ["version", verify({}, { version: "0.168.0" })],
        [
          "chatgpt-account",
          verify({}, { account: { type: "chatgpt", email: "a@example.invalid" } }),
        ],
        ["account", verify({ "account/read": () => ({ account: null }) })],
        [
          "account",
          verify({
            "account/read": () => ({ account: { type: "chatgpt", email: "a@example.invalid" } }),
          }),
        ],
        [
          "config",
          verify({
            "config/read": () => ({ ...(passing["config/read"]!({}) as object), layers: [] }),
          }),
        ],
        [
          "config",
          verify({
            "config/read": () => ({
              config: { sandbox_mode: "read-only", approval_policy: "never", mcp_servers: {} },
              layers: [
                { name: { type: "user", file: home.configPath }, config: home.userConfig },
                {
                  name: { type: "system", file: "/etc/codex/config.toml" },
                  config: { mcp_servers: { m: {} } },
                },
              ],
            }),
          }),
        ],
        [
          "config",
          verify({
            "config/read": () => ({
              ...(passing["config/read"]!({}) as object),
              config: {
                sandbox_mode: "read-only",
                approval_policy: "never",
                mcp_servers: { m: {} },
              },
            }),
          }),
        ],
        [
          "config",
          verify({ "experimentalFeature/list": () => ({ data: featureOn, nextCursor: null }) }),
        ],
        [
          "config",
          verify({
            "experimentalFeature/list": () => ({
              data: featureOn.slice(1).map((f) => ({ ...f, enabled: false })),
              nextCursor: null,
            }),
          }),
        ],
        ["hooks", verify({ "hooks/list": () => ({ data: [{ cwd: "/w", hooks: [{}] }] }) })],
        ["sandbox", verify({ "command/exec": () => ({ exitCode: 1, stdout: "", stderr: "" }) })],
        [
          "sandbox",
          verify({ "command/exec": () => ({ exitCode: 0, stdout: home.configText, stderr: "" }) }),
        ],
      ] as const;
      for (const [reason, run] of cases) {
        const refused = yield* run;
        assert.equal(refused.reason, reason);
        assert.notInclude(refused.requests, "thread/start");
      }
    }),
  );
});
