import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { isSecretReference, SettingsSecretValue } from "./settingsSecretValue.ts";

/**
 * An environment-owned MCP connection: one account or configuration of one service. Ids are minted
 * once, never derived from the label, endpoint or provider, and never reused after removal.
 */
export const McpConnectionId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
).pipe(Schema.brand("McpConnectionId"));
export type McpConnectionId = typeof McpConnectionId.Type;

export const MCP_CONNECTION_LABEL_MAX_LENGTH = 80;
export const MCP_CONNECTIONS_MAX = 64;
const MAX_BINDINGS = 128;
const MAX_BINDING_NAME_LENGTH = 128;
const MAX_ARGUMENTS = 64;
const MAX_TEXT_LENGTH = 4096;
const MAX_URL_LENGTH = 2048;

export const McpConnectionLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MCP_CONNECTION_LABEL_MAX_LENGTH),
);

/** Binding name to the credential it holds or names. Env names are case-sensitive. */
export const McpConnectionBindings = Schema.Record(Schema.String, SettingsSecretValue);
export type McpConnectionBindings = typeof McpConnectionBindings.Type;

// Persisted shapes stay structural so a hand-edited entry cannot reset all settings; the server
// validates each definition with `mcpConnectionDefinitionProblem` and refuses an invalid one.
export const McpConnectionStdioTransport = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedString,
  args: Schema.Array(Schema.String),
  env: McpConnectionBindings,
});
export const McpConnectionHttpTransport = Schema.Struct({
  type: Schema.Literal("http"),
  url: TrimmedString,
  httpHeaders: McpConnectionBindings,
});
export const McpConnectionTransport = Schema.Union([
  McpConnectionStdioTransport,
  McpConnectionHttpTransport,
]);
export type McpConnectionTransport = typeof McpConnectionTransport.Type;

export const McpConnectionDefinition = Schema.Struct({
  label: TrimmedString,
  enabled: Schema.Boolean,
  /** Advances on every edit; endpoint, transport or account changes need a new id instead. */
  revision: NonNegativeInt,
  transport: McpConnectionTransport,
  authentication: Schema.Struct({ type: Schema.Literal("bindings") }),
});
export type McpConnectionDefinition = typeof McpConnectionDefinition.Type;

export const McpConnectionProblemReason = Schema.Literals([
  "label-invalid",
  "command-invalid",
  "too-many-arguments",
  "argument-invalid",
  "argument-secret",
  "url-invalid",
  "url-credentials",
  "too-many-bindings",
  "binding-name-invalid",
  "binding-name-duplicate",
  "binding-value-empty",
  "binding-value-invalid",
  "binding-unresolved",
]);
export type McpConnectionProblemReason = typeof McpConnectionProblemReason.Type;

/** Names a binding or argument position, never a value. */
export const McpConnectionProblem = Schema.Struct({
  reason: McpConnectionProblemReason,
  binding: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_BINDING_NAME_LENGTH))),
  argument: Schema.optionalKey(NonNegativeInt),
});
export type McpConnectionProblem = typeof McpConnectionProblem.Type;

