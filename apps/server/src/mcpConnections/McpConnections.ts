import {
  isSecretReference,
  MCP_CONNECTIONS_MAX,
  mcpConnectionBindings,
  mcpConnectionBindingValueProblem,
  mcpConnectionDefinitionProblem,
  McpConnectionError,
  type McpConnectionBindings,
  type McpConnectionCreateInput,
  type McpConnectionDefinition,
  type McpConnectionId,
  type McpConnectionListResult,
  type McpConnectionProblem,
  type McpConnectionRefreshInput,
  type McpConnectionRemoveInput,
  type McpConnectionStatus,
  type McpConnectionSummary,
  type McpConnectionTransport,
  type McpConnectionUpdateInput,
  type ServerSettings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as BotService from "../bots/BotService.ts";
import * as McpConnectionOAuth from "./McpConnectionOAuth.ts";
import * as Settings from "../serverSettings.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";

/**
 * The environment's MCP connection catalog. Statuses cover definition validation and binding
 * resolution only: nothing here starts an MCP server, calls one, or gives a Bot access to it.
 */
export class McpConnections extends Context.Service<
  McpConnections,
  {
    /** Reads no secret provider: references not read by `refresh` since the last edit are `unchecked`. */
    readonly list: Effect.Effect<McpConnectionListResult, McpConnectionError>;
    readonly create: (
      input: McpConnectionCreateInput,
    ) => Effect.Effect<McpConnectionSummary, McpConnectionError>;
    readonly update: (
      input: McpConnectionUpdateInput,
    ) => Effect.Effect<McpConnectionSummary, McpConnectionError>;
    readonly remove: (
      input: McpConnectionRemoveInput,
    ) => Effect.Effect<{ readonly connectionId: McpConnectionId }, McpConnectionError>;
    /** Reads each binding's secret again, which may ask a secret provider to unlock. */
    readonly refresh: (
      input: McpConnectionRefreshInput,
    ) => Effect.Effect<McpConnectionListResult, McpConnectionError>;
  }
>()("t3/mcpConnections/McpConnections") {}

const blocked = (problem: McpConnectionProblem): McpConnectionStatus => ({
  state: "blocked",
  problem,
});

const settingsUnavailable = (cause: ServerSettingsError) =>
  new McpConnectionError({ reason: "settings-unavailable", cause });

// What a retried create must match to count as the same request. Holds literal values: compare only.
const creationShape = (definition: {
  readonly label: string;
  readonly enabled: boolean;
  readonly transport: McpConnectionTransport;
}) => {
  const { slot, bindings } = mcpConnectionBindings(definition.transport);
  return JSON.stringify({
    label: definition.label,
    enabled: definition.enabled,
    endpoint:
      definition.transport.type === "stdio"
        ? [definition.transport.command, ...definition.transport.args]
        : [definition.transport.url],
    slot,
    bindings: Object.entries(bindings),
    oauth: definition.transport.type === "http" ? definition.transport.oauth : undefined,
  });
};

const withBindings = (
  transport: McpConnectionTransport,
  bindings: McpConnectionBindings,
): McpConnectionTransport =>
  transport.type === "stdio"
    ? { ...transport, env: bindings }
    : { ...transport, httpHeaders: bindings };

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const resolver = yield* SecretResolver.SecretResolver;
  const bots = yield* BotService.BotService;
  const oauth = yield* McpConnectionOAuth.McpConnectionOAuth;
  // Results of the last explicit refresh, valid only for the revision they checked.
  const checks = new Map<
    McpConnectionId,
    { readonly revision: number; readonly status: McpConnectionStatus }
  >();

  const statusOf = (id: McpConnectionId, definition: McpConnectionDefinition) => {
    const problem = mcpConnectionDefinitionProblem(definition);
    if (problem !== undefined) return blocked(problem);
    const { bindings } = mcpConnectionBindings(definition.transport);
    if (!Object.values(bindings).some(isSecretReference)) return { state: "ready" } as const;
    const check = checks.get(id);
    return check?.revision === definition.revision
      ? check.status
      : ({ state: "unchecked" } as const);
  };

  const summaryOf = Effect.fn("McpConnections.summaryOf")(function* (
    id: McpConnectionId,
    definition: McpConnectionDefinition,
  ) {
    const summary: McpConnectionSummary = {
      id,
      label: definition.label,
      enabled: definition.enabled,
      revision: definition.revision,
      transport: definition.transport.type,
      status: statusOf(id, definition),
    };
    if (definition.transport.type !== "http" || definition.transport.oauth === undefined) {
      return summary;
    }
    const state = yield* oauth.state(id).pipe(Effect.option);
    if (Option.isNone(state)) return summary;
    return {
      ...summary,
      // Clients that predate `oauth` see a signed-out account as an Authorization it cannot read.
      status:
        summary.status.state === "blocked" || state.value.credential.state === "connected"
          ? summary.status
          : blocked({ reason: "binding-unresolved", binding: "Authorization" }),
      oauth: state.value,
    } satisfies McpConnectionSummary;
  });

  const summaryIn = (current: ServerSettings, id: McpConnectionId) => {
    const definition = current.mcpConnections[id];
    return definition === undefined
      ? Effect.fail(new McpConnectionError({ reason: "not-found", connectionId: id }))
      : summaryOf(id, definition);
  };

  // Every binding must resolve to a deliverable value; one failure fails the whole connection.
  const resolveStatus = Effect.fn("McpConnections.resolveStatus")(function* (
    definition: McpConnectionDefinition,
  ) {
    const problem = mcpConnectionDefinitionProblem(definition);
    if (problem !== undefined) return blocked(problem);
    const { slot, bindings } = mcpConnectionBindings(definition.transport);
    for (const [binding, value] of Object.entries(bindings)) {
      const resolved = yield* requireSettingsSecret(resolver, value).pipe(
        Effect.catchTags({ SettingsSecretUnresolvedError: () => Effect.undefined }),
      );
      if (resolved === undefined) return blocked({ reason: "binding-unresolved", binding });
      const invalid = mcpConnectionBindingValueProblem(slot, binding, resolved);
      if (invalid !== undefined) return blocked(invalid);
    }
    return { state: "ready" } as const;
  });

  const getSettings = settings.getSettings.pipe(Effect.mapError(settingsUnavailable));

  const updateCatalog = (
    update: (
      current: ServerSettings,
      withSecrets: Effect.Effect<ServerSettings, ServerSettingsError>,
    ) => Effect.Effect<Settings.McpConnectionCatalog, McpConnectionError | ServerSettingsError>,
  ) =>
    settings.updateMcpConnections(update).pipe(
      Effect.catchTags({
        ServerSettingsError: (error) => Effect.fail(settingsUnavailable(error)),
      }),
    );

  const list = Effect.gen(function* () {
    const current = yield* getSettings;
    return {
      connections: yield* Effect.forEach(
        Object.entries(current.mcpConnections),
        ([id, definition]) => summaryOf(id as McpConnectionId, definition),
      ),
    };
  }).pipe(Effect.withSpan("McpConnections.list"));

  const create = Effect.fn("McpConnections.create")(function* (input: McpConnectionCreateInput) {
    const id = input.connectionId;
    const requested: McpConnectionDefinition = {
      label: input.label,
      enabled: input.enabled,
      revision: 1,
      transport: input.transport,
      authentication: { type: "bindings" },
    };
    const problem = mcpConnectionDefinitionProblem(requested);
    if (problem !== undefined) {
      return yield* new McpConnectionError({ reason: "invalid-definition", problem });
    }
    const saved = yield* updateCatalog((current, withSecrets) => {
      const catalog = {
        mcpConnections: current.mcpConnections,
        retiredMcpConnectionIds: current.retiredMcpConnectionIds,
      };
      if (current.mcpConnections[id] !== undefined) {
        return withSecrets.pipe(
          Effect.flatMap(({ mcpConnections }) => {
            const existing = mcpConnections[id];
            return existing?.revision === requested.revision &&
              creationShape(existing) === creationShape(requested)
              ? Effect.succeed(catalog)
              : Effect.fail(new McpConnectionError({ reason: "id-unavailable", connectionId: id }));
          }),
        );
      }
      if (current.retiredMcpConnectionIds.includes(id)) {
        return Effect.fail(new McpConnectionError({ reason: "id-unavailable", connectionId: id }));
      }
      if (Object.keys(current.mcpConnections).length >= MCP_CONNECTIONS_MAX) {
        return Effect.fail(new McpConnectionError({ reason: "limit-reached" }));
      }
      return Effect.succeed({
        ...catalog,
        mcpConnections: { ...current.mcpConnections, [id]: requested },
      });
    });
    return yield* summaryIn(saved, id);
  });

  const update = Effect.fn("McpConnections.update")(function* (input: McpConnectionUpdateInput) {
    const id = input.connectionId;
    const saved = yield* updateCatalog((current) => {
      const existing = current.mcpConnections[id];
      if (existing === undefined) {
        return Effect.fail(new McpConnectionError({ reason: "not-found", connectionId: id }));
      }
      if (existing.revision !== input.expectedRevision) {
        return Effect.fail(
          new McpConnectionError({
            reason: "revision-conflict",
            connectionId: id,
            currentRevision: existing.revision,
          }),
        );
      }
      const next: McpConnectionDefinition = {
        ...existing,
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        transport:
          input.bindings === undefined
            ? existing.transport
            : withBindings(existing.transport, input.bindings),
        revision: existing.revision + 1,
      };
      // Renaming or disabling stays possible while a saved binding is broken; status shows it.
      const problem =
        input.bindings === undefined ? undefined : mcpConnectionDefinitionProblem(next);
      if (problem !== undefined) {
        return Effect.fail(new McpConnectionError({ reason: "invalid-definition", problem }));
      }
      return Effect.succeed({
        mcpConnections: { ...current.mcpConnections, [id]: next },
        retiredMcpConnectionIds: current.retiredMcpConnectionIds,
      });
    });
    return yield* summaryIn(saved, id);
  });

  const remove = Effect.fn("McpConnections.remove")(function* (input: McpConnectionRemoveInput) {
    const id = input.connectionId;
    // Signed out while the definition still holds a preregistered app's secret for revocation.
    const removing = (yield* getSettings).mcpConnections[id];
    if (
      removing?.revision === input.expectedRevision &&
      removing.transport.type === "http" &&
      removing.transport.oauth !== undefined
    ) {
      yield* oauth
        .forget(id)
        .pipe(
          Effect.mapError(
            (cause) => new McpConnectionError({ reason: "settings-unavailable", cause }),
          ),
        );
    }
    yield* updateCatalog((current) => {
      const existing = current.mcpConnections[id];
      // A retried remove of a connection it already removed succeeds without another write.
      if (existing === undefined) {
        return current.retiredMcpConnectionIds.includes(id)
          ? Effect.succeed({
              mcpConnections: current.mcpConnections,
              retiredMcpConnectionIds: current.retiredMcpConnectionIds,
            })
          : Effect.fail(new McpConnectionError({ reason: "not-found", connectionId: id }));
      }
      if (existing.revision !== input.expectedRevision) {
        return Effect.fail(
          new McpConnectionError({
            reason: "revision-conflict",
            connectionId: id,
            currentRevision: existing.revision,
          }),
        );
      }
      const { [id]: _removed, ...rest } = current.mcpConnections;
      return Effect.succeed({
        mcpConnections: rest,
        retiredMcpConnectionIds: [...current.retiredMcpConnectionIds, id],
      });
    });
    checks.delete(id);
    // Retiring first means no Bot can load it even if this cleanup is lost; a retry repeats it.
    yield* bots
      .forgetMcpConnection(id)
      .pipe(
        Effect.mapError(
          (cause) => new McpConnectionError({ reason: "settings-unavailable", cause }),
        ),
      );
    return { connectionId: id };
  });

  const refresh = Effect.fn("McpConnections.refresh")(function* (input: McpConnectionRefreshInput) {
    const current = yield* getSettings;
    const connections = yield* Effect.forEach(input.connectionIds, (id) => {
      const definition = current.mcpConnections[id];
      return definition === undefined
        ? Effect.fail(new McpConnectionError({ reason: "not-found", connectionId: id }))
        : Effect.succeed([id, definition] as const);
    });
    yield* resolver.invalidate(
      connections.flatMap(([, definition]) =>
        Object.values(mcpConnectionBindings(definition.transport).bindings).filter(
          isSecretReference,
        ),
      ),
    );
    for (const [id, definition] of connections) {
      const status = yield* resolveStatus(definition);
      // A refresh of an older revision can finish after one of a newer revision.
      if ((checks.get(id)?.revision ?? 0) <= definition.revision) {
        checks.set(id, { revision: definition.revision, status });
      }
    }
    return {
      connections: yield* Effect.forEach(connections, ([id, definition]) =>
        summaryOf(id, definition),
      ),
    };
  });

  return McpConnections.of({ list, create, update, remove, refresh });
});

export const layer = Layer.effect(McpConnections, make);
