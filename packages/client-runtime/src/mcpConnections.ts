import {
  mcpConnectionDefinitionProblem,
  mcpConnectionOAuthFailureMessage,
  mcpConnectionProblemMessage,
  type BotId,
  type BotMcpGrants,
  type BotSetMcpGrantsInput,
  type BotSummary,
  type ExecutionEnvironmentPlatformOs,
  type McpConnectionCreateInput,
  type McpConnectionDefinition,
  type McpConnectionId,
  type McpConnectionOAuthState,
  type McpConnectionStatus,
  type McpConnectionSummary,
  type McpConnectionTransport,
  type McpConnectionUpdateInput,
  type ProviderDriverKind,
  type ScheduledTask,
  type ServerProvider,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as DateTime from "effect/DateTime";

/** What a create or edit form holds. Endpoint fields are fixed once a connection exists. */
export interface McpConnectionDraft {
  readonly label: string;
  readonly enabled: boolean;
  readonly transport: McpConnectionTransport["type"];
  readonly command: string;
  /** One argument per line. */
  readonly args: string;
  readonly url: string;
  /** HTTP only: sign in with OAuth, or send the header bindings as they are. */
  readonly auth: "oauth" | "headers";
  /** A preregistered OAuth app; an empty client ID lets T3 Code register itself. */
  readonly oauthClientId: string;
  /** Empty for a public client. */
  readonly oauthClientSecret: SettingsSecretValue;
  readonly bindings: ReadonlyArray<{ readonly name: string; readonly value: SettingsSecretValue }>;
}

/** New HTTP connections sign in with OAuth wherever the server supports it. */
export function emptyMcpConnectionDraft(oauthSupported: boolean): McpConnectionDraft {
  return {
    label: "",
    enabled: true,
    transport: "http",
    command: "",
    args: "",
    url: "",
    auth: oauthSupported ? "oauth" : "headers",
    oauthClientId: "",
    oauthClientSecret: "",
    bindings: [],
  };
}

/** A draft of a saved definition, as the redacted settings snapshot shows it. */
export function mcpConnectionDraft(definition: McpConnectionDefinition): McpConnectionDraft {
  const transport = definition.transport;
  const bindings = transport.type === "stdio" ? transport.env : transport.httpHeaders;
  const oauth = transport.type === "http" ? transport.oauth : undefined;
  return {
    label: definition.label,
    enabled: definition.enabled,
    transport: transport.type,
    command: transport.type === "stdio" ? transport.command : "",
    args: transport.type === "stdio" ? transport.args.join("\n") : "",
    url: transport.type === "http" ? transport.url : "",
    auth: oauth === undefined ? "headers" : "oauth",
    oauthClientId: oauth?.client?.id ?? "",
    oauthClientSecret: oauth?.client?.secret ?? "",
    bindings: Object.entries(bindings).map(([name, value]) => ({ name, value })),
  };
}

function draftTransport(draft: McpConnectionDraft): McpConnectionTransport {
  const bindings = Object.fromEntries(
    draft.bindings.map(({ name, value }) => [name.trim(), value]),
  );
  if (draft.transport === "stdio") {
    return {
      type: "stdio",
      command: draft.command.trim(),
      args: draft.args.split("\n").filter((argument) => argument.trim() !== ""),
      env: bindings,
    };
  }
  const transport = { type: "http" as const, url: draft.url.trim(), httpHeaders: bindings };
  if (draft.auth === "headers") return transport;
  const clientId = draft.oauthClientId.trim();
  const secret = draft.oauthClientSecret;
  return {
    ...transport,
    oauth: {
      scopes: [],
      ...(clientId === ""
        ? {}
        : { client: { id: clientId, ...(secret === "" ? {} : { secret }) } }),
    },
  };
}

export type McpConnectionSavePlan =
  | { readonly kind: "create"; readonly input: McpConnectionCreateInput }
  | { readonly kind: "update"; readonly input: McpConnectionUpdateInput }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * The request a form submits. A new connection carries the id the form minted when it opened,
 * so resubmitting after a lost response finds the same connection instead of adding another.
 */
export function planMcpConnectionSave(
  draft: McpConnectionDraft,
  target:
    | { readonly kind: "create"; readonly connectionId: McpConnectionId }
    | {
        readonly kind: "update";
        readonly connectionId: McpConnectionId;
        readonly saved: McpConnectionDefinition;
      },
): McpConnectionSavePlan {
  // Exact duplicates would collapse into one record key, so they are caught before building it.
  const names = new Set<string>();
  for (const { name } of draft.bindings) {
    const key = draft.transport === "http" ? name.trim().toLowerCase() : name.trim();
    if (names.has(key)) {
      return {
        kind: "invalid",
        message: mcpConnectionProblemMessage({ reason: "binding-name-duplicate", binding: name }),
      };
    }
    names.add(key);
  }
  if (
    target.kind === "create" &&
    draft.transport === "http" &&
    draft.auth === "oauth" &&
    draft.oauthClientId.trim() === "" &&
    draft.oauthClientSecret !== ""
  ) {
    return { kind: "invalid", message: "Enter your OAuth app's client ID, or clear its secret." };
  }
  const transport =
    target.kind === "create"
      ? draftTransport(draft)
      : draftTransport({
          ...mcpConnectionDraft(target.saved),
          bindings: draft.bindings,
        });
  const label = draft.label.trim();
  const problem = mcpConnectionDefinitionProblem({ label, transport });
  if (problem !== undefined)
    return { kind: "invalid", message: mcpConnectionProblemMessage(problem) };
  if (target.kind === "create") {
    return {
      kind: "create",
      input: { connectionId: target.connectionId, label, enabled: draft.enabled, transport },
    };
  }
  return {
    kind: "update",
    input: {
      connectionId: target.connectionId,
      expectedRevision: target.saved.revision,
      label,
      enabled: draft.enabled,
      bindings: transport.type === "stdio" ? transport.env : transport.httpHeaders,
    },
  };
}

export interface McpConnectionStatusText {
  readonly tone: "ok" | "warning" | "error" | "muted";
  readonly text: string;
}

/** How a status reads in Settings. It never claims the server is reachable or in use. */
export function mcpConnectionStatusText(
  status: McpConnectionStatus | undefined,
): McpConnectionStatusText {
  if (status === undefined) return { tone: "muted", text: "Checking…" };
  switch (status.state) {
    case "ready":
      return { tone: "ok", text: "Credentials resolved" };
    case "unchecked":
      return { tone: "warning", text: "Secrets not read yet. Refresh to check them." };
    case "blocked":
      return { tone: "error", text: mcpConnectionProblemMessage(status.problem) };
  }
}

/**
 * The loopback origin a sign-in returns to when the browser cannot reach the environment. Fixed,
 * so a preregistered OAuth app can list it, and the desktop listener and paste fallback share it.
 */
export const MCP_CONNECTION_OAUTH_LOOPBACK_ORIGIN = "http://127.0.0.1:1457";

/** Where the browser lands after sign-in, and how the response then reaches the environment. */
export type McpConnectionOAuthCallback =
  /** The browser opens the environment's own callback route: same machine, or an https origin. */
  | { readonly mode: "environment"; readonly redirectOrigin: string }
  /** This desktop app listens on the loopback origin and forwards the response. */
  | { readonly mode: "listener"; readonly redirectOrigin: string }
  /** The browser cannot open the loopback page; the user pastes its address back. */
  | { readonly mode: "paste"; readonly redirectOrigin: string };

/**
 * `httpBaseUrl` is the address this client uses for the environment. Authorization servers accept
 * only https or loopback http redirects, so a plain-http remote needs the loopback origin.
 */
export function mcpConnectionOAuthCallback(input: {
  readonly httpBaseUrl: string | null;
  readonly canListenOnLoopback: boolean;
}): McpConnectionOAuthCallback {
  let url: URL | null = null;
  try {
    url = input.httpBaseUrl === null ? null : new URL(input.httpBaseUrl);
  } catch {
    url = null;
  }
  if (
    url !== null &&
    (url.protocol === "https:" || (url.protocol === "http:" && isLocalLoopbackHost(url.hostname)))
  ) {
    return { mode: "environment", redirectOrigin: url.origin };
  }
  return {
    mode: input.canListenOnLoopback ? "listener" : "paste",
    redirectOrigin: MCP_CONNECTION_OAUTH_LOOPBACK_ORIGIN,
  };
}

export interface McpConnectionOAuthView {
  readonly tone: McpConnectionStatusText["tone"];
  readonly text: string;
  /** The last sign-in's failure, as a fixed sentence. */
  readonly failure: string | null;
  /** The sign-in under way, which Cancel ends. */
  readonly pendingFlowId: string | null;
  /** The button that starts a sign-in; null while one runs or the account is connected. */
  readonly signIn: "Connect" | "Reconnect" | "Try again" | null;
  readonly connected: boolean;
}

const SIGNED_OUT_REASON = {
  never: "Not connected.",
  disconnected: "Signed out. You disconnected it.",
  expired: "Signed out. The sign-in expired.",
  revoked: "Signed out. The service ended access.",
} as const;

/**
 * How an OAuth connection reads and what it offers. `audience` is where it shows: a Bot's settings
 * say what a signed-out account means for that Bot's runs, which go on without it.
 */
export function mcpConnectionOAuthView(
  state: McpConnectionOAuthState,
  now: number,
  audience: "catalog" | "bot",
): McpConnectionOAuthView {
  const signIn = state.signIn;
  const pending =
    signIn?.state === "pending" && Date.parse(signIn.expiresAt) > now ? signIn.flowId : null;
  const failure =
    signIn === undefined || pending !== null
      ? null
      : mcpConnectionOAuthFailureMessage(
          signIn.state === "failed" ? signIn.reason : "sign-in-ended",
        );
  const credential = state.credential;
  const connected = credential.state === "connected";
  const base = { failure, pendingFlowId: pending, connected };
  if (pending !== null) {
    return { ...base, tone: "muted", text: "Waiting for sign-in in the browser…", signIn: null };
  }
  if (credential.state === "connected") {
    return {
      ...base,
      tone: "ok",
      text: `Connected since ${DateTime.formatLocal(DateTime.makeUnsafe(credential.connectedAt), { dateStyle: "medium", locale: "en-US" })}`,
      signIn: null,
    };
  }
  const never = credential.reason === "never";
  return {
    ...base,
    tone: "warning",
    text:
      audience === "bot"
        ? `${never ? "Not connected." : "Signed out."} This Bot runs without it until you ${never ? "connect" : "reconnect"} it.`
        : SIGNED_OUT_REASON[credential.reason],
    signIn: failure !== null ? "Try again" : never ? "Connect" : "Reconnect",
  };
}

export const MCP_CONNECTIONS_NOTICE =
  "A Bot uses the connections you grant it in its settings, and so does work it starts. Your own threads use none of them. Refresh checks that credentials resolve; it does not start or contact the servers.";

/** A catalog connection, or a granted one the catalog no longer has, as a Bot's settings list it. */
export interface BotMcpGrantRow {
  readonly id: McpConnectionId;
  readonly label: string;
  /** Null when the connection was removed. */
  readonly transport: McpConnectionSummary["transport"] | null;
  readonly granted: boolean;
  readonly status: McpConnectionStatusText;
  /** An enabled OAuth connection's sign-in state, which the row can reconnect. */
  readonly oauth: McpConnectionOAuthState | null;
}

export interface BotMcpGrantsNote {
  readonly tone: "warning" | "muted";
  readonly text: string;
}

/** The switch that adds the user's own Codex MCP servers to a Bot's connections. */
export interface BotOwnMcpServersSwitch {
  readonly label: string;
  readonly description: string;
  readonly on: boolean;
}

export interface BotMcpGrantsSection {
  readonly rows: ReadonlyArray<BotMcpGrantRow>;
  /** Null on servers without the switch. */
  readonly ownServers: BotOwnMcpServersSwitch | null;
  readonly notes: ReadonlyArray<BotMcpGrantsNote>;
  readonly editable: boolean;
}

/** Each enabled Codex provider's own MCP servers, by name; null while none has reported them. */
export function codexMcpServerNames(
  providers: ReadonlyArray<Pick<ServerProvider, "driver" | "enabled" | "mcpServerNames">>,
): ReadonlyArray<string> | null {
  const reported = providers.filter(
    (provider) =>
      provider.driver === "codex" && provider.enabled && provider.mcpServerNames !== undefined,
  );
  if (reported.length === 0) return null;
  return [...new Set(reported.flatMap((provider) => provider.mcpServerNames ?? []))].sort();
}

function ownMcpServersDescription(names: ReadonlyArray<string> | null): string {
  if (names === null) return "Also loads the MCP servers in your Codex config.";
  if (names.length === 0) return "Your Codex config has no MCP servers.";
  return `Also loads ${listNames(names)} from your Codex config.`;
}

/**
 * The "MCP connections" section of a Bot's settings. `providerDriver` is the driver of the Bot's
 * saved model instance, undefined when that instance is gone. Where grants cannot be enforced, a
 * Bot without grants keeps the provider's own MCP setup and a Bot with grants is refused.
 */
export function botMcpGrantsSection(input: {
  readonly botId: BotId;
  readonly grants: BotMcpGrants;
  /** From `codexMcpServerNames`. */
  readonly codexMcpServerNames: ReadonlyArray<string> | null;
  readonly catalog: ReadonlyArray<McpConnectionSummary>;
  readonly providerDriver: ProviderDriverKind | undefined;
  readonly platformOs: ExecutionEnvironmentPlatformOs;
  readonly environmentLabel: string;
  /** Null when the environment has no routines. */
  readonly routines: ReadonlyArray<ScheduledTask> | null;
  readonly canChange: boolean;
  readonly archived: boolean;
  readonly now: number;
}): BotMcpGrantsSection {
  const granted = new Set(input.grants.connectionIds);
  const listed = new Set(input.catalog.map((connection) => connection.id));
  const rows: ReadonlyArray<BotMcpGrantRow> = [
    ...input.catalog.map((connection) => {
      const oauth = connection.enabled ? (connection.oauth ?? null) : null;
      const view = oauth === null ? null : mcpConnectionOAuthView(oauth, input.now, "bot");
      return {
        id: connection.id,
        label: connection.label,
        transport: connection.transport,
        granted: granted.has(connection.id),
        status: !connection.enabled
          ? {
              tone: "muted" as const,
              text: "Disabled. The Bot doesn't load it until you enable it.",
            }
          : view !== null
            ? { tone: view.tone, text: view.text }
            : mcpConnectionStatusText(connection.status),
        oauth,
      };
    }),
    ...input.grants.connectionIds
      .filter((id) => !listed.has(id))
      .map((id) => ({
        id,
        label: "Removed connection",
        transport: null,
        granted: true,
        status: { tone: "muted" as const, text: "Removed. The Bot no longer loads it." },
        oauth: null,
      })),
  ];
  const usable = rows.some((row) => row.granted && row.transport !== null);
  const unenforceable =
    input.providerDriver !== "codex"
      ? "This Bot's model is not on a Codex provider, so without connections it uses that provider's own MCP setup."
      : input.platformOs !== "darwin"
        ? `On ${input.environmentLabel}, this Bot without connections uses Codex's own MCP setup.`
        : null;
  const notes: Array<BotMcpGrantsNote> = [];
  if (unenforceable !== null) {
    notes.push({
      tone: "warning",
      text: `MCP connections apply only to Codex on macOS. ${unenforceable} A Bot with connections does not run there.`,
    });
  }
  if (input.catalog.length === 0) {
    notes.push({ tone: "muted", text: "No connections yet. Add one to grant it to this Bot." });
  }
  const ownServersOn = input.grants.ownCodexMcpServers === true;
  if (!usable) {
    if (unenforceable === null && !ownServersOn && input.catalog.length > 0) {
      notes.push({ tone: "muted", text: "This Bot has no MCP connections." });
    }
  } else if (
    input.routines?.some(
      (task) => task.bot?.botId === input.botId && task.bot.allowChanges !== true,
    )
  ) {
    notes.push({
      tone: "muted",
      text: "No changes routines use only the tools a connection marks as read-only. The connection's server sets that mark, so a tool marked read-only can still change things.",
    });
  }
  if (!input.canChange) {
    notes.push({
      tone: "muted",
      text: "Changing a Bot's MCP connections needs permission to change settings on this environment.",
    });
  }
  notes.push({ tone: "muted", text: "Changes apply from the Bot's next turn." });
  return {
    rows,
    ownServers:
      input.grants.ownCodexMcpServers === undefined
        ? null
        : {
            label: "Use my own Codex MCP servers",
            description: ownMcpServersDescription(input.codexMcpServerNames),
            on: ownServersOn,
          },
    notes,
    editable: input.canChange && !input.archived,
  };
}

/**
 * The whole set to save after one change, guarded by the revision the change was made on. Granted
 * ids the catalog no longer has drop out, since the server refuses them. A connection granted as
 * soon as it was added stays, though this client's catalog may not list it yet.
 */
export function botMcpGrantsChange(
  botId: BotId,
  grants: BotMcpGrants,
  catalog: ReadonlyArray<McpConnectionSummary>,
  change:
    | { readonly connectionId: McpConnectionId; readonly granted: boolean }
    | { readonly ownCodexMcpServers: boolean },
): BotSetMcpGrantsInput {
  const next = new Set(grants.connectionIds);
  if ("connectionId" in change) {
    if (change.granted) next.add(change.connectionId);
    else next.delete(change.connectionId);
  }
  const added =
    "connectionId" in change &&
    change.granted &&
    !catalog.some((connection) => connection.id === change.connectionId)
      ? [change.connectionId]
      : [];
  return {
    botId,
    expectedRevision: grants.revision,
    connectionIds: [
      ...catalog.flatMap((connection) => (next.has(connection.id) ? [connection.id] : [])),
      ...added,
    ],
    ...("ownCodexMcpServers" in change ? { ownCodexMcpServers: change.ownCodexMcpServers } : {}),
  };
}

/**
 * The grant set to show and save on: the live one, or the set the last save returned while the
 * live list has not caught up to it yet.
 */
export function latestBotMcpGrants(
  live: BotMcpGrants,
  acknowledged: BotMcpGrants | null,
): BotMcpGrants {
  return acknowledged !== null && acknowledged.revision > live.revision ? acknowledged : live;
}

/** Which Bots each connection is granted to, as far as this client knows. */
export type McpConnectionUsage =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly error: string }
  | {
      readonly state: "known";
      readonly users: ReadonlyMap<McpConnectionId, ReadonlyArray<string>>;
    };

