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
import * as McpCallerBot from "../../McpCallerBot.ts";
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
const lostThread = ThreadId.make("thread:lost");
const mailBot = BotId.make("mail-bot");
const workBot = BotId.make("work-bot");
const lines = new Map<ThreadId, McpCallerBot.McpCallerBotValue>([
  [mailHome, { _tag: "bot", botId: mailBot }],
  [workHome, { _tag: "bot", botId: workBot }],
  [plainThread, { _tag: "none" }],
  [lostThread, { _tag: "unknown" }],
]);
const mailRoutine = ScheduledTaskId.make("routine:mail");
const workRoutine = ScheduledTaskId.make("routine:work");
const plainSchedule = ScheduledTaskId.make("schedule:plain");
const owners = new Map([
  [mailRoutine, mailBot],
  [workRoutine, workBot],
]);
const once = { type: "once", runAt: "2026-12-01T09:00:00Z" } as const;

/**
 * Runs one tool call as a thread whose line belongs to `accessOf`, or with no `McpCallerBot`
 * provided when "unprovided"; returns what reached the service.
 */
const call = (
  name: string,
  params: unknown,
  accessOf: McpCallerBot.McpCallerBotValue | "unprovided",
) =>
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
              accessOf === "unprovided"
                ? Layer.empty
                : Layer.succeed(McpCallerBot.McpCallerBot, {
                    forThread: (thread) =>
                      Effect.succeed(
                        thread.id === threadId
                          ? accessOf
                          : (lines.get(thread.id) ?? { _tag: "none" }),
                      ),
                  }),
              Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
                scheduleTask: () => reach("scheduleTask"),
                updateScheduledTask: () => reach("updateScheduledTask"),
                deleteScheduledTask: () => reach("deleteScheduledTask"),
                scheduledTaskBot: (id) => Effect.succeed(owners.get(id)),
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

const ofMailBot = { _tag: "bot", botId: mailBot } as const;
const ordinary = { _tag: "none" } as const;

const threadWrites = [
  ["t3_thread_send", (id: ThreadId) => ({ threadId: id, message: "Check the work account now." })],
  ["t3_thread_interrupt", (id: ThreadId) => ({ threadId: id })],
  ["t3_thread_update", (id: ThreadId) => ({ threadId: id, action: "rename", title: "Renamed" })],
  ["t3_workflow_stop", (id: ThreadId) => ({ threadId: id, subagentId: NodeId.make("node:flow") })],
] as const;

// Another Bot's thread runs with that Bot's grants, so a Bot's line steers only its own. A thread
// of no Bot stays reachable: messaging one is outside the grant promise.
const ownership = [
  [mailHome, ofMailBot, "reached"],
  [workHome, ofMailBot, "capability_denied"],
  [plainThread, ofMailBot, "reached"],
  [lostThread, ofMailBot, "capability_denied"],
  [workHome, ordinary, "reached"],
  [lostThread, ordinary, "reached"],
  [mailHome, { _tag: "unknown" }, "capability_denied"],
] as const;

it.effect.each([
  // New top-level work runs with the user's own MCP servers, so a Bot's line cannot start it.
  ["create_threads", { threads: [{ prompt: "Check mail" }] }, ofMailBot, "capability_denied"],
  ["create_threads", { threads: [{ prompt: "Check mail" }] }, ordinary, "reached"],
  ["schedule_task", { prompt: "Check mail", schedule: once }, ofMailBot, "capability_denied"],
  ["schedule_task", { prompt: "Check mail", schedule: once }, ordinary, "reached"],
  // A routine loads its Bot's grants, so a Bot's line schedules only its own.
  ["schedule_task", { prompt: "Mail", schedule: once, botId: mailBot }, ofMailBot, "reached"],
  [
    "schedule_task",
    { prompt: "Mail", schedule: once, botId: workBot },
    ofMailBot,
    "capability_denied",
  ],
  ["schedule_task", { prompt: "Mail", schedule: once, botId: workBot }, ordinary, "reached"],
  ["schedule_task", { scheduledTaskId: mailRoutine, prompt: "Mail" }, ofMailBot, "reached"],
  [
    "schedule_task",
    { scheduledTaskId: workRoutine, prompt: "Mail" },
    ofMailBot,
    "capability_denied",
  ],
  [
    "schedule_task",
    { scheduledTaskId: plainSchedule, prompt: "Mail" },
    ofMailBot,
    "capability_denied",
  ],
  ["schedule_task", { scheduledTaskId: workRoutine, prompt: "Mail" }, ordinary, "reached"],
  ["delete_scheduled_task", { scheduledTaskId: mailRoutine }, ofMailBot, "reached"],
  ["delete_scheduled_task", { scheduledTaskId: workRoutine }, ofMailBot, "capability_denied"],
  ["delete_scheduled_task", { scheduledTaskId: plainSchedule }, ofMailBot, "capability_denied"],
  ["delete_scheduled_task", { scheduledTaskId: workRoutine }, ordinary, "reached"],
  // Connection ids are this environment's; a delegate here is a subagent with the Bot's grants.
  ["delegate_task", { task: "Check mail" }, ofMailBot, "reached"],
  [
    "delegate_task",
    { task: "Check mail", target: { environmentId: EnvironmentId.make("environment:box") } },
    ofMailBot,
    "capability_denied",
  ],
  [
    "delegate_task",
    { task: "Check mail", target: { environmentId: EnvironmentId.make("environment:box") } },
    ordinary,
    "reached",
  ],
  [
    "create_threads",
    { threads: [{ prompt: "Check mail" }] },
    { _tag: "unknown" },
    "capability_denied",
  ],
  // A lost provide must refuse, not wave Bot work through as ordinary.
  ["create_threads", { threads: [{ prompt: "Check mail" }] }, "unprovided", "capability_denied"],
  ["t3_thread_send", threadWrites[0][1](workHome), "unprovided", "capability_denied"],
  ...threadWrites.flatMap(([name, params]) =>
    ownership.map(
      ([target, accessOf, expected]) => [name, params(target), accessOf, expected] as const,
    ),
  ),
] as const)("%s %o from %o: %s", ([name, params, accessOf, expected]) =>
  call(name, params, accessOf).pipe(Effect.map((result) => expect(outcome(result)).toBe(expected))),
);
