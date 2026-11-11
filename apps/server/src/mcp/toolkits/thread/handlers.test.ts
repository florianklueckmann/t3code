import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
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
const mailRoutine = ScheduledTaskId.make("routine:mail");
const workRoutine = ScheduledTaskId.make("routine:work");
const plainSchedule = ScheduledTaskId.make("schedule:plain");
const call = (name: string, params: unknown) =>
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
                list: () =>
                  Effect.succeed({
                    tasks: [mailRoutine, workRoutine, plainSchedule].map((id) => ({ id })),
                  } as never),
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

it.effect.each([
  ...threadWrites.flatMap(([name, params, expected]) =>
    [mailHome, workHome, plainThread].map(
      (threadId) => [name, { ...params, threadId }, expected] as const,
    ),
  ),
  ["run_scheduled_task_now", { taskId: mailRoutine }, "reached"],
  ["run_scheduled_task_now", { taskId: workRoutine }, "reached"],
  ["run_scheduled_task_now", { taskId: plainSchedule }, "reached"],
  ["t3_thread_transfer", { action: "fork" }, "reached"],
  ["t3_thread_transfer", { action: "fork", threadId: workHome }, "reached"],
  ["t3_thread_transfer", { action: "fork", threadId: plainThread }, "reached"],
  [
    "t3_thread_transfer",
    { action: "merge_back", threadId: workHome, targetThreadId: caller },
    "reached",
  ],
  [
    "t3_thread_transfer",
    { action: "merge_back", threadId: mailHome, targetThreadId: plainThread },
    "reached",
  ],
] as const)("%s %o: %s", ([name, params, expected]) =>
  call(name, params).pipe(Effect.map((result) => expect(outcome(result)).toBe(expected))),
);
