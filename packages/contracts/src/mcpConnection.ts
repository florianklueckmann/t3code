import * as Schema from "effect/Schema";

import {
  ForwardCompatibleOptional,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
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
const MAX_OAUTH_SCOPES = 32;

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
/** An OAuth app the user registered with the service, for services without automatic registration. */
export const McpConnectionOAuthClient = Schema.Struct({
  id: TrimmedString,
  /** Absent for a public client. */
  secret: Schema.optionalKey(SettingsSecretValue),
});
export type McpConnectionOAuthClient = typeof McpConnectionOAuthClient.Type;

export const McpConnectionOAuth = Schema.Struct({
  /** Asked for at sign-in. Empty asks for what the service advertises. */
  scopes: Schema.Array(Schema.String),
  /** Absent: T3 Code registers itself with the service at each sign-in. */
  client: Schema.optionalKey(McpConnectionOAuthClient),
});
export type McpConnectionOAuth = typeof McpConnectionOAuth.Type;

export const McpConnectionHttpTransport = Schema.Struct({
  type: Schema.Literal("http"),
  url: TrimmedString,
  httpHeaders: McpConnectionBindings,
  /**
   * Present: T3 Code signs in with OAuth and sends the access token. Fixed at create, so another
   * account is another connection. Older servers ignore the key.
   */
  oauth: Schema.optionalKey(McpConnectionOAuth),
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
  "oauth-authorization-binding",
  "oauth-scope-invalid",
  "oauth-client-invalid",
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
    case "oauth-authorization-binding":
      return "Remove the Authorization header. OAuth sign-in sends it.";
    case "oauth-scope-invalid":
      return `Enter at most ${MAX_OAUTH_SCOPES} scopes, each a single word.`;
    case "oauth-client-invalid":
      return "Enter the client ID and client secret as single lines.";
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

const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

function oauthProblem(
  headers: McpConnectionBindings,
  { scopes, client }: McpConnectionOAuth,
): McpConnectionProblem | undefined {
  const authorization = Object.keys(headers).find((name) => name.toLowerCase() === "authorization");
  if (authorization !== undefined) {
    return { reason: "oauth-authorization-binding", binding: authorization };
  }
  if (scopes.length > MAX_OAUTH_SCOPES || !scopes.every((scope) => SCOPE.test(scope))) {
    return { reason: "oauth-scope-invalid" };
  }
  if (client === undefined) return undefined;
  const secret = client.secret;
  if (
    client.id.length === 0 ||
    client.id.length > MAX_TEXT_LENGTH ||
    LINE_BREAK.test(client.id) ||
    (typeof secret === "string" && (secret.length === 0 || LINE_BREAK.test(secret)))
  ) {
    return { reason: "oauth-client-invalid" };
  }
  return undefined;
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
      return (
        urlProblem(transport.url) ??
        bindingsProblem("header", transport.httpHeaders) ??
        (transport.oauth === undefined
          ? undefined
          : oauthProblem(transport.httpHeaders, transport.oauth))
      );
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

/** The browser path of an OAuth sign-in's redirect URI, on whichever origin the client uses. */
export const MCP_CONNECTION_OAUTH_CALLBACK_PATH = "/oauth/mcp-connections/callback";

export const McpConnectionOAuthFailure = Schema.Literals([
  "not-found",
  "not-oauth",
  "redirect-invalid",
  "insecure",
  "discovery",
  "resource-mismatch",
  "registration-unsupported",
  "registration-failed",
  "sign-in-ended",
  "callback-invalid",
  "declined",
  "exchange-failed",
  "unavailable",
]);
export type McpConnectionOAuthFailure = typeof McpConnectionOAuthFailure.Type;

export function mcpConnectionOAuthFailureMessage(reason: McpConnectionOAuthFailure): string {
  switch (reason) {
    case "not-found":
      return "This MCP connection no longer exists.";
    case "not-oauth":
      return "This MCP connection does not sign in with OAuth.";
    case "redirect-invalid":
      return "Sign-in needs an https address for this environment, or this computer's own.";
    case "insecure":
      return "This service or its sign-in uses plain http. OAuth needs https.";
    case "discovery":
      return "This service did not describe how to sign in.";
    case "resource-mismatch":
      return "This service sent its sign-in to another address. T3 Code will not send that account's access here.";
    case "registration-unsupported":
      return "This service needs its own OAuth app. Create the connection again with the client ID from the service's developer settings.";
    case "registration-failed":
      return "This service refused to register T3 Code for sign-in.";
    case "sign-in-ended":
      return "This sign-in was cancelled, expired or already used. Start it again.";
    case "callback-invalid":
      return "This sign-in response does not belong to this sign-in. Start it again.";
    case "declined":
      return "The service did not grant access.";
    case "exchange-failed":
      return "The service refused to finish sign-in. Start it again.";
    case "unavailable":
      return "Could not reach the service or save the sign-in. Try again.";
  }
}

export const McpConnectionOAuthSignedOutReason = Schema.Literals([
  "never",
  "disconnected",
  "expired",
  "revoked",
]);
export type McpConnectionOAuthSignedOutReason = typeof McpConnectionOAuthSignedOutReason.Type;

const McpConnectionOAuthFlowId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/**
 * `credential` is what a Bot's load gets: a connected account, or nothing, in which case the Bot's
 * work runs without the connection. `signIn` is the latest sign-in while it runs or after it failed.
 */
export const McpConnectionOAuthState = Schema.Struct({
  credential: Schema.Union([
    Schema.Struct({ state: Schema.Literal("connected"), connectedAt: IsoDateTime }),
    Schema.Struct({
      state: Schema.Literal("signed-out"),
      reason: McpConnectionOAuthSignedOutReason,
    }),
  ]),
  signIn: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({
        state: Schema.Literal("pending"),
        flowId: McpConnectionOAuthFlowId,
        expiresAt: IsoDateTime,
      }),
      Schema.Struct({
        state: Schema.Literal("failed"),
        flowId: McpConnectionOAuthFlowId,
        reason: McpConnectionOAuthFailure,
      }),
    ]),
  ),
});
export type McpConnectionOAuthState = typeof McpConnectionOAuthState.Type;

export const McpConnectionSummary = Schema.Struct({
  id: McpConnectionId,
  label: Schema.String,
  enabled: Schema.Boolean,
  revision: NonNegativeInt,
  transport: Schema.Literals(["stdio", "http"]),
  /** A signed-out OAuth connection also reads `blocked` here, for clients that predate `oauth`. */
  status: McpConnectionStatus,
  oauth: ForwardCompatibleOptional(McpConnectionOAuthState),
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

/**
 * `redirectOrigin` is the origin the user's browser reaches this environment on, or a loopback
 * origin the client listens on itself. It must be https, or http on a loopback host.
 */
export const McpConnectionOAuthStartInput = Schema.Struct({
  connectionId: McpConnectionId,
  redirectOrigin: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_URL_LENGTH)),
});
export type McpConnectionOAuthStartInput = typeof McpConnectionOAuthStartInput.Type;
export const McpConnectionOAuthStartResult = Schema.Struct({
  flowId: McpConnectionOAuthFlowId,
  authorizationUrl: Schema.String,
  /** What a preregistered OAuth app must list as its redirect URI. */
  redirectUri: Schema.String,
  expiresAt: IsoDateTime,
});
export type McpConnectionOAuthStartResult = typeof McpConnectionOAuthStartResult.Type;

/** `callbackUrl` carries the authorization code: never log, trace or echo it. */
export const McpConnectionOAuthCompleteInput = Schema.Struct({
  connectionId: McpConnectionId,
  flowId: McpConnectionOAuthFlowId,
  callbackUrl: Schema.String.check(Schema.isMaxLength(8192)),
});
export type McpConnectionOAuthCompleteInput = typeof McpConnectionOAuthCompleteInput.Type;

export const McpConnectionOAuthCancelInput = Schema.Struct({
  connectionId: McpConnectionId,
  flowId: McpConnectionOAuthFlowId,
});
export type McpConnectionOAuthCancelInput = typeof McpConnectionOAuthCancelInput.Type;

export const McpConnectionOAuthConnectionInput = Schema.Struct({ connectionId: McpConnectionId });
export type McpConnectionOAuthConnectionInput = typeof McpConnectionOAuthConnectionInput.Type;

export class McpConnectionOAuthError extends Schema.TaggedError<McpConnectionOAuthError>()(
  "McpConnectionOAuthError",
  {
    reason: McpConnectionOAuthFailure,
    connectionId: Schema.optional(McpConnectionId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return mcpConnectionOAuthFailureMessage(this.reason);
  }
}

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
