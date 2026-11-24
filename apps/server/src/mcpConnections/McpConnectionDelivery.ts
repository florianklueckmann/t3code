// @effect-diagnostics-next-line nodeBuiltinImport:off -- The load identity needs a synchronous digest.
import * as NodeCrypto from "node:crypto";

import {
  MAC_CALENDAR_CONNECTION_ID,
  MAC_CALENDAR_LABEL,
  mcpConnectionBindings,
  mcpConnectionBindingValueProblem,
  mcpConnectionDefinitionProblem,
  McpConnectionId,
  McpConnectionProblem,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as McpConnectionGrants from "@t3tools/provider-core/server/McpConnectionGrants";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as MacCalendarHelper from "../calendar/MacCalendarHelper.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";
import * as McpConnectionOAuth from "./McpConnectionOAuth.ts";

const GRANTED_SERVER_PREFIX = "t3c-";

/** A granted connection's server name, from its immutable id, never its label. */
export const grantedServerName = (id: McpConnectionId) => `${GRANTED_SERVER_PREFIX}${id}`;

const decodeConnectionId = Schema.decodeUnknownOption(McpConnectionId);
/** The connection a native server name was granted for, or undefined for any other server. */
export const grantedConnectionOf = (serverName: string): McpConnectionId | undefined =>
  serverName.startsWith(GRANTED_SERVER_PREFIX)
    ? Option.getOrUndefined(decodeConnectionId(serverName.slice(GRANTED_SERVER_PREFIX.length)))
    : undefined;

/**
 * The tool namespace a provider shows the model for a granted server: Codex and Pi turn hyphens
 * into underscores (measured on Codex 0.166, 0.167 and Pi 1.6.0), Claude keeps them (2.1.326).
 */
const grantedToolNamespace = (id: McpConnectionId, driver: string) =>
  driver === "claudeAgent"
    ? `mcp__${grantedServerName(id)}`
    : `mcp__${grantedServerName(id).replaceAll("-", "_")}`;

/**
 * Tells the model which granted account each namespace is. Labels and ids only: two accounts of
 * one service look alike otherwise. Only what a load delivered, so an account left out is unnamed.
 */
export const grantedConnectionsInstructions = (
  delivered: ReadonlyArray<Pick<DeliveredMcpConnection, "id" | "label">>,
  driver: string,
): string | undefined =>
  delivered.length === 0
    ? undefined
    : [
        "MCP connections granted to you, each a separate account. Use the one the request is about:",
        ...delivered.map(
          ({ id, label }) =>
            `- "${label}": tools in the ${grantedToolNamespace(id, driver)} namespace`,
        ),
      ].join("\n");

export interface DeliveredMcpConnection {
  readonly id: McpConnectionId;
  readonly label: string;
  /** The catalog revision delivered; with the id it names this load without any credential. */
  readonly revision: number;
  readonly transport:
    | {
        readonly type: "stdio";
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly env: Redacted.Redacted<Readonly<Record<string, string>>>;
      }
    | {
        readonly type: "http";
        readonly url: string;
        readonly headers: Redacted.Redacted<Readonly<Record<string, string>>>;
      }
    /** Served by T3 Code's own MCP endpoint with the thread's credential, as `toolset`. */
    | { readonly type: "t3"; readonly toolset: "calendar" };
}

export interface McpConnectionLoad {
  readonly connections: ReadonlyArray<DeliveredMcpConnection>;
  /**
   * Changes whenever anything delivered changes, credentials included, so an edit or a rotated
   * secret reloads the thread. Derived from credentials: keep it in memory and never log it.
   */
  readonly identity: string;
}

/**
 * Where a T3-served grant connects: the thread's own MCP session, narrowed to the toolset. The
 * header only selects what lists; the toolset's service checks the grant on every call.
 */
export const t3ServedEndpoint = (
  toolset: "calendar",
  session: { readonly endpoint: string; readonly authorizationHeader: string },
) => ({
  url: session.endpoint,
  headers: {
    Authorization: session.authorizationHeader,
    [McpInvocationContext.TOOLSET_HEADER]: toolset,
  },
});

/** Names the connection and its problem, never a value. */
export class McpConnectionDeliveryError extends Schema.TaggedError<McpConnectionDeliveryError>()(
  "McpConnectionDeliveryError",
  {
    /** missing: granted but neither in the catalog nor removed from it. */
    reason: Schema.Literals(["missing", "invalid", "unavailable"]),
    connectionId: Schema.optional(McpConnectionId),
    label: Schema.optional(Schema.String),
    problem: Schema.optional(McpConnectionProblem),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** A granted server that did not start: names the connection, never the provider's error text. */
export const grantedServerFailureNotice = (label: string | undefined) =>
  `${label === undefined ? "A granted MCP connection" : `"${label}"`} could not start, so its tools are unavailable in this conversation. Check it in Settings → MCP connections.`;

/** A load that could not be delivered, as the provider adapter refuses it. */
export const deliveryRefusal = (driver: ProviderDriverKind, error: McpConnectionDeliveryError) =>
  new ProviderAdapter.ProviderAdapterMcpConnectionsRefusedError(
    error.reason === "invalid"
      ? {
          driver,
          reason: "connection",
          ...(error.connectionId === undefined ? {} : { connectionId: error.connectionId }),
          ...(error.label === undefined ? {} : { connectionLabel: error.label }),
          ...(error.problem === undefined ? {} : { problem: error.problem }),
        }
      : { driver, reason: error.reason },
  );

export class McpConnectionDelivery extends Context.Service<
  McpConnectionDelivery,
  {
    /**
     * The granted connections a load gets, with credentials read now. A disabled, removed or
     * signed-out OAuth one is left out; any other that cannot be delivered fails the whole load,
     * with no fallback.
     */
    readonly resolve: (
      ids: ReadonlyArray<McpConnectionId>,
      macCalendarWrite?: boolean,
    ) => Effect.Effect<McpConnectionLoad, McpConnectionDeliveryError>;
    /** The provider saw this connection refuse its credential; an OAuth one refreshes next load. */
    readonly markRefused: (id: McpConnectionId, source: "startup" | "call") => Effect.Effect<void>;
  }
>()("t3/mcpConnections/McpConnectionDelivery") {}

const encodeCanonical = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const resolver = yield* SecretResolver.SecretResolver;
  const oauth = yield* McpConnectionOAuth.McpConnectionOAuth;
  const calendarHelper = yield* MacCalendarHelper.MacCalendarHelper;

  const resolve = Effect.fn("McpConnectionDelivery.resolve")(function* (
    ids: ReadonlyArray<McpConnectionId>,
    macCalendarWrite = false,
  ) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new McpConnectionDeliveryError({ reason: "unavailable", cause })),
    );
    const connections: Array<DeliveredMcpConnection> = [];
    const canonical: Array<unknown> = [];
    for (const id of [...new Set(ids)].toSorted()) {
      if (id === MAC_CALENDAR_CONNECTION_ID) {
        // Off, without calendars or without the helper it has nothing to read, so the Bot runs
        // without it; Settings says why.
        const calendar = current.macCalendar;
        if (!calendar.enabled || calendar.calendars.length === 0) continue;
        if ((yield* calendarHelper.availability) !== "available") continue;
        connections.push({
          id,
          label: MAC_CALENDAR_LABEL,
          revision: calendar.revision,
          transport: { type: "t3", toolset: "calendar" },
        });
        const writable =
          macCalendarWrite && calendar.calendars.some((entry) => entry.allowWrite === true);
        canonical.push([id, MAC_CALENDAR_LABEL, ["t3", "calendar"], [], writable]);
        continue;
      }
      const definition = current.mcpConnections[id];
      if (definition === undefined) {
        if (current.retiredMcpConnectionIds.includes(id)) continue;
        return yield* new McpConnectionDeliveryError({ reason: "missing", connectionId: id });
      }
      if (!definition.enabled) continue;
      const invalid = (problem: McpConnectionProblem) =>
        new McpConnectionDeliveryError({
          reason: "invalid",
          connectionId: id,
          label: definition.label,
          problem,
        });
      const problem = mcpConnectionDefinitionProblem(definition);
      if (problem !== undefined) return yield* invalid(problem);
      const { slot, bindings } = mcpConnectionBindings(definition.transport);
      const values: Record<string, string> = {};
      if (definition.transport.type === "http" && definition.transport.oauth !== undefined) {
        const token = yield* oauth.accessToken(id);
        // Signed out: the Bot's work runs without this account, and the catalog shows why.
        if (Option.isNone(token)) continue;
        values.Authorization = `Bearer ${Redacted.value(token.value)}`;
      }
      for (const [binding, value] of Object.entries(bindings)) {
        const resolved = yield* requireSettingsSecret(resolver, value).pipe(
          Effect.catchTags({ SettingsSecretUnresolvedError: () => Effect.undefined }),
        );
        if (resolved === undefined)
          return yield* invalid({ reason: "binding-unresolved", binding });
        const valueProblem = mcpConnectionBindingValueProblem(slot, binding, resolved);
        if (valueProblem !== undefined) return yield* invalid(valueProblem);
        values[binding] = resolved;
      }
      const transport = definition.transport;
      connections.push({
        id,
        label: definition.label,
        revision: definition.revision,
        transport:
          transport.type === "stdio"
            ? {
                type: "stdio",
                command: transport.command,
                args: transport.args,
                env: Redacted.make(values),
              }
            : { type: "http", url: transport.url, headers: Redacted.make(values) },
      });
      canonical.push([
        id,
        definition.label,
        transport.type === "stdio" ? [transport.command, ...transport.args] : [transport.url],
        Object.entries(values).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ]);
    }
    return {
      connections,
      identity: NodeCrypto.createHash("sha256").update(encodeCanonical(canonical)).digest("hex"),
    } satisfies McpConnectionLoad;
  });

  const markRefused = Effect.fn("McpConnectionDelivery.markRefused")(function* (
    id: McpConnectionId,
    source: "startup" | "call",
  ) {
    const current = yield* settings.getSettings.pipe(Effect.option);
    const transport = Option.isSome(current)
      ? current.value.mcpConnections[id]?.transport
      : undefined;
    if (transport?.type === "http" && transport.oauth !== undefined) {
      yield* oauth.markStale(id, source);
    }
  });

  return McpConnectionDelivery.of({ resolve, markRefused });
});

