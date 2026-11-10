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
 * Turns off the provider's own memory in Bot conversations, so what a Bot keeps is only
 * the scoped, reviewable learning its policy governs. A routine task admitted without changes
 * runs restricted, or not at all where that cannot be enforced. Other threads keep their settings.
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
    const resolveErrorFor = (input: RuntimePolicy.RuntimePolicyV2Input) => (cause: unknown) =>
      new RuntimePolicy.RuntimePolicyResolveError({
        projectId: input.thread.projectId,
        providerInstanceId: input.modelSelection.instanceId,
        cause,
      });
    return RuntimePolicy.RuntimePolicyV2.of({
      resolve: Effect.fn("BotRuntimePolicy.resolve")(function* (input) {
        const policy = yield* base.resolve(input);
        const resolveError = resolveErrorFor(input);
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
          return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            ...policy,
            nativeMemory: "disabled",
            nativeTools: "t3BotOnly",
          });
        }
        const constraint = yield* executionConstraint
          .forThread(input.thread.id)
          .pipe(Effect.mapError(resolveError));
        if (constraint === "no-changes") {
          const reason = yield* unenforceable();
          if (reason !== undefined) {
            return yield* new RuntimePolicy.RuntimePolicyUnsupportedError({
              threadId: input.thread.id,
              providerInstanceId: input.modelSelection.instanceId,
              reason,
            });
          }
          return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            ...policy,
            nativeMemory: "disabled",
            changes: "none",
          });
        }
        return bot._tag === "none"
          ? policy
          : ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              ...policy,
              nativeMemory: "disabled",
            });
      }),
      resolveChanges: Effect.fn("BotRuntimePolicy.resolveChanges")(function* (input) {
        const constraint = yield* executionConstraint
          .forThread(input.thread.id)
          .pipe(Effect.mapError(resolveErrorFor(input)));
        return constraint === "no-changes" ? "none" : yield* base.resolveChanges(input);
      }),
    });
  }),
);
