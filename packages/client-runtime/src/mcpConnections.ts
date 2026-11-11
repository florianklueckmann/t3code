import {
  mcpConnectionDefinitionProblem,
  mcpConnectionProblemMessage,
  type BotId,
  type BotMcpGrants,
  type BotSetMcpGrantsInput,
  type BotSummary,
  type ExecutionEnvironmentPlatformOs,
  type McpConnectionCreateInput,
  type McpConnectionDefinition,
  type McpConnectionId,
  type McpConnectionStatus,
  type McpConnectionSummary,
  type McpConnectionTransport,
  type McpConnectionUpdateInput,
  type ProviderDriverKind,
  type ScheduledTask,
  type ServerProvider,
  type SettingsSecretValue,
} from "@t3tools/contracts";

/** What a create or edit form holds. Endpoint fields are fixed once a connection exists. */
export interface McpConnectionDraft {
  readonly label: string;
  readonly enabled: boolean;
  readonly transport: McpConnectionTransport["type"];
  readonly command: string;
  /** One argument per line. */
  readonly args: string;
  readonly url: string;
  readonly bindings: ReadonlyArray<{ readonly name: string; readonly value: SettingsSecretValue }>;
}

export const EMPTY_MCP_CONNECTION_DRAFT: McpConnectionDraft = {
  label: "",
  enabled: true,
  transport: "http",
  command: "",
  args: "",
  url: "",
  bindings: [],
};

/** A draft of a saved definition, as the redacted settings snapshot shows it. */
export function mcpConnectionDraft(definition: McpConnectionDefinition): McpConnectionDraft {
  const transport = definition.transport;
  const bindings = transport.type === "stdio" ? transport.env : transport.httpHeaders;
  return {
    label: definition.label,
    enabled: definition.enabled,
    transport: transport.type,
    command: transport.type === "stdio" ? transport.command : "",
    args: transport.type === "stdio" ? transport.args.join("\n") : "",
    url: transport.type === "http" ? transport.url : "",
    bindings: Object.entries(bindings).map(([name, value]) => ({ name, value })),
  };
}

function draftTransport(draft: McpConnectionDraft): McpConnectionTransport {
  const bindings = Object.fromEntries(
    draft.bindings.map(({ name, value }) => [name.trim(), value]),
  );
  return draft.transport === "stdio"
    ? {
        type: "stdio",
        command: draft.command.trim(),
        args: draft.args.split("\n").filter((argument) => argument.trim() !== ""),
        env: bindings,
      }
    : { type: "http", url: draft.url.trim(), httpHeaders: bindings };
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

export const MCP_CONNECTIONS_NOTICE =
  "A Bot uses the connections you grant it in its settings, and so does work it starts. Your own threads use none of them. This page checks that credentials resolve; it does not start or contact the servers.";

/** A catalog connection, or a granted one the catalog no longer has, as a Bot's settings list it. */
export interface BotMcpGrantRow {
  readonly id: McpConnectionId;
  readonly label: string;
  /** Null when the connection was removed. */
  readonly transport: McpConnectionSummary["transport"] | null;
  readonly granted: boolean;
  readonly status: McpConnectionStatusText;
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
}): BotMcpGrantsSection {
  const granted = new Set(input.grants.connectionIds);
  const listed = new Set(input.catalog.map((connection) => connection.id));
  const rows: ReadonlyArray<BotMcpGrantRow> = [
    ...input.catalog.map((connection) => ({
      id: connection.id,
      label: connection.label,
      transport: connection.transport,
      granted: granted.has(connection.id),
      status: connection.enabled
        ? mcpConnectionStatusText(connection.status)
        : {
            tone: "muted" as const,
            text: "Disabled. The Bot doesn't load it until you enable it.",
          },
    })),
    ...input.grants.connectionIds
      .filter((id) => !listed.has(id))
      .map((id) => ({
        id,
        label: "Removed connection",
        transport: null,
        granted: true,
        status: { tone: "muted" as const, text: "Removed. The Bot no longer loads it." },
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
    if (unenforceable === null && !ownServersOn) {
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
