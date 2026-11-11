import type { ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as BotExecutionConstraint from "./BotExecutionConstraint.ts";
import * as BotTurnContext from "./BotTurnContext.ts";

/**
 * Why a restricted Bot run cannot be enforced on this instance here, or undefined. Only Codex
 * enforces a restriction, and only where it was verified natively. An instance id is not a
 * driver, so the registry says which driver runs it.
 */
export const restrictionUnenforceable = Effect.fn("BotRuntimePolicy.restrictionUnenforceable")(
  function* (
    providerInstances: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* providerInstances.getInstance(instanceId);
    return instance?.driverKind !== "codex"
      ? ("provider" as const)
      : (yield* HostProcess.Platform) !== "darwin"
        ? ("platform" as const)
        : undefined;
  },
);

/**
 * Bot threads, forks and subagents included, run without provider memory and with only the Bot's
 * granted MCP connections where enforceable. Elsewhere, only Bots with grants are refused.
 * A No changes routine task also runs restricted. Other threads keep their settings.
 */
export const layer: Layer.Layer<
  RuntimePolicy.RuntimePolicyV2,
  never,
  | RuntimePolicy.RuntimePolicyV2
  | BotTurnContext.BotTurnContext
  | BotExecutionConstraint.BotExecutionConstraint
  | ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(
  RuntimePolicy.RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicy.RuntimePolicyV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const botTurnContext = yield* BotTurnContext.BotTurnContext;
    const executionConstraint = yield* BotExecutionConstraint.BotExecutionConstraint;
    return RuntimePolicy.RuntimePolicyV2.of({
      resolve: Effect.fn("BotRuntimePolicy.resolve")(function* (input) {
        const policy = yield* base.resolve(input);
        const resolveError = (cause: unknown) =>
          new RuntimePolicy.RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause,
          });
        // Inactive Bot conversations count too: a failed read must not leave memory on.
        const bot = yield* botTurnContext
          .forThread(input.thread.id)
          .pipe(Effect.mapError(resolveError));
        const unenforceable = () =>
          restrictionUnenforceable(providerInstances, input.modelSelection.instanceId);
        if (input.restriction !== undefined) {
          const reason =
            bot._tag !== "active" ||
            bot.scope.taskId !== null ||
            bot.scope.homeThreadId !== input.thread.id
              ? ("home" as const)
              : yield* unenforceable();
          if (reason !== undefined) {
            return yield* new RuntimePolicy.RuntimePolicyUnsupportedError({
              threadId: input.thread.id,
              providerInstanceId: input.modelSelection.instanceId,
              reason,
              restriction: input.restriction,
            });
          }
          // The working note and Waiting check need no external account, so none load.
          return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            ...policy,
            nativeMemory: "disabled",
            nativeTools: "t3BotOnly",
            mcpConnections: [],
          });
        }
        const constraint = yield* executionConstraint
          .forThread(input.thread.id)
          .pipe(Effect.mapError(resolveError));
        const noChanges = constraint === "no-changes";
        if (noChanges) {
          const reason = yield* unenforceable();
          if (reason !== undefined) {
            return yield* new RuntimePolicy.RuntimePolicyUnsupportedError({
              threadId: input.thread.id,
              providerInstanceId: input.modelSelection.instanceId,
              reason,
            });
          }
        }
        const access = yield* botTurnContext
          .mcpAccessForThread(input.thread)
          .pipe(Effect.mapError(resolveError));
        if (access._tag === "none") {
          return noChanges
            ? ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                nativeMemory: "disabled",
                nativeTools: "readOnly",
              })
            : policy;
        }
        // Its own inactive conversation refuses with its Bot instructions; a derived one here.
        if (access._tag === "refused" && bot._tag === "none") {
          return yield* new RuntimePolicy.RuntimePolicyMcpUnsupportedError({
            threadId: input.thread.id,
            providerInstanceId: input.modelSelection.instanceId,
            detail: access.message,
          });
        }
        const mcpConnections = access._tag === "bot" ? access.connectionIds : [];
        const mcpReason = yield* unenforceable();
        if (mcpReason !== undefined && mcpConnections.length > 0) {
          const botName = access._tag === "bot" ? access.botName : "This Bot";
          return yield* new RuntimePolicy.RuntimePolicyMcpUnsupportedError({
            threadId: input.thread.id,
            providerInstanceId: input.modelSelection.instanceId,
            detail:
              mcpReason === "provider"
                ? `${botName} uses only the MCP connections granted to it, which only Codex can enforce, so nothing ran. Switch this thread to a Codex model.`
                : `${botName} uses only the MCP connections granted to it, which is only verified on macOS, so nothing ran.`,
          });
        }
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...policy,
          nativeMemory: "disabled",
          ...(noChanges ? { nativeTools: "readOnly" as const } : {}),
          ...(mcpReason === undefined ? { mcpConnections } : {}),
        });
      }),
    });
  }),
);