/** Without Bots no connection has users; a server without grants reports none. */
export function mcpConnectionUsage(input: {
  readonly botsSupported: boolean;
  readonly bots: ReadonlyArray<BotSummary> | null;
  readonly error: string | null;
}): McpConnectionUsage {
  const users = new Map<McpConnectionId, Array<string>>();
  if (!input.botsSupported) return { state: "known", users };
  if (input.bots === null) {
    return input.error === null ? { state: "loading" } : { state: "failed", error: input.error };
  }
  for (const bot of [...input.bots].sort((left, right) => left.name.localeCompare(right.name))) {
    for (const id of bot.mcpGrants?.connectionIds ?? []) {
      users.set(id, [...(users.get(id) ?? []), bot.name]);
    }
  }
  return { state: "known", users };
}

function listNames(names: ReadonlyArray<string>): string {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function mcpConnectionUsedByText(
  usage: McpConnectionUsage,
  connectionId: McpConnectionId,
): string | null {
  const names = usage.state === "known" ? usage.users.get(connectionId) : undefined;
  return names === undefined ? null : `Used by ${listNames(names)}`;
}

export function mcpConnectionDisconnectMessage(
  usage: McpConnectionUsage,
  connectionId: McpConnectionId,
): string {
  const names = usage.state === "known" ? usage.users.get(connectionId) : undefined;
  const runs =
    names === undefined
      ? "Bots granted it run"
      : `${listNames(names)} ${names.length === 1 ? "runs" : "run"}`;
  return `${runs} without this account until you reconnect it. T3 Code also asks the service to end the sign-in.`;
}

/** Null until the client knows which Bots lose the connection, so removal cannot be confirmed. */
export function mcpConnectionRemovalMessage(
  usage: McpConnectionUsage,
  connectionId: McpConnectionId,
): string | null {
  if (usage.state !== "known") return null;
  const base =
    "Its saved credentials are deleted from this environment. Secrets read from a secret provider stay there. To use this account again, add a new connection.";
  const names = usage.users.get(connectionId);
  if (names === undefined) return base;
  return `${listNames(names)} ${names.length === 1 ? "loses" : "lose"} this connection. ${base}`;
}
