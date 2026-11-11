import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  BotId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpCallerBot from "../../McpCallerBot.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  idleThreadProjection,
  layerCallerChangesAllowed,
  liveThreadShell,
} from "../../McpToolAccess.testkit.ts";
import * as ThreadHandlers from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

const caller = ThreadId.make("thread:caller");
const mailHome = ThreadId.make("thread:mail-home");
const workHome = ThreadId.make("thread:work-home");
const plainThread = ThreadId.make("thread:plain");
const lostThread = ThreadId.make("thread:lost");
const mailBot = BotId.make("mail-bot");
const workBot = BotId.make("work-bot");
const mailRoutine = ScheduledTaskId.make("routine:mail");
const workRoutine = ScheduledTaskId.make("routine:work");
const plainSchedule = ScheduledTaskId.make("schedule:plain");
const ofMailBot = { _tag: "bot", botId: mailBot } as const;
const ordinary = { _tag: "none" } as const;
const lines = new Map<ThreadId, McpCallerBot.McpCallerBotValue>([
  [mailHome, ofMailBot],
  [workHome, { _tag: "bot", botId: workBot }],
  [plainThread, ordinary],
  [lostThread, { _tag: "unknown" }],
]);
const tasks = [
  { id: mailRoutine, bot: { botId: mailBot } },
  { id: workRoutine, bot: { botId: workBot } },
  { id: plainSchedule },
];

/** Runs one tool call as a thread whose line belongs to `accessOf`; returns what reached a service. */
const call = (name: string, params: unknown, accessOf: McpCallerBot.McpCallerBotValue) =>
  Effect.gen(function* () {
    const reached = yield* Ref.make<ReadonlyArray<string>>([]);
    // Recorded, then refused, so no result needs encoding; only reaching the service counts.
    const reach = <E>(method: string, refusal: E) =>
      Ref.update(reached, (current) => [...current, method]).pipe(
        Effect.andThen(Effect.fail(refusal)),
      );
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* ThreadToolkit;
      const results = yield* toolkit
        .handle(name as never, params as never)
        .pipe(Stream.unwrap, Stream.runCollect);
      return results.at(-1)?.result;
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(McpInvocationContext.McpInvocationContext, {
                environmentId: EnvironmentId.make("environment:here"),
                requestNamespace: "provider:caller",
                thread: {
                  threadId: caller,
                  providerSessionId: "provider:caller",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                },
                client: undefined,
                capabilities: new Set(["orchestration" as const]),
                issuedAt: 0,
              }),
              Layer.succeed(McpCallerBot.McpCallerBot, {
                forThread: (thread) =>
                  Effect.succeed(
                    thread.id === caller ? accessOf : (lines.get(thread.id) ?? ordinary),
                  ),
              }),
              layerCallerChangesAllowed,
              NodeCrypto.layer,
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
                getProjectThreadRecords: ({ threadId }) =>
                  Effect.succeed(idleThreadProjection(liveThreadShell(threadId))),
                dispatch: (command) =>
                  reach(
                    command.type,
                    new ThreadManagement.ThreadManagementProviderInstanceDisabledError({
                      projectId: ProjectId.make("project:mcp-test"),
                      instanceId: ProviderInstanceId.make("codex"),
                    }),
                  ),
              }),
              Layer.mock(ScheduledTasks.ScheduledTaskService)({
                list: () => Effect.succeed({ tasks } as never),
                runNow: () => reach("runNow", new ScheduledTaskError({ message: "runNow" })),
              }),
              Layer.mock(ThreadSearch.ThreadSearch)({}),
            ),
          ),
        ),
      ),
    );
    return { result, reached: yield* Ref.get(reached) };
  });

const outcome = (input: { readonly result: unknown; readonly reached: ReadonlyArray<string> }) =>
  input.reached.length > 0
    ? "reached"
    : (input.result as { readonly code?: string } | undefined)?.code;

const codex = ProviderInstanceId.make("codex");
// No question is pending, so a respond the ownership check lets through fails at its lookup.
const threadWrites = [
  ["t3_thread_configure", { modelSelection: { instanceId: codex, model: "gpt-5" } }, "reached"],
  ["t3_queue", { action: "cancel", queuedRunId: RunId.make("run:queued") }, "reached"],
  ["t3_thread_organize", { action: "archive" }, "reached"],
  [
    "t3_pending_request",
    { action: "respond", requestId: RuntimeRequestId.make("request:1"), answers: {} },
    "invalid_request",
  ],
] as const;

// Another Bot's thread runs with that Bot's grants, so a Bot's line changes only its own. A thread
// of no Bot stays reachable: messaging one is outside the grant promise.
const ownership = [
  [mailHome, ofMailBot, true],
  [workHome, ofMailBot, false],
  [plainThread, ofMailBot, true],
  [lostThread, ofMailBot, false],
  [workHome, ordinary, true],
  [mailHome, { _tag: "unknown" }, false],
] as const;

it.effect.each([
  ...threadWrites.flatMap(([name, params, allowed]) =>
    ownership.map(
      ([threadId, accessOf, passes]) =>
        [name, { ...params, threadId }, accessOf, passes ? allowed : "capability_denied"] as const,
    ),
  ),
  // A routine runs with its Bot's grants, so a Bot's line runs only its own.
  ["run_scheduled_task_now", { taskId: mailRoutine }, ofMailBot, "reached"],
  ["run_scheduled_task_now", { taskId: workRoutine }, ofMailBot, "capability_denied"],
  ["run_scheduled_task_now", { taskId: plainSchedule }, ofMailBot, "capability_denied"],
  ["run_scheduled_task_now", { taskId: workRoutine }, ordinary, "reached"],
  ["run_scheduled_task_now", { taskId: mailRoutine }, { _tag: "unknown" }, "capability_denied"],
  // A fork loads the grants of the line it comes from, so a Bot's line forks only its own.
  ["t3_thread_transfer", { action: "fork" }, ofMailBot, "reached"],
  ["t3_thread_transfer", { action: "fork", threadId: mailHome }, ofMailBot, "reached"],
  ["t3_thread_transfer", { action: "fork", threadId: workHome }, ofMailBot, "capability_denied"],
  ["t3_thread_transfer", { action: "fork", threadId: plainThread }, ofMailBot, "capability_denied"],
  ["t3_thread_transfer", { action: "fork", threadId: workHome }, ordinary, "reached"],
  [
    "t3_thread_transfer",
    { action: "merge_back", threadId: mailHome, targetThreadId: caller },
    ofMailBot,
    "reached",
  ],
  [
    "t3_thread_transfer",
    { action: "merge_back", threadId: workHome, targetThreadId: caller },
    ofMailBot,
    "capability_denied",
  ],
  [
    "t3_thread_transfer",
    { action: "merge_back", threadId: mailHome, targetThreadId: plainThread },
    ofMailBot,
    "capability_denied",
  ],
  [
    "t3_thread_transfer",
    { action: "merge_back", threadId: workHome, targetThreadId: plainThread },
    ordinary,
    "reached",
  ],
] as const)("%s %o from %o: %s", ([name, params, accessOf, expected]) =>
  call(name, params, accessOf).pipe(Effect.map((result) => expect(outcome(result)).toBe(expected))),
);