export function mcpConnectionProblemMessage(problem: McpConnectionProblem): string {
  const binding = problem.binding === undefined ? "A binding" : problem.binding;
  const argument =
    problem.argument === undefined ? "An argument" : `Argument ${problem.argument + 1}`;
  switch (problem.reason) {
    case "label-invalid":
      return `Enter a name of at most ${MCP_CONNECTION_LABEL_MAX_LENGTH} characters.`;
    case "command-invalid":
      return "Enter a single-line command.";
    case "too-many-arguments":
      return `Use at most ${MAX_ARGUMENTS} arguments.`;
    case "argument-invalid":
      return `${argument} must be a single line.`;
    case "argument-secret":
      return `${argument} looks like a credential. Pass credentials as environment bindings instead.`;
    case "url-invalid":
      return "Enter an http:// or https:// URL without a #fragment.";
    case "url-credentials":
      return "Remove credentials from the URL. Pass them as header bindings instead.";
    case "too-many-bindings":
      return `Use at most ${MAX_BINDINGS} bindings.`;
    case "binding-name-invalid":
      return `${binding} is not a valid name.`;
    case "binding-name-duplicate":
      return `${binding} is set more than once. Header names ignore case.`;
    case "binding-value-empty":
      return `${binding} has no value. Enter one or pick a secret.`;
    case "binding-value-invalid":
      return `${binding} contains characters it cannot send, such as a line break.`;
    case "binding-unresolved":
      return `${binding} could not be read from its secret provider.`;
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LINE_BREAK = /[\r\n\0]/;
const SECRET_WORD =
  "token|secret|password|passwd|api[-_]?key|apikey|credentials?|authorization|bearer|private[-_]?key|access[-_]?key|client[-_]?secret";
const SECRET_FLAG = new RegExp(`^-{1,2}(?:[\\w.-]*[-_.])?(?:${SECRET_WORD})(?:=|$)`, "i");
const SECRET_ASSIGNMENT = new RegExp(`^[\\w.-]*(?:${SECRET_WORD})=\\S`, "i");
const SECRET_SCHEME = /^(?:bearer|basic)\s+\S/i;
const URL_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]*@/i;
const SECRET_QUERY =
  /(?:token|secret|password|passwd|api[-_]?key|apikey|access[-_]?key|signature|sig|auth|code)$/i;

/** Why a resolved binding value cannot be delivered, or undefined when it can. */
export function mcpConnectionBindingValueProblem(
  slot: "env" | "header",
  binding: string,
  value: string,
): McpConnectionProblem | undefined {
  if (value.trim().length === 0) return { reason: "binding-value-empty", binding };
  if (slot === "header" ? LINE_BREAK.test(value) : value.includes("\0")) {
    return { reason: "binding-value-invalid", binding };
  }
  return undefined;
}

function bindingsProblem(
  slot: "env" | "header",
  bindings: McpConnectionBindings,
): McpConnectionProblem | undefined {
  const entries = Object.entries(bindings);
  if (entries.length > MAX_BINDINGS) return { reason: "too-many-bindings" };
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    const binding = name.slice(0, MAX_BINDING_NAME_LENGTH);
    if (
      name.length > MAX_BINDING_NAME_LENGTH ||
      !(slot === "env" ? ENV_NAME : HEADER_NAME).test(name)
    ) {
      return { reason: "binding-name-invalid", binding };
    }
    const identity = slot === "header" ? name.toLowerCase() : name;
    if (seen.has(identity)) return { reason: "binding-name-duplicate", binding };
    seen.add(identity);
    if (!isSecretReference(value)) {
      const problem = mcpConnectionBindingValueProblem(slot, name, value);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
}

function urlProblem(raw: string): McpConnectionProblem | undefined {
  if (raw.length > MAX_URL_LENGTH || LINE_BREAK.test(raw)) return { reason: "url-invalid" };
  if (URL_USERINFO.test(raw)) return { reason: "url-credentials" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: "url-invalid" };
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hash !== "") {
    return { reason: "url-invalid" };
  }
  if (url.username !== "" || url.password !== "") return { reason: "url-credentials" };
  if (hasCredentialQuery(raw)) return { reason: "url-credentials" };
  return undefined;
}

function hasCredentialQuery(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return [...url.searchParams.keys()].some((name) => SECRET_QUERY.test(name));
}

function looksLikeCredential(text: string): boolean {
  return (
    SECRET_FLAG.test(text) ||
    SECRET_ASSIGNMENT.test(text) ||
    SECRET_SCHEME.test(text) ||
    URL_USERINFO.test(text) ||
    hasCredentialQuery(text) ||
    hasCredentialQuery(text.slice(text.indexOf("=") + 1))
  );
}

/**
 * The first reason a definition cannot be saved or used, or undefined. Credentials belong only in
 * bindings: arguments, commands and URLs that look like they carry one are refused.
 */
export function mcpConnectionDefinitionProblem(definition: {
  readonly label: string;
  readonly transport: McpConnectionTransport;
}): McpConnectionProblem | undefined {
  const label = definition.label.trim();
  if (label.length === 0 || label.length > MCP_CONNECTION_LABEL_MAX_LENGTH) {
    return { reason: "label-invalid" };
  }
  const transport = definition.transport;
  switch (transport.type) {
    case "stdio": {
      const command = transport.command;
      if (command.length === 0 || command.length > MAX_TEXT_LENGTH || LINE_BREAK.test(command)) {
        return { reason: "command-invalid" };
      }
      if (looksLikeCredential(command)) return { reason: "argument-secret" };
      if (transport.args.length > MAX_ARGUMENTS) return { reason: "too-many-arguments" };
      for (const [argument, value] of transport.args.entries()) {
        if (value.length > MAX_TEXT_LENGTH || LINE_BREAK.test(value)) {
          return { reason: "argument-invalid", argument };
        }
        if (looksLikeCredential(value)) return { reason: "argument-secret", argument };
      }
      return bindingsProblem("env", transport.env);
    }
    case "http":
      return urlProblem(transport.url) ?? bindingsProblem("header", transport.httpHeaders);
  }
}

/** The bindings a transport delivers, with the slot each one uses. */
export function mcpConnectionBindings(transport: McpConnectionTransport): {
  readonly slot: "env" | "header";
  readonly bindings: McpConnectionBindings;
} {
  return transport.type === "stdio"
    ? { slot: "env", bindings: transport.env }
    : { slot: "header", bindings: transport.httpHeaders };
}

/**
 * Binding resolution and definition validation only. `ready` is not reachability: nothing here
 * starts the server or calls it. A Bot's thread resolves its granted connections again at load.
 */
export const McpConnectionStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("ready") }),
  /** Some bindings name secrets that have not been read since the server started or the edit. */
  Schema.Struct({ state: Schema.Literal("unchecked") }),
  Schema.Struct({ state: Schema.Literal("blocked"), problem: McpConnectionProblem }),
]);
export type McpConnectionStatus = typeof McpConnectionStatus.Type;

