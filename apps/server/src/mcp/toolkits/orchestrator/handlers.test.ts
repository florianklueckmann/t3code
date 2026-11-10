import { expect, it } from "@effect/vitest";
import {
  BotId,
  EnvironmentId,
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
const mailBot = BotId.make("mail-bot");
const workBot = BotId.make("work-bot");
const mailRoutine = ScheduledTaskId.make("routine:mail");
const workRoutine = ScheduledTaskId.make("routine:work");
const plainSchedule = ScheduledTaskId.make("schedule:plain");
const owners = new Map([
  [mailRoutine, mailBot],
  [workRoutine, workBot],
]);
const once = { type: "once", runAt: "2026-12-01T09:00:00Z" } as const;

/** Runs one tool call as a thread whose line belongs to `accessOf`; returns what reached the service. */
const call = (name: string, params: unknown, accessOf: McpCallerBot.McpCallerBotValue) =>
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
                getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
              }),
              layerCallerChangesAllowed,
              Layer.succeed(McpCallerBot.McpCallerBot, {
                forThread: () => Effect.succeed(accessOf),
              }),
              Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
                scheduleTask: () => reach("scheduleTask"),
                updateScheduledTask: () => reach("updateScheduledTask"),
                scheduledTaskBot: (id) => Effect.succeed(owners.get(id)),
                createThreads: () => reach("createThreads"),
                delegateTask: () => reach("delegateTask"),
              }),
              Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
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
] as const)("%s %o from %o: %s", ([name, params, accessOf, expected]) =>
  call(name, params, accessOf).pipe(Effect.map((result) => expect(outcome(result)).toBe(expected))),
);
