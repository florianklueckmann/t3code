import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { deriveTaskStatus, taskStop } from "./BotTaskService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "bot-task-stop" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const projectId = ProjectId.make("project:bot-task-stop");
const task = { task_id: "bot-task:stop" };

const send = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

/**
 * Moves the thread's latest run where its provider would have taken it. `unanswering` is a turn
 * Stop cannot interrupt; `running` one whose provider already ended its turn, so Stop ends it.
 */
const reach = (threadId: ThreadId, state: "completed" | "background" | "running" | "unanswering") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const run = projection.runs.at(-1)!;
    const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId)!;
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === run.providerThreadId,
    )!;
    const now = yield* DateTime.now;
    let sequence = 0;
    const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "threadId">) =>
      projections.apply({
        ...event,
        id: EventId.make(`event:${run.id}:${sequence++}`),
        threadId,
      } as OrchestrationV2DomainEvent);
    const ended = state === "completed" || state === "background";
    yield* apply({
      type: "run.updated",
      runId: run.id,
      occurredAt: now,
      payload: {
        ...run,
        status: ended ? "completed" : "running",
        startedAt: now,
        completedAt: ended ? now : null,
      },
    });
    if (state !== "unanswering") {
      yield* apply({
        type: "run-attempt.updated",
        occurredAt: now,
        payload: { ...attempt, status: "completed", startedAt: now, completedAt: now },
      });
    }
    yield* apply({
      type: "provider-turn.updated",
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make(`provider-turn:${run.id}`),
        providerThreadId: providerThread.id,
        nodeId: run.rootNodeId!,
        runAttemptId: attempt.id,
        nativeTurnRef: null,
        ordinal: run.ordinal,
        status: state === "unanswering" ? "running" : "completed",
        startedAt: now,
        completedAt: state === "unanswering" ? null : now,
      },
    });
    yield* apply({
      type: "provider-thread.updated",
      occurredAt: now,
      payload: {
        ...providerThread,
        status: "idle",
        lastRunOrdinal: run.ordinal,
        // The provider session is gone, so Stop settles what it reached at once.
        providerSessionId:
          state === "running"
            ? ProviderSessionId.make("session:gone")
            : providerThread.providerSessionId,
        pendingBackgroundTasks:
          state === "background" ? [{ taskId: `background:${run.id}`, kind: "command" }] : [],
      },
    });
    return run.id;
  });

const readTaskStatus = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const records = yield* threads.getProjectThreadRecords({ projectId, threadId }, ["turnItems"], {
      turnItemTypes: ["run_interrupt_request"],
    });
    const stop = taskStop(task, records.turnItems);
    const shell = yield* threads.getThreadShell(threadId);
    return { stop, status: deriveTaskStatus({ cancelRequested: true, stop, shell }) };
  });

it.effect.each([
  {
    name: "a result that finished before the stop stays completed",
    run: "completed",
    expected: "completed",
  },
  {
    name: "background work the stop ended after the run finished reads as cancelled",
    run: "background",
    expected: "cancelled",
  },
  {
    name: "a running run the stop interrupted reads as cancelled",
    run: "running",
    expected: "cancelled",
  },
  {
    name: "a run that did not answer the stop keeps working and says so",
    run: "unanswering",
    expected: "running",
    unanswered: true,
  },
  {
    name: "background work of a follow-up run started after the Bot read the thread reads as cancelled",
    run: "background",
    followUp: true,
    expected: "cancelled",
  },
] as const)("$name", ({ run, followUp = false, expected, unanswered = false }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:bot-task-stop:${run}:${followUp}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Bot task",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* send(threadId, "work");
    const readRunId = yield* reach(threadId, followUp ? "completed" : run);
    if (followUp) {
      yield* send(threadId, "follow-up");
      yield* reach(threadId, run);
    }

    // As the Bot stops its work thread: keyed to the run it read, whichever run Stop reaches.
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(`bot-task-cancel:${task.task_id}:${readRunId}`),
      threadId,
      reason: "Cancelled by the user.",
    });
    if (unanswered) {
      // What the effect worker records when the provider does not confirm the stop in time.
      const { stop } = yield* readTaskStatus(threadId);
      yield* orchestrator.dispatch({
        type: "thread.interrupt.unresponsive",
        commandId: CommandId.make(`unresponsive:${threadId}`),
        threadId,
        providerThreadId: stop!.providerThreadId!,
        providerTurnId: stop!.providerTurnId!,
      });
    }
    const { stop, status } = yield* readTaskStatus(threadId);
    assert.equal(status, expected);
    assert.equal(stop?.unresponsiveAt !== undefined, unanswered);
  }).pipe(Effect.provide(layerTest)),
);