export const McpConnectionSummary = Schema.Struct({
  id: McpConnectionId,
  label: Schema.String,
  enabled: Schema.Boolean,
  revision: NonNegativeInt,
  transport: Schema.Literals(["stdio", "http"]),
  status: McpConnectionStatus,
});
export type McpConnectionSummary = typeof McpConnectionSummary.Type;

export const McpConnectionListInput = Schema.Struct({});
export const McpConnectionListResult = Schema.Struct({
  connections: Schema.Array(McpConnectionSummary),
});
export type McpConnectionListResult = typeof McpConnectionListResult.Type;

/** The client mints `connectionId`, so a retried create cannot add a second definition. */
export const McpConnectionCreateInput = Schema.Struct({
  connectionId: McpConnectionId,
  label: McpConnectionLabel,
  enabled: Schema.Boolean,
  transport: McpConnectionTransport,
});
export type McpConnectionCreateInput = typeof McpConnectionCreateInput.Type;

/** Edits that keep the connection's identity. `bindings` replaces the transport's binding map. */
export const McpConnectionUpdateInput = Schema.Struct({
  connectionId: McpConnectionId,
  expectedRevision: NonNegativeInt,
  label: Schema.optionalKey(McpConnectionLabel),
  enabled: Schema.optionalKey(Schema.Boolean),
  bindings: Schema.optionalKey(McpConnectionBindings),
});
export type McpConnectionUpdateInput = typeof McpConnectionUpdateInput.Type;

export const McpConnectionRemoveInput = Schema.Struct({
  connectionId: McpConnectionId,
  expectedRevision: NonNegativeInt,
});
export type McpConnectionRemoveInput = typeof McpConnectionRemoveInput.Type;
export const McpConnectionRemoveResult = Schema.Struct({ connectionId: McpConnectionId });

export const McpConnectionRefreshInput = Schema.Struct({
  connectionIds: Schema.Array(McpConnectionId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MCP_CONNECTIONS_MAX),
  ),
});
export type McpConnectionRefreshInput = typeof McpConnectionRefreshInput.Type;

export const McpConnectionErrorReason = Schema.Literals([
  "not-found",
  "revision-conflict",
  "id-unavailable",
  "limit-reached",
  "invalid-definition",
  "settings-unavailable",
]);

export class McpConnectionError extends Schema.TaggedError<McpConnectionError>()(
  "McpConnectionError",
  {
    reason: McpConnectionErrorReason,
    connectionId: Schema.optional(McpConnectionId),
    currentRevision: Schema.optional(NonNegativeInt),
    problem: Schema.optional(McpConnectionProblem),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return "This MCP connection no longer exists.";
      case "revision-conflict":
        return "This MCP connection changed since you opened it. Review the latest version and try again.";
      case "id-unavailable":
        return "This MCP connection id is already used or was removed. Start a new connection.";
      case "limit-reached":
        return `An environment can have at most ${MCP_CONNECTIONS_MAX} MCP connections.`;
      case "invalid-definition":
        return this.problem === undefined
          ? "This MCP connection is not valid."
          : mcpConnectionProblemMessage(this.problem);
      case "settings-unavailable":
        return "Could not save MCP connections. Try again.";
    }
  }
}
