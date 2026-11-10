import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";

import { type CodexHomeLayout, codexStoreStartPermit } from "./CodexHomeLayout.ts";
import {
  acquireCodexNoChangesHome,
  checkCodexOrdinaryStore,
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
        const { root, shared, shadow, elsewhere, layout, homePath } = yield* fixture;
        // Planted links: a config and a store pointing elsewhere.
        yield* fileSystem.makeDirectory(homePath, { recursive: true });
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

        // A hard link, even with equal bytes, lets another name edit the config in place.
        const outside = path.join(root, "outside.toml");
        yield* fileSystem.link(home.configPath, outside);
        const refusedLive = yield* Effect.flip(
          materializeCodexNoChangesHome({ layout, homePath, live: true }),
        );
        assert.equal(
          refusedLive._tag === "ProviderAdapterNoChangesRefusedError" && refusedLive.reason,
          "home",
        );
        yield* materializeCodexNoChangesHome({ layout, homePath });
        assert.deepEqual((yield* fileSystem.stat(home.configPath)).nlink, Option.some(1n));
        assert.equal(yield* fileSystem.readFileString(outside), home.configText);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "refuses and keeps entries it does not own, and a redirected home",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const plant = (
          build: (input: {
            readonly homePath: string;
            readonly elsewhere: string;
          }) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError>,
        ) =>
          Effect.gen(function* () {
            const { layout, homePath, elsewhere } = yield* fixture;
            const kept = yield* build({ homePath, elsewhere }).pipe(Effect.orDie);
            const outcome = yield* Effect.flip(materializeCodexNoChangesHome({ layout, homePath }));
            const survived: Array<string> = [];
            for (const file of kept) {
              survived.push(`${path.basename(file)}=${yield* fileSystem.readFileString(file)}`);
            }
            return {
              reason:
                outcome._tag === "ProviderAdapterNoChangesRefusedError" ? outcome.reason : "io",
              survived,
              elsewhereConfig: yield* fileSystem.readFileString(
                path.join(elsewhere, "config.toml"),
              ),
            };
          });
        const write = (file: string, text: string) =>
          fileSystem
            .makeDirectory(path.dirname(file), { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(file, text)), Effect.as(file));

        // Real conversation data and a live writer's lock where links belong.
        assert.deepEqual(
          yield* plant(({ homePath }) =>
            Effect.all([
              write(path.join(homePath, "sessions", "keep.jsonl"), "history"),
              write(path.join(homePath, "thread-writer-locks", "active.lock"), "writer"),
            ]),
          ),
          {
            reason: "home",
            survived: ["keep.jsonl=history", "active.lock=writer"],
            elsewhereConfig: "[mcp_servers.x]\n",
          },
        );
        // A credential copy is left for the user to look at, not deleted.
        assert.deepEqual(
          yield* plant(({ homePath }) =>
            Effect.all([write(path.join(homePath, "auth.json"), '{"copied":true}')]),
          ),
          {
            reason: "home",
            survived: ['auth.json={"copied":true}'],
            elsewhereConfig: "[mcp_servers.x]\n",
          },
        );
        // A home redirected elsewhere is never written through.
        assert.deepEqual(
          yield* plant(({ homePath, elsewhere }) =>
            fileSystem.symlink(elsewhere, homePath).pipe(Effect.as([])),
          ),
          { reason: "home", survived: [], elsewhereConfig: "[mcp_servers.x]\n" },
        );
        assert.deepEqual(
          yield* plant(({ homePath }) =>
            fileSystem
              .makeDirectory(path.join(homePath, "config.toml"), { recursive: true })
              .pipe(Effect.as([])),
          ),
          { reason: "home", survived: [], elsewhereConfig: "[mcp_servers.x]\n" },
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "leaves a live home untouched: the same layout reuses it, another is refused",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, shared, shadow, layout } = yield* fixture;
        // Two components missing below a linked ancestor: the home is the same before and after.
        const alias = path.join(root, "alias");
        yield* fileSystem.symlink(root, alias);
        const homePath = path.join(alias, "state", "sealed");
        const storePermit = yield* codexStoreStartPermit(homePath);
        const configInode = fileSystem
          .stat(path.join(homePath, "config.toml"))
          .pipe(Effect.map((info) => info.ino));
        const authTarget = fileSystem.readLink(path.join(homePath, "auth.json"));
        const otherAccount: CodexHomeLayout = {
          ...layout,
          mode: "direct",
          effectiveHomePath: undefined,
        };

        const live = yield* Scope.make();
        yield* acquireCodexNoChangesHome({ layout, homePath }).pipe(Scope.provide(live));
        const inode = yield* configInode;
        assert.strictEqual(yield* codexStoreStartPermit(homePath), storePermit);

        // A second process on the same layout: no write at all.
        yield* acquireCodexNoChangesHome({ layout, homePath }).pipe(Effect.scoped);
        assert.deepEqual(yield* configInode, inode);
        // Another account while the first process runs: refused, links kept.
        const refused = yield* Effect.flip(
          acquireCodexNoChangesHome({ layout: otherAccount, homePath }).pipe(Effect.scoped),
        );
        assert.equal(
          refused._tag === "ProviderAdapterNoChangesRefusedError" && refused.reason,
          "home",
        );
        assert.equal(yield* authTarget, path.join(shadow, "auth.json"));

        // Once nothing runs on it, the home follows the new account.
        yield* Scope.close(live, Exit.void);
        yield* acquireCodexNoChangesHome({ layout: otherAccount, homePath }).pipe(Effect.scoped);
        assert.equal(yield* authTarget, path.join(shared, "auth.json"));
      }).pipe(Effect.scoped),
  );

  it.effect("refuses an ordinary process that keeps its threads somewhere else", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { shadow, layout } = yield* fixture;
      const check = (config: string | undefined, environment: NodeJS.ProcessEnv = {}) =>
        Effect.gen(function* () {
          const configPath = path.join(shadow, "config.toml");
          if (config === undefined) yield* fileSystem.remove(configPath, { force: true });
          else yield* fileSystem.writeFileString(configPath, config);
          const outcome = yield* Effect.result(
            checkCodexOrdinaryStore({ layout, settingsHomePath: shadow, environment }),
          );
          return outcome._tag === "Success" ? "ok" : outcome.failure.reason;
        });
      const outcomes = [
        yield* check(undefined),
        yield* check('model = "gpt"\n'),
        yield* check('sqlite_home = "/elsewhere"\n'),
        yield* check('[profiles.work]\nsqlite_home = "/elsewhere"\n'),
        yield* check('"sqlite\\u005fhome" = "/elsewhere"\n'),
        yield* check(undefined, { CODEX_SQLITE_HOME: "/elsewhere" }),
      ];
      assert.deepEqual(outcomes, ["ok", "ok", "store", "store", "store", "store"]);
      const direct = yield* Effect.result(
        checkCodexOrdinaryStore({
          layout: { ...layout, mode: "direct", effectiveHomePath: undefined },
          settingsHomePath: "",
          environment: { CODEX_HOME: shadow },
        }),
      );
      assert.equal(direct._tag === "Failure" && direct.failure.reason, "store");
    }).pipe(Effect.scoped),
  );

  const home: CodexNoChangesHome = {
    homePath: "/sealed",
    configPath: "/sealed/config.toml",
    configText: "config text",
    userConfig: { sandbox_mode: "read-only", sqlite_home: "/account" },
  };

  type Responses = Record<string, (params: any) => unknown>;
  const passing: Responses = {
    "account/read": () => ({ account: { type: "apiKey" } }),
    "config/read": () => ({
      config: {
        sandbox_mode: "read-only",
        approval_policy: "never",
        mcp_servers: {},
        sqlite_home: "/account",
      },
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
        // A required sqlite_home that moves the store past T3 Code's config.
        [
          "store",
          verify({
            "config/read": () => {
              const read = passing["config/read"]!({}) as { config: object };
              return { ...read, config: { ...read.config, sqlite_home: "/required" } };
            },
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
