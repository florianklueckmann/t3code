import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as BotTurnContext from "./BotTurnContext.ts";

/**
 * Turns off the provider's own memory in Bot conversations, so what a Bot keeps is only
 * the scoped, reviewable learning its policy governs. Other threads keep their settings.
 */
export const layer: Layer.Layer<
  RuntimePolicy.RuntimePolicyV2,
  never,
  RuntimePolicy.RuntimePolicyV2 | BotTurnContext.BotTurnContext
> = Layer.effect(
  RuntimePolicy.RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicy.RuntimePolicyV2;
    const botTurnContext = yield* BotTurnContext.BotTurnContext;
    return RuntimePolicy.RuntimePolicyV2.of({
      resolve: Effect.fn("BotRuntimePolicy.resolve")(function* (input) {
        const policy = yield* base.resolve(input);
        // Inactive Bot conversations count too: a failed read must not leave memory on.
        const bot = yield* botTurnContext.forThread(input.thread.id).pipe(
          Effect.mapError(
            (cause) =>
              new RuntimePolicy.RuntimePolicyResolveError({
                projectId: input.thread.projectId,
                providerInstanceId: input.modelSelection.instanceId,
                cause,
              }),
          ),
        );
        return bot._tag === "none"
          ? policy
          : ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              ...policy,
              nativeMemory: "disabled",
            });
      }),
    });
  }),
);
