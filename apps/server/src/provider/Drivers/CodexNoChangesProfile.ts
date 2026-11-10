import * as NodeNet from "node:net";

import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as CodexClient from "effect-codex-app-server/client";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  codexAccountHomePath,
  type CodexHomeLayout,
  codexPhysicalPath,
} from "./CodexHomeLayout.ts";

/**
 * Pinned to the version the native No changes fixture verified: a later Codex can add a tool
 * behind a new default-on flag this profile does not know to turn off.
 */
const CODEX_NO_CHANGES_VERIFIED_VERSION = "0.167.0";

/**
 * Each must be reported present and off: they add tools or act outside the sandbox. A removed
 * flag reports a fixed value and cannot be listed here (0.167.0 reports `worktrees` on).
 */
export const CODEX_NO_CHANGES_DISABLED_FEATURES = [
  "hooks",
  "apps",
  "plugins",
  "remote_plugin",
  "plugin_discovery_prefetch",
  "plugin_sharing",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "in_app_browser",
  "in_app_local_automation",
  "image_generation",
  "tool_suggest",
  "skill_mcp_dependency_install",
  "memories",
  "goals",
] as const;

/** Codex keeps conversations here and in the SQLite stores `sqlite_home` points at. */
const SHARED_STORE_ENTRIES = ["sessions", "archived_sessions", "thread-writer-locks"] as const;
/** The selected sign-in, and the lock Codex holds while it refreshes it. */
const SHARED_AUTH_ENTRIES = ["auth.json", "auth.lock"] as const;

/**
 * A home T3 Code owns for runs that may change nothing: the selected account's credential and
 * conversation store, and no user config, MCP servers, hooks, skills or plugins.
 */
export interface CodexNoChangesHome {
  readonly homePath: string;
  readonly configPath: string;
  readonly configText: string;
  /** What Codex must report for the user layer it loaded. */
  readonly userConfig: { readonly [key: string]: Schema.Json };
}

