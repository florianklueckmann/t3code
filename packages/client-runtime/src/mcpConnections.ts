import {
  mcpConnectionDefinitionProblem,
  mcpConnectionProblemMessage,
  type McpConnectionCreateInput,
  type McpConnectionDefinition,
  type McpConnectionId,
  type McpConnectionStatus,
  type McpConnectionTransport,
  type McpConnectionUpdateInput,
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

/** How a status reads in Settings. It never claims the server is reachable or in use. */
export function mcpConnectionStatusText(status: McpConnectionStatus | undefined): {
  readonly tone: "ok" | "warning" | "error" | "muted";
  readonly text: string;
} {
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

export const MCP_CONNECTIONS_FOUNDATION_NOTICE =
  "Bots and agents cannot use these connections yet. This page stores definitions and checks that their credentials resolve; it does not start or contact the servers.";
