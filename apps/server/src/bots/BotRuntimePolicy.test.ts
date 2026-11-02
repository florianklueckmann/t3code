import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as BotRuntimePolicy from "./BotRuntimePolicy.ts";
import * as BotStore from "./BotStore.ts";
import * as BotTurnContext from "./BotTurnContext.ts";

const botThread = ThreadId.make("bot-home:companion:campaign");
const archivedBotThread = ThreadId.make("bot-home:archived:campaign");
const brokenThread = ThreadId.make("bot-home:broken:campaign");

const resolveFor = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    return yield* policy.resolve({
      thread: {
        id: threadId,
        projectId: ProjectId.make("campaign"),
        runtimeMode: "full-access",
        interactionMode: "default",
        worktreePath: "/campaign",
      } as OrchestrationV2AppThread,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    });
  }).pipe(
    Effect.provide(
      BotRuntimePolicy.layer.pipe(
        Layer.provide(
          Layer.merge(
            RuntimePolicy.layer,
            Layer.mock(BotTurnContext.BotTurnContext)({
              forThread: (id) =>
                id === botThread
                  ? Effect.succeed({ _tag: "active", instructions: "" } as const)
                  : id === archivedBotThread
                    ? Effect.succeed({ _tag: "inactive", message: "archived" } as const)
                    : id === brokenThread
                      ? Effect.fail(new BotStore.BotStoreError({ operation: "read", cause: "x" }))
                      : Effect.succeed({ _tag: "none" } as const),
            }),
          ),
        ),
      ),
    ),
  );

it.effect("turns provider memory off for Bot conversations only", () =>
  Effect.gen(function* () {
    assert.equal((yield* resolveFor(botThread)).nativeMemory, "disabled");
    assert.equal((yield* resolveFor(archivedBotThread)).nativeMemory, "disabled");
    const plain = yield* resolveFor(ThreadId.make("plain"));
    assert.isUndefined(plain.nativeMemory);
    assert.equal(plain.cwd, "/campaign");
    // An unreadable Bot record must not start the turn with memory on.
    const broken = yield* resolveFor(brokenThread).pipe(Effect.flip);
    assert.equal(broken._tag, "RuntimePolicyResolveError");
  }),
);
