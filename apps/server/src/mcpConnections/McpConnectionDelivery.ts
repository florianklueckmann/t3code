// @effect-diagnostics-next-line nodeBuiltinImport:off -- The load identity needs a synchronous digest.
import * as NodeCrypto from "node:crypto";

import {
  mcpConnectionBindings,
  mcpConnectionBindingValueProblem,
  mcpConnectionDefinitionProblem,
  McpConnectionId,
  McpConnectionProblem,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

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

/** The tool namespace Codex shows the model for a granted server (measured on 0.166, 0.167). */
const grantedToolNamespace = (id: McpConnectionId) =>
  `mcp__${grantedServerName(id).replaceAll("-", "_")}`;

/**
 * Tells the model which granted account each namespace is. Labels and ids only: two accounts of
 * one service look alike otherwise. Disabled and removed connections are not loaded, so not listed.
 */
export const grantedConnectionsInstructions = (
  ids: ReadonlyArray<McpConnectionId>,
  catalog: Readonly<Record<string, { readonly label: string; readonly enabled: boolean }>>,
): string | undefined => {
  const lines = ids.flatMap((id) => {
    const definition = catalog[id];
    return definition?.enabled === true
      ? [`- "${definition.label}": tools in the ${grantedToolNamespace(id)} namespace`]
      : [];
  });
  return lines.length === 0
    ? undefined
    : [
        "MCP connections granted to you, each a separate account. Use the one the request is about:",
        ...lines,
      ].join("\n");
};

export interface DeliveredMcpConnection {
  readonly id: McpConnectionId;
  readonly label: string;
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
      };
}

export interface McpConnectionLoad {
  readonly connections: ReadonlyArray<DeliveredMcpConnection>;
  /**
   * Changes whenever anything delivered changes, credentials included, so an edit or a rotated
   * secret reloads the thread. Derived from credentials: keep it in memory and never log it.
   */
  readonly identity: string;
}

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

  const resolve = Effect.fn("McpConnectionDelivery.resolve")(function* (
    ids: ReadonlyArray<McpConnectionId>,
  ) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new McpConnectionDeliveryError({ reason: "unavailable", cause })),
    );
    const connections: Array<DeliveredMcpConnection> = [];
    const canonical: Array<unknown> = [];
    for (const id of [...new Set(ids)].toSorted()) {
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
