import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  BotError,
  BotId,
  CommandId,
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

import * as BotService from "../../../bots/BotService.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import { BotRoutineTarget } from "../../../scheduledTasks/BotRoutineTarget.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
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
const mailWork = ThreadId.make("thread:mail-work");
const refusedThread = ThreadId.make("thread:refused");
const removedCreator = ThreadId.make("thread:removed-creator");
const mailRoutine = ScheduledTaskId.make("routine:mail");
const workRoutine = ScheduledTaskId.make("routine:work");
const plainSchedule = ScheduledTaskId.make("schedule:plain");
const mailMadeSchedule = ScheduledTaskId.make("schedule:mail-made");
const removedCreatorSchedule = ScheduledTaskId.make("schedule:removed-creator");
const mailBot = BotId.make("mail");
const ownerOf = new Map([
  [mailHome, mailBot],
  [mailWork, mailBot],
  [workHome, BotId.make("work")],
]);
const scheduledTasks = [
  { id: mailRoutine, bot: { botId: mailBot } },
  { id: workRoutine, bot: { botId: BotId.make("work") } },
  { id: plainSchedule },
  { id: mailMadeSchedule },
  { id: removedCreatorSchedule },
];
const call = (
  name: string,
  params: unknown,
  callerThread: ThreadId | null = caller,
  scheduler?: ScheduledTasks.ScheduledTaskService["Service"],
) =>
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
                thread:
                  callerThread === null
                    ? undefined
                    : {
                        threadId: callerThread,
                        providerSessionId: "provider:caller",
                        providerInstanceId: ProviderInstanceId.make("codex"),
                      },
                client:
                  callerThread === null
                    ? {
                        sessionId: "approved-test-client",
                        label: "Test client",
                        access: "full-access",
                      }
                    : undefined,
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
              scheduler === undefined
                ? Layer.mock(ScheduledTasks.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: scheduledTasks } as never),
                    creatorOf: (id) =>
                      Effect.succeed(
                        id === mailMadeSchedule
                          ? mailHome
                          : id === removedCreatorSchedule
                            ? removedCreator
                            : null,
                      ),
                    runNow: ({ id }, options) =>
                      Effect.gen(function* () {
                        const task = scheduledTasks.find((entry) => entry.id === id);
                        yield* (
                          options?.authorize?.({
                            id,
                            botId: task?.bot?.botId,
                            createdByThreadId:
                              id === mailMadeSchedule
                                ? mailHome
                                : id === removedCreatorSchedule
                                  ? removedCreator
                                  : null,
                          }) ?? Effect.void
                        );
                        return yield* reach(
                          "runNow",
                          new ScheduledTaskError({ message: "runNow" }),
                        );
                      }),
                  })
                : Layer.succeed(ScheduledTasks.ScheduledTaskService, scheduler),
              Layer.mock(BotService.BotService)({
                writeOwnerOfThread: (threadId) =>
                  threadId === refusedThread
                    ? Effect.fail(new BotError({ message: "Cannot resolve the parent thread." }))
                    : Effect.succeed(ownerOf.get(threadId)),
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
  ["run_scheduled_task_now", { taskId: mailRoutine }, "reached", mailWork],
  ["run_scheduled_task_now", { taskId: mailMadeSchedule }, "reached", mailWork],
  ["run_scheduled_task_now", { taskId: workRoutine }, "capability_denied", mailWork],
  ["run_scheduled_task_now", { taskId: plainSchedule }, "capability_denied", mailWork],
  ["run_scheduled_task_now", { taskId: removedCreatorSchedule }, "capability_denied", mailWork],
  ["run_scheduled_task_now", { taskId: mailRoutine }, "invalid_request", refusedThread],
  ["run_scheduled_task_now", { taskId: workRoutine }, "reached", null],
  [
    "run_scheduled_task_now",
    { taskId: mailRoutine, environmentId: EnvironmentId.make("environment:peer") },
    "orchestration_error",
  ],
  [
    "run_scheduled_task_now",
    { taskId: mailRoutine, environmentId: EnvironmentId.make("environment:peer") },
    "capability_denied",
    mailWork,
  ],
] as const)("%s %o: %s", ([name, params, expected, callerThread]) =>
  call(name, params, callerThread).pipe(
    Effect.map((result) => expect(outcome(result)).toBe(expected)),
  ),
);

it.effect("refuses Run now after a client saves a new routine owner", () =>
  Effect.gen(function* () {
    const modelSelection = { instanceId: codex, model: "test-model" };
    const admitted = yield* Ref.make<ReadonlyArray<BotId>>([]);
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.succeed(BotRoutineTarget, {
        requireRunnable: () => Effect.succeed({ modelSelection }),
        admit: ({ botId }) =>
          Ref.update(admitted, (owners) => [...owners, botId]).pipe(
            Effect.as({ _tag: "skipped" as const, reason: "Fixture" }),
          ),
      }),
    );
    yield* Effect.gen(function* () {
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const input = {
        commandId: CommandId.make("review:routine-owner-change"),
        title: "Daily summary",
        prompt: "Summarize today's work.",
        enabled: true,
        schedule: { type: "interval", everyMs: 3_600_000 },
        projectId: ProjectId.make("project:mcp-test"),
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        bot: { botId: mailBot },
      } as const;
      const { task } = yield* scheduler.upsert(input);
      const newOwner = BotId.make("work");
      const result = yield* call("run_scheduled_task_now", { taskId: task.id }, mailWork, {
        ...scheduler,
        list: () =>
          scheduler.list().pipe(
            Effect.tap(() =>
              scheduler.upsert({
                ...input,
                id: task.id,
                requireExisting: true,
                bot: { botId: newOwner },
              }),
            ),
          ),
      });
      expect({ result: outcome(result) ?? "done", admitted: yield* Ref.get(admitted) }).toEqual({
        result: "capability_denied",
        admitted: [],
      });
    }).pipe(Effect.provide(ScheduledTasks.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
