import { expect, it } from "@effect/vitest";
import {
  BotId,
  EnvironmentId,
  NodeId,
  OrchestrationV2StopWorkflowError,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinkRequests from "../../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { layerCallerChangesAllowed, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:here");
const threadId = ThreadId.make("thread:caller");
const mailHome = ThreadId.make("thread:mail-home");
const workHome = ThreadId.make("thread:work-home");
const plainThread = ThreadId.make("thread:plain");
const workBot = BotId.make("work-bot");
const mailRoutine = ScheduledTaskId.make("routine:mail");
const workRoutine = ScheduledTaskId.make("routine:work");
const plainSchedule = ScheduledTaskId.make("schedule:plain");
const once = { type: "once", runAt: "2026-12-01T09:00:00Z" } as const;

const call = (name: string, params: unknown) =>
  Effect.gen(function* () {
    const reached = yield* Ref.make<ReadonlyArray<string>>([]);
    // Recorded, then refused, so no result needs encoding; only reaching the service counts.
    const reach = (method: string) =>
      Ref.update(reached, (current) => [...current, method]).pipe(
        Effect.andThen(
          Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message: method })),
        ),
      );
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* OrchestratorToolkit;
      const results = yield* toolkit
        .handle(name as never, params as never)
        .pipe(Stream.unwrap, Stream.runCollect);
      return results.at(-1)?.result;
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(McpInvocationContext.McpInvocationContext, {
                environmentId,
                requestNamespace: "provider:caller",
                thread: {
                  threadId,
                  providerSessionId: "provider:caller",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                },
                client: undefined,
                capabilities: new Set(["orchestration" as const]),
                issuedAt: 0,
              }),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
                stopWorkflow: (input) =>
                  reach("stopWorkflow").pipe(
                    Effect.mapError(
                      () =>
                        new OrchestrationV2StopWorkflowError({ ...input, reason: "not-running" }),
                    ),
                  ),
              }),
              layerCallerChangesAllowed,
              Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
                scheduleTask: () => reach("scheduleTask"),
                updateScheduledTask: () => reach("updateScheduledTask"),
                deleteScheduledTask: () => reach("deleteScheduledTask"),
                createThreads: () => reach("createThreads"),
                delegateTask: () => reach("delegateTask"),
                sendToThread: () => reach("sendToThread"),
                interruptThread: () => reach("interruptThread"),
              }),
              Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({
                update: () => reach("update"),
              }),
              Layer.mock(PeerLinks.PeerLinks)({}),
              Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
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

const threadWrites = [
  ["t3_thread_send", (id: ThreadId) => ({ threadId: id, message: "Check the work account now." })],
  ["t3_thread_interrupt", (id: ThreadId) => ({ threadId: id })],
  ["t3_thread_update", (id: ThreadId) => ({ threadId: id, action: "rename", title: "Renamed" })],
  ["t3_workflow_stop", (id: ThreadId) => ({ threadId: id, subagentId: NodeId.make("node:flow") })],
] as const;

it.effect.each([
  ["create_threads", { threads: [{ prompt: "Check mail" }] }],
  ["schedule_task", { prompt: "Check mail", schedule: once }],
  ["schedule_task", { prompt: "Mail", schedule: once, botId: workBot }],
  ["schedule_task", { scheduledTaskId: mailRoutine, prompt: "Mail" }],
  ["schedule_task", { scheduledTaskId: workRoutine, prompt: "Mail" }],
  ["schedule_task", { scheduledTaskId: plainSchedule, prompt: "Mail" }],
  ["delete_scheduled_task", { scheduledTaskId: workRoutine }],
  ["delete_scheduled_task", { scheduledTaskId: plainSchedule }],
  ["delegate_task", { task: "Check mail" }],
  [
    "delegate_task",
    { task: "Check mail", target: { environmentId: EnvironmentId.make("environment:box") } },
  ],
  ...threadWrites.flatMap(([name, params]) =>
    [mailHome, workHome, plainThread].map((target) => [name, params(target)] as const),
  ),
] as const)("%s %o reaches its service", ([name, params]) =>
  call(name, params).pipe(Effect.map((result) => expect(outcome(result)).toBe("reached"))),
);