class CodexNoChangesHomeError extends Schema.TaggedError<CodexNoChangesHomeError>()(
  "CodexNoChangesHomeError",
  {
    operation: Schema.Literals(["inspect", "makeDirectory", "remove", "symlink", "writeConfig"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not prepare the No changes Codex home: ${this.operation} failed for '${this.path}'.`;
  }
}

const userConfigFor = (sharedHomePath: string) => ({
  cli_auth_credentials_store: "file",
  sandbox_mode: "read-only",
  approval_policy: "never",
  sqlite_home: sharedHomePath,
  features: Object.fromEntries(CODEX_NO_CHANGES_DISABLED_FEATURES.map((name) => [name, false])),
});

// JSON strings are valid TOML basic strings, and the values here are only strings and booleans.
const renderConfig = ({ features, ...top }: ReturnType<typeof userConfigFor>) => {
  const line = ([key, value]: readonly [string, unknown]) => `${key} = ${JSON.stringify(value)}`;
  return [
    ...Object.entries(top).map(line),
    "",
    "[features]",
    ...Object.entries(features).map(line),
    "",
  ].join("\n");
};

/** One home per provider instance, in T3 Code's state, never inside the user's Codex home. */
export const codexNoChangesHomePath = (input: {
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly instanceId: string;
}) =>
  input.path.join(
    input.stateDir,
    "codex-no-changes",
    encodeURIComponent(input.instanceId).replaceAll("%", "_"),
  );

type EntryState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Link"; readonly target: string }
  | { readonly _tag: "File" | "Directory" | "Other" };

// readLink on an entry that is not a link fails with EINVAL.
const isNotSymlink = (cause: PlatformError.PlatformError) =>
  cause.reason._tag === "Unknown" &&
  Predicate.isObject(cause.reason.cause) &&
  "code" in cause.reason.cause &&
  cause.reason.cause.code === "EINVAL";

const inspectEntry = Effect.fn("CodexNoChangesProfile.inspectEntry")(function* (entry: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (cause: unknown) =>
    new CodexNoChangesHomeError({ operation: "inspect", path: entry, cause });
  const link = yield* fileSystem.readLink(entry).pipe(
    Effect.map((target): EntryState => ({
      _tag: "Link",
      target: path.resolve(path.dirname(entry), target),
    })),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed<EntryState>({ _tag: "Missing" })
          : isNotSymlink(cause)
            ? Effect.undefined
            : Effect.fail(fail(cause)),
    }),
  );
  if (link !== undefined) return link;
  const { type } = yield* fileSystem.stat(entry).pipe(Effect.mapError(fail));
  return {
    _tag: type === "File" ? "File" : type === "Directory" ? "Directory" : "Other",
  } satisfies EntryState;
});

/**
 * Replaces only its own config and links. A real entry where a link belongs, or a redirected
 * home, may hold data or a live writer's lock, so it is refused and kept. While another process
 * runs on this home (`live`), nothing is written: it must already be exactly this layout.
 */
export const materializeCodexNoChangesHome = Effect.fn("materializeCodexNoChangesHome")(
  function* (input: {
    readonly layout: CodexHomeLayout;
    readonly homePath: string;
    readonly live?: boolean;
  }): Effect.fn.Return<
    CodexNoChangesHome,
    CodexNoChangesHomeError | ProviderAdapter.ProviderAdapterNoChangesRefusedError,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fail =
      (operation: CodexNoChangesHomeError["operation"], target: string) => (cause: unknown) =>
        new CodexNoChangesHomeError({ operation, path: target, cause });
    const makeDirectory = (directory: string) =>
      fileSystem
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.mapError(fail("makeDirectory", directory)));
    // Only ever called on a link or a file T3 Code wrote, never recursively.
    const unlink = (entry: string) =>
      fileSystem.remove(entry).pipe(Effect.mapError(fail("remove", entry)));
    const refuseHome = refuse("home");

    const accountHomePath = codexAccountHomePath(input.layout);
    const configPath = path.join(input.homePath, "config.toml");
    const userConfig = userConfigFor(accountHomePath);
    const configText = renderConfig(userConfig);
    const links = [
      ...SHARED_STORE_ENTRIES.map(
        (name) => [name, path.join(input.layout.sharedHomePath, name)] as const,
      ),
      ...SHARED_AUTH_ENTRIES.map((name) => [name, path.join(accountHomePath, name)] as const),
    ];

    const root = yield* inspectEntry(input.homePath);
    if (root._tag === "Missing" && !input.live) {
      yield* makeDirectory(input.homePath);
    } else if (root._tag !== "Directory") {
      return yield* refuseHome;
    }

    for (const [name, target] of links) {
      const entry = path.join(input.homePath, name);
      const state = yield* inspectEntry(entry);
      if (state._tag === "Link" && state.target === target) continue;
      if (input.live || (state._tag !== "Link" && state._tag !== "Missing")) {
        return yield* refuseHome;
      }
      if (SHARED_STORE_ENTRIES.some((store) => store === name)) yield* makeDirectory(target);
      if (state._tag === "Link") yield* unlink(entry);
      yield* fileSystem.symlink(target, entry).pipe(Effect.mapError(fail("symlink", entry)));
    }

    const config = yield* inspectEntry(configPath);
    const current =
      config._tag === "File"
        ? yield* fileSystem
            .readFileString(configPath)
            .pipe(Effect.mapError(fail("inspect", configPath)))
        : undefined;
    if (current !== configText) {
      if (input.live || config._tag === "Directory" || config._tag === "Other") {
        return yield* refuseHome;
      }
      // Renamed into place, so a link or hard link never lets another file stand in for it.
      const staged = `${configPath}.${process.pid}.tmp`;
      yield* fileSystem
        .writeFileString(staged, configText)
        .pipe(Effect.mapError(fail("writeConfig", staged)));
      yield* fileSystem
        .rename(staged, configPath)
        .pipe(Effect.mapError(fail("writeConfig", configPath)));
    }
    return { homePath: input.homePath, configPath, configText, userConfig };
  },
);

interface ProfileOwners {
  readonly permit: Semaphore.Semaphore;
  live: number;
}
// One server process, one filesystem: owners are counted per physical profile home.
const profileOwners = new Map<string, ProfileOwners>();

/**
 * Prepares the profile home and holds it for the calling scope. The first owner prepares it;
 * later ones, while any is live, reuse it unchanged or are refused, so a running process never
 * has its config or links replaced underneath it.
 */
export const acquireCodexNoChangesHome = Effect.fn("CodexNoChangesProfile.acquireHome")(
  function* (input: { readonly layout: CodexHomeLayout; readonly homePath: string }) {
    const key = yield* codexPhysicalPath(input.homePath);
    let owners = profileOwners.get(key);
    if (owners === undefined) {
      owners = { permit: Semaphore.makeUnsafe(1), live: 0 };
      profileOwners.set(key, owners);
    }
    const held = owners;
    return yield* Effect.acquireRelease(
      held.permit.withPermit(
        materializeCodexNoChangesHome({ ...input, live: held.live > 0 }).pipe(
          Effect.tap(() => Effect.sync(() => void (held.live += 1))),
        ),
      ),
      () => Effect.sync(() => void (held.live -= 1)),
    );
  },
);

/**
 * The ordinary process keeps its thread index wherever `sqlite_home` or `CODEX_SQLITE_HOME`
 * points, or in its own home. This profile can only share the last, so anything else is refused.
 */
export const checkCodexOrdinaryStore = Effect.fn("CodexNoChangesProfile.checkOrdinaryStore")(
  function* (input: {
    readonly layout: CodexHomeLayout;
    readonly settingsHomePath: string;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const refuseStore = refuse("store");
    const accountHomePath = codexAccountHomePath(input.layout);
    const ordinaryHome = input.settingsHomePath || input.environment.CODEX_HOME?.trim();
    if (ordinaryHome && path.resolve(ordinaryHome) !== path.resolve(accountHomePath)) {
      return yield* refuseStore;
    }
    if (input.environment.CODEX_SQLITE_HOME?.trim()) return yield* refuseStore;
    const configText = yield* fileSystem
      .readFileString(path.join(accountHomePath, "config.toml"))
      .pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(refuseStore),
        }),
      );
    // Any mention, also in a profile or an escaped key: refusing a comment is the cheap mistake.
    const unescaped = configText.replace(
      /\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/gu,
      (_match, short: string | undefined, long: string | undefined) =>
        String.fromCodePoint(Number.parseInt(short ?? long ?? "0", 16)),
    );
    if (unescaped.includes("sqlite_home")) return yield* refuseStore;
  },
);

const refuse = (
  reason: ProviderAdapter.ProviderAdapterNoChangesRefusedError["reason"],
  cause?: unknown,
) =>
  new ProviderAdapter.ProviderAdapterNoChangesRefusedError({
    driver: ProviderDriverKind.make("codex"),
    reason,
    ...(cause === undefined ? {} : { cause }),
  });

/** JSON with object keys sorted, so two values compare by content. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    Predicate.isObject(nested) && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)))
      : nested,
  );

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  (Array.isArray(value)
    ? value.length === 0
    : Predicate.isObject(value) && Object.keys(value).length === 0);

/**
 * Whether this profile can use the instance's signed-in account. An API key needs no refresh; a
 * ChatGPT sign-in waits for proof that two processes can share its refresh and lock.
 */
export const noChangesAccountRefusal = (auth: ServerProvider["auth"]) =>
  auth.status !== "authenticated"
    ? ("account" as const)
    : auth.type === "apiKey"
      ? undefined
      : auth.type === "chatgpt"
        ? ("chatgpt-account" as const)
        : ("account" as const);

interface CanaryListener {
  readonly server: NodeNet.Server;
  readonly port: number;
  readonly connections: () => number;
}

const listenOnLoopback = Effect.callback<
  CanaryListener,
  ProviderAdapter.ProviderAdapterNoChangesRefusedError
>((resume) => {
  let connections = 0;
  const server = NodeNet.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  server.once("error", (cause) => resume(Effect.fail(refuse("sandbox", cause))));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (typeof address === "object" && address !== null) {
      resume(Effect.succeed({ server, port: address.port, connections: () => connections }));
    } else {
      server.close();
      resume(Effect.fail(refuse("sandbox")));
    }
  });
});

/** Runs no model: three commands under the sandbox policy every restricted turn sends. */
const sandboxCanary = Effect.fn("CodexNoChangesProfile.sandboxCanary")(function* (input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly home: CodexNoChangesHome;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exec = (command: ReadonlyArray<string>) =>
    input.client
      .request("command/exec", {
        command,
        cwd: input.home.homePath,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        timeoutMs: 10_000,
      })
      .pipe(Effect.mapError((cause) => refuse("sandbox", cause)));

  // The control: a command that fails here proves nothing about the two that must fail.
  const read = yield* exec(["/bin/cat", input.home.configPath]);
  if (read.exitCode !== 0 || read.stdout !== input.home.configText) return yield* refuse("sandbox");

  const probe = path.join(
    input.home.homePath,
    `canary-${process.pid}-${DateTime.toEpochMillis(yield* DateTime.now)}`,
  );
  const write = yield* exec(["/bin/sh", "-c", 'echo canary > "$0"', probe]);
  const written = yield* fileSystem.exists(probe).pipe(Effect.orElseSucceed(() => true));
  if (written) yield* fileSystem.remove(probe).pipe(Effect.ignore);
  if (write.exitCode === 0 || written) return yield* refuse("sandbox");

  const listener = yield* Effect.acquireRelease(listenOnLoopback, ({ server }) =>
    Effect.sync(() => server.close()),
  );
  const connect = yield* exec([
    "/bin/bash",
    "-c",
    'exec 3<>"/dev/tcp/127.0.0.1/$0"',
    String(listener.port),
  ]);
  if (connect.exitCode === 0 || listener.connections() > 0) return yield* refuse("sandbox");
}, Effect.scoped);

/**
 * Proves, before any thread starts, that this process runs T3 Code's profile and nothing more:
 * the selected account, the fixed config with no other layer adding to it, the features off, no
 * hooks, and a sandbox that refuses writes and network while it still reads.
 */
export const verifyCodexNoChangesProcess = Effect.fn("CodexNoChangesProfile.verify")(
  function* (input: {
    readonly client: CodexClient.CodexAppServerClient["Service"];
    readonly home: CodexNoChangesHome;
    readonly version: string | undefined;
    readonly cwd: string | null;
    readonly expectedAccount: ServerProvider["auth"];
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const { client, home, expectedAccount } = input;
    const ask = <A, E>(
      reason: ProviderAdapter.ProviderAdapterNoChangesRefusedError["reason"],
      effect: Effect.Effect<A, E>,
    ) => effect.pipe(Effect.mapError((cause) => refuse(reason, cause)));

    if (input.version !== CODEX_NO_CHANGES_VERIFIED_VERSION) return yield* refuse("version");

    const accountRefusal = noChangesAccountRefusal(expectedAccount);
    if (accountRefusal !== undefined) return yield* refuse(accountRefusal);
    const { account } = yield* ask("account", client.request("account/read", {}));
    if (
      account == null ||
      account.type !== expectedAccount.type ||
      (account.type === "chatgpt" && account.email !== (expectedAccount.email ?? null))
    ) {
      return yield* refuse("account");
    }

    const read = yield* ask("config", client.request("config/read", { includeLayers: true }));
    const configPaths = [
      home.configPath,
      yield* fileSystem.realPath(home.configPath).pipe(Effect.orElseSucceed(() => home.configPath)),
    ];
    const layers = read.layers ?? [];
    const userLayers = layers.filter(
      (layer) => layer.name.type === "user" && configPaths.includes(layer.name.file),
    );
    const userLayer = userLayers[0];
    if (
      userLayers.length !== 1 ||
      userLayer === undefined ||
      userLayer.disabledReason != null ||
      canonical(userLayer.config) !== canonical(home.userConfig)
    ) {
      return yield* refuse("config");
    }
    // System, managed and other layers may exist only empty: nothing may add to the profile.
    if (
      layers.some(
        (layer) => layer !== userLayer && layer.disabledReason == null && !isEmpty(layer.config),
      )
    ) {
      return yield* refuse("config");
    }
    const effective = read.config;
    if (
      effective.sandbox_mode !== "read-only" ||
      effective.approval_policy !== "never" ||
      !isEmpty(effective["mcp_servers"]) ||
      !isEmpty(effective["notify"]) ||
      !isEmpty(effective["projects"]) ||
      !(effective.model_provider == null || effective.model_provider === "openai")
    ) {
      return yield* refuse("config");
    }
    if (effective["sqlite_home"] !== home.userConfig["sqlite_home"]) return yield* refuse("store");

    const features = new Map<string, boolean>();
    let cursor: string | null | undefined;
    do {
      const page = yield* ask(
        "config",
        client.request("experimentalFeature/list", {
          limit: 500,
          ...(cursor == null ? {} : { cursor }),
        }),
      );
      for (const feature of page.data) features.set(feature.name, feature.enabled);
      cursor = page.nextCursor;
    } while (cursor != null);
    if (CODEX_NO_CHANGES_DISABLED_FEATURES.some((name) => features.get(name) !== false)) {
      return yield* refuse("config");
    }

    const hooks = yield* ask(
      "hooks",
      client.request("hooks/list", input.cwd === null ? {} : { cwds: [input.cwd] }),
    );
    if (hooks.data.some((entry) => entry.hooks.length > 0)) return yield* refuse("hooks");

    yield* sandboxCanary({ client, home });
  },
);