export const layer = Layer.effect(McpConnectionDelivery, make);

/** Grants for adapters outside this package: T3-served toolsets become HTTP on the thread's session. */
export const grantsLayer = Layer.effect(
  McpConnectionGrants.McpConnectionGrants,
  Effect.gen(function* () {
    const delivery = yield* McpConnectionDelivery;
    return McpConnectionGrants.McpConnectionGrants.of({
      resolve: Effect.fn("McpConnectionGrants.resolve")(function* (input) {
        const load = yield* delivery
          .resolve(input.ids)
          .pipe(Effect.mapError((error) => deliveryRefusal(input.driver, error)));
        const servers: Array<McpConnectionGrants.GrantedMcpServer> = [];
        for (const { id, transport } of load.connections) {
          const name = grantedServerName(id);
          if (transport.type !== "t3") {
            servers.push({ id, name, transport });
            continue;
          }
          if (input.mcpSession === undefined)
            return yield* new ProviderAdapter.ProviderAdapterMcpConnectionsRefusedError({
              driver: input.driver,
              reason: "unavailable",
            });
          const endpoint = t3ServedEndpoint(transport.toolset, input.mcpSession);
          servers.push({
            id,
            name,
            transport: {
              type: "http",
              url: endpoint.url,
              headers: Redacted.make(endpoint.headers),
            },
          });
        }
        return {
          servers,
          instructions: grantedConnectionsInstructions(load.connections, input.driver),
        };
      }),
    });
  }),
);
