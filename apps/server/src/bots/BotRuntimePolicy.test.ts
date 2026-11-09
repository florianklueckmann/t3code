import { assert, it } from "@effect/vitest";
import {
  BotId,
  BotTaskId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as BotExecutionConstraint from "./BotExecutionConstraint.ts";
import * as BotRuntimePolicy from "./BotRuntimePolicy.ts";
import * as BotStore from "./BotStore.ts";
import * as BotTurnContext from "./BotTurnContext.ts";

const botThread = ThreadId.make("bot-home:companion:campaign");
const workThread = ThreadId.make("bot-work:bot-task:1");
const archivedBotThread = ThreadId.make("bot-home:archived:campaign");
const brokenThread = ThreadId.make("bot-home:broken:campaign");
const noChangesThread = ThreadId.make("bot-work:bot-task:no-changes");
const archivedNoChangesThread = ThreadId.make("bot-work:bot-task:archived-no-changes");
const unreadableTaskThread = ThreadId.make("bot-work:bot-task:unreadable");

const activeScope = (id: ThreadId) =>
  ({
    _tag: "active",
    instructions: "",
    scope: {
      botId: BotId.make("companion"),
      projectId: ProjectId.make("campaign"),
      homeThreadId: botThread,
      taskId: id === botThread ? null : BotTaskId.make("bot-task:1"),
    },
  }) as const;

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
          Layer.mergeAll(
            RuntimePolicy.layer,
            Layer.mock(BotTurnContext.BotTurnContext)({
              forThread: (id) =>
                id === botThread || id === workThread || id === noChangesThread
                  ? Effect.succeed(activeScope(id))
                  : id === archivedBotThread || id === archivedNoChangesThread
                    ? Effect.succeed({ _tag: "inactive", message: "archived" } as const)
                    : id === brokenThread
                      ? Effect.fail(new BotStore.BotStoreError({ operation: "read", cause: "x" }))
                      : Effect.succeed({ _tag: "none" } as const),
            }),
            // The task row decides, whatever the Bot's state: it is never edited after admission.
            Layer.mock(BotExecutionConstraint.BotExecutionConstraint)({
              forThread: (id) =>
                id === noChangesThread || id === archivedNoChangesThread
                  ? Effect.succeed("no-changes")
                  : id === unreadableTaskThread
                    ? Effect.fail(
                        new BotStore.BotStoreError({ operation: "read-task", cause: "x" }),
                      )
                    : Effect.succeed("standard"),
            }),
          ),
        ),
      ),
    ),
  );

it.effect("turns provider memory off for Bot conversations only", () =>
  Effect.gen(function* () {
    assert.equal((yield* resolveFor(botThread)).nativeMemory, "disabled");
    assert.equal((yield* resolveFor(workThread)).nativeMemory, "disabled");
    assert.equal((yield* resolveFor(archivedBotThread)).nativeMemory, "disabled");
    const plain = yield* resolveFor(ThreadId.make("plain"));
    assert.isUndefined(plain.nativeMemory);
    assert.equal(plain.cwd, "/campaign");
    // An unreadable Bot record must not start the turn with memory on.
    const broken = yield* resolveFor(brokenThread).pipe(Effect.flip);
    assert.equal(broken._tag, "RuntimePolicyResolveError");
  }),
);

it.effect("never resolves a No changes task to a policy that can change things", () =>
  Effect.gen(function* () {
    for (const threadId of [noChangesThread, archivedNoChangesThread]) {
      const refused = yield* resolveFor(threadId).pipe(Effect.flip);
      assert.equal(refused._tag, "RuntimePolicyUnsupportedError");
    }
    const unreadable = yield* resolveFor(unreadableTaskThread).pipe(Effect.flip);
    assert.equal(unreadable._tag, "RuntimePolicyResolveError");
    // Changes allowed, direct tasks (also stored with allow_changes = 0) and Home are unchanged.
    for (const threadId of [workThread, botThread, ThreadId.make("plain")]) {
      assert.isUndefined((yield* resolveFor(threadId)).changes);
    }
  }),
);
