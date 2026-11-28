import * as NodeServices from "@effect/platform-node/NodeServices";
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
  TurnItemId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProviderTurn,
  type RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionReplay from "../orchestration-v2/testkit/ProjectionReplay.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { deriveTaskStatus, taskStop } from "./BotTaskService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const makeAdapter = (interruptEntered?: Deferred.Deferred<void>) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: ({ providerSessionId, runtimePolicy }) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver: ProviderDriverKind.make("codex"),
          providerSessionId,
          providerSession: {
            id: providerSessionId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: instanceId,
            status: "ready",
            cwd: runtimePolicy.cwd,
            model: modelSelection.model,
            capabilities: providerSessionId.endsWith(":no-interrupt")
              ? {
                  ...CodexProviderCapabilitiesV2,
                  turns: { ...CodexProviderCapabilitiesV2.turns, supportsInterrupt: false },
                }
              : CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          interruptTurn: ({
            providerThread,
            providerTurnId,
          }: ProviderAdapter.ProviderAdapterV2InterruptInput) => {
            if (interruptEntered !== undefined) {
              return Deferred.succeed(interruptEntered, undefined).pipe(
                Effect.andThen(Effect.never),
              );
            }
            const target = {
              driver: ProviderDriverKind.make("codex"),
              providerThreadId: providerThread.id,
              providerTurnId,
            };
            return Effect.fail(
              providerSessionId.endsWith(":explicit-timeout")
                ? new ProviderAdapter.ProviderAdapterInterruptTimeoutError({
                    ...target,
                    timeoutMs: 1000,
                  })
                : new ProviderAdapter.ProviderAdapterInterruptError({
                    ...target,
                    cause: "fixture transport failure",
                  }),
            );
          },
          ...(providerSessionId.endsWith(":partial-background")
            ? { hasPendingBackgroundWorkForThread: () => Effect.succeed(true) }
            : {}),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];
const makeLayerTest = (
  database:
    | ReturnType<typeof SqlitePersistence.layerFromPath>
    | typeof SqlitePersistence.layerMemory,
  adapter = makeAdapter(),
) => {
  const layerDatabase = database.pipe(Layer.provide(NodeServices.layer));
  return ThreadManagementService.layer.pipe(
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
    Layer.provideMerge(ProjectionMaintenance.layer.pipe(Layer.provide(layerDatabase))),
  );
};
const layerTest = makeLayerTest(SqlitePersistence.layerMemory);

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
const reach = (
  threadId: ThreadId,
  state: "completed" | "background" | "running" | "unanswering",
  liveSessionId?: ProviderSessionId,
  persist = false,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const run = projection.runs.at(-1)!;
    const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId)!;
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === run.providerThreadId,
    )!;
    const now = yield* DateTime.now;
    let sequence = 0;
    const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "threadId">) => {
      const domainEvent = {
        ...event,
        id: EventId.make(`event:${run.id}:${sequence++}`),
        threadId,
      } as OrchestrationV2DomainEvent;
      return persist
        ? sink.write({ events: [domainEvent] }).pipe(Effect.asVoid)
        : projections.apply(domainEvent).pipe(Effect.asVoid);
    };
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
          liveSessionId ??
          (state === "running"
            ? ProviderSessionId.make("session:gone")
            : providerThread.providerSessionId),
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
    name: "a later user Stop preserves the Bot's background cancellation",
    run: "background",
    anotherStop: true,
    expected: "cancelled",
  },
  {
    name: "background work that finishes before the stop takes effect keeps its result",
    run: "background",
    finishesNaturally: true,
    expected: "completed",
  },
  {
    name: "a completed follow-up survives an earlier background stop",
    run: "background",
    completedFollowUp: true,
    expected: "completed",
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
    name: "an unanswered Bot cancel still offers Force stop after a later user Stop",
    run: "unanswering",
    anotherStop: true,
    expected: "running",
    unanswered: true,
  },
  {
    name: "background work of a follow-up run started after the Bot read the thread reads as cancelled",
    run: "background",
    followUp: true,
    expected: "cancelled",
  },
] as const)(
  "$name",
  ({
    run,
    followUp = false,
    expected,
    unanswered = false,
    anotherStop = false,
    finishesNaturally = false,
    completedFollowUp = false,
  }) =>
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
      let liveSessionId: ProviderSessionId | undefined;
      if (anotherStop || finishesNaturally) {
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        liveSessionId = ProviderSessionId.make(`session:${threadId}`);
        yield* sessions.open({
          threadId,
          providerSessionId: liveSessionId,
          modelSelection,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          },
        });
      }
      const readRunId = yield* reach(threadId, followUp ? "completed" : run, liveSessionId);
      if (followUp) {
        yield* send(threadId, "follow-up");
        yield* reach(threadId, run);
      }

      // As the Bot stops its work thread: keyed to the run it read, whichever run Stop reaches.
      const cancelCommand = {
        type: "thread.stop" as const,
        commandId: CommandId.make(`bot-task-cancel:${task.task_id}:${readRunId}`),
        threadId,
        reason: "Cancelled by the user.",
      };
      yield* orchestrator.dispatch(cancelCommand);
      const first = yield* readTaskStatus(threadId);
      if (completedFollowUp) {
        assert.equal(first.status, "cancelled");
        yield* send(threadId, "later follow-up");
        yield* reach(threadId, "completed");
      }
      if (anotherStop) {
        assert.equal(first.status, "running");
        assert.equal(first.stop?.reached, unanswered ? "run" : "background");
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`user-stop:${threadId}`),
          threadId,
        });
        if (!unanswered) {
          yield* orchestrator.dispatch({
            type: "thread.background-work.settle",
            commandId: CommandId.make(`confirm:${threadId}`),
            threadId,
            providerThreadId: first.stop!.providerThreadId!,
            providerTurnId: first.stop!.providerTurnId!,
          });
        }
      }
      if (finishesNaturally) {
        assert.equal(first.status, "running");
        assert.equal(first.stop?.reached, "background");
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const owner = projection.providerThreads.find(
          (pt) => pt.id === first.stop!.providerThreadId,
        )!;
        const now = yield* DateTime.now;
        yield* projections.apply({
          id: EventId.make(`event:${readRunId}:background-completed`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: { ...owner, pendingBackgroundTasks: [], updatedAt: now },
        });
      }
      if (unanswered) {
        // What the effect worker records when the provider does not confirm the stop in time.
        yield* orchestrator.dispatch({
          type: "thread.interrupt.unresponsive",
          commandId: CommandId.make(`unresponsive:${threadId}`),
          threadId,
          providerThreadId: first.stop!.providerThreadId!,
          providerTurnId: first.stop!.providerTurnId!,
        });
        if (anotherStop) yield* orchestrator.dispatch(cancelCommand);
      }
      const { stop, status } = yield* readTaskStatus(threadId);
      assert.equal(status, expected);
      assert.equal(stop?.unresponsiveAt !== undefined, unanswered);
    }).pipe(Effect.provide(layerTest)),
);

const reviewThread = (
  name: string,
  options?: { readonly cannotInterrupt?: boolean; readonly persist?: boolean },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const threadId = ThreadId.make(`thread:review:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Bot task review",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const sessionId = ProviderSessionId.make(
      `session:${threadId}${options?.cannotInterrupt ? ":no-interrupt" : ""}`,
    );
    yield* sessions.open({
      threadId,
      providerSessionId: sessionId,
      modelSelection,
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: process.cwd() },
    });
    yield* send(threadId, "work");
    const runId = yield* reach(threadId, "background", sessionId, options?.persist);
    const dispatchStop = (key: string) =>
      orchestrator.dispatch({ type: "thread.stop", commandId: CommandId.make(key), threadId });
    const botKey = `bot-task-cancel:${task.task_id}:${runId}`;
    const providerTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns.at(-1)!;
    const settle = () =>
      orchestrator.dispatch({
        type: "thread.background-work.settle",
        commandId: CommandId.make(`settle:${runId}`),
        threadId,
        providerThreadId: providerTurn.providerThreadId,
        providerTurnId: providerTurn.id,
      });
    return { threadId, runId, sessionId, providerTurn, dispatchStop, botKey, settle };
  });

it.effect("review: a Bot cancel can force a run fenced by an earlier user Stop", () =>
  Effect.gen(function* () {
    const { threadId, runId, dispatchStop, botKey } = yield* reviewThread("earlier-fence", {
      cannotInterrupt: true,
    });
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* dispatchStop("user-stop:earlier-fence");
    const fenced = yield* threads.getProjectThreadRecords({ projectId, threadId }, ["turnItems"], {
      turnItemTypes: ["run_interrupt_request"],
    });
    assert.isTrue(
      fenced.turnItems.some(
        (item) => item.type === "run_interrupt_request" && item.unresponsiveAt !== undefined,
      ),
    );
    yield* dispatchStop(botKey);
    yield* dispatchStop(botKey);
    const { status, stop } = yield* readTaskStatus(threadId);
    assert.equal(status, "running");
    const unanswered = stop?.runId === runId && stop.unresponsiveAt !== undefined;
    assert.isTrue(unanswered, "the Bot card needs the unanswered run to offer Force stop");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("review: ordinary Stops stay bounded on the same run", () =>
  Effect.gen(function* () {
    const { threadId, sessionId, dispatchStop, botKey } = yield* reviewThread("bounded-stops");
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* send(threadId, "follow-up before Stop");
    const reachedRun = yield* reach(threadId, "background", sessionId);
    const secondBotKey = `bot-task-cancel:${task.task_id}:${reachedRun}`;
    yield* dispatchStop(botKey);
    yield* dispatchStop(botKey);
    yield* dispatchStop(secondBotKey);
    const own = (yield* readTaskStatus(threadId)).stop;
    assert.equal(own?.runId, reachedRun);
    // One attribution per run: the Bot's latest Stop of it, which ordinary Stops keep.
    const attribution = { commandId: CommandId.make(secondBotKey), reached: "background" as const };
    assert.deepEqual(own?.attributedStop, attribution);
    for (let index = 0; index < 32; index++) {
      yield* dispatchStop(`user-stop:bounded:${index}`);
    }
    const records = yield* threads.getProjectThreadRecords({ projectId, threadId }, ["turnItems"], {
      turnItemTypes: ["run_interrupt_request"],
    });
    const request = records.turnItems.find(
      (item) => item.type === "run_interrupt_request" && item.runId === reachedRun,
    );
    assert.deepEqual(
      request?.type === "run_interrupt_request" && request.attributedStop,
      attribution,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("review: a follow-up that starts before settlement keeps its completed result", () =>
  Effect.gen(function* () {
    const { threadId, dispatchStop, botKey, settle, runId, providerTurn } =
      yield* reviewThread("follow-up-before-settle");
    yield* addBackgroundCommand(threadId, runId, providerTurn);
    yield* dispatchStop(botKey);
    assert.equal((yield* readTaskStatus(threadId)).status, "running");
    yield* send(threadId, "new result");
    const followUp = yield* reach(threadId, "completed");
    assert.notEqual(followUp, runId);
    yield* settle();
    const { status, stop } = yield* readTaskStatus(threadId);
    assert.equal(stop?.runId, runId);
    assert.isDefined(stop?.backgroundStoppedAt);
    assert.equal(status, "completed");
  }).pipe(Effect.provide(layerTest)),
);

const addBackgroundCommand = (
  threadId: ThreadId,
  runId: RunId,
  providerTurn: OrchestrationV2ProviderTurn,
) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const command = {
      id: TurnItemId.make(`item:${runId}:retained-command`),
      threadId,
      runId,
      nodeId: providerTurn.nodeId,
      providerThreadId: providerTurn.providerThreadId,
      providerTurnId: providerTurn.id,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 100,
      status: "running",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "fixture background command",
    } satisfies OrchestrationV2TurnItem;
    yield* projections.apply({
      id: EventId.make(`event:${runId}:command-running`),
      type: "turn-item.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: command,
    });
    return command;
  });

it.effect.each(["completed", "interrupted"] as const)(
  "review: provider reports a background command %s before stop settlement",
  (outcome) =>
    Effect.gen(function* () {
      const { threadId, runId, providerTurn, dispatchStop, botKey, settle } = yield* reviewThread(
        `early-provider-event:${outcome}`,
      );
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const provider = (yield* orchestrator.getThreadProjection(threadId)).providerThreads.find(
        (owner) => owner.id === providerTurn.providerThreadId,
      )!;
      const now = yield* DateTime.now;
      // Codex tracks its retained commands as turn items.
      yield* projections.apply({
        id: EventId.make(`event:${runId}:item-only`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: { ...provider, pendingBackgroundTasks: [], updatedAt: now },
      });
      const command = yield* addBackgroundCommand(threadId, runId, providerTurn);
      yield* dispatchStop(botKey);
      const before = yield* readTaskStatus(threadId);
      assert.equal(before.status, "running");
      assert.equal(before.stop?.reached, "background");
      yield* projections.apply({
        id: EventId.make(`event:${runId}:command-ended`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: { ...command, status: outcome, completedAt: now },
      });
      yield* settle();
      assert.equal(
        (yield* readTaskStatus(threadId)).status,
        outcome === "interrupted" ? "cancelled" : "completed",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("review: SQLite replay, pruning and reopen preserve Stop outcomes and receipts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stop-review-" });
    const database = SqlitePersistence.layerFromPath(path.join(dir, "statev2.sqlite"));
    const layer = makeLayerTest(database).pipe(Layer.provide(NodeServices.layer));
    const { threadId, botKey, before } = yield* Effect.gen(function* () {
      const { threadId, dispatchStop, botKey, settle, runId } = yield* reviewThread(
        "prune-reopen",
        {
          persist: true,
        },
      );
      const sink = yield* EventSink.EventSinkV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* dispatchStop("user-stop:legacy-payload");
      const current = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
        (item) => item.type === "run_interrupt_request",
      )!;
      const { attributedStop: _attributedStop, ...oldPayload } = current;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:${runId}:old-stop-payload`),
            type: "turn-item.updated",
            threadId,
            runId,
            occurredAt: yield* DateTime.now,
            payload: oldPayload,
          },
        ],
      });
      yield* dispatchStop(botKey);
      yield* settle();
      const before = yield* readTaskStatus(threadId);
      assert.equal(before.status, "cancelled");
      assert.equal(before.stop?.attributedStop?.commandId, botKey);
      assert.isDefined(before.stop?.backgroundStoppedAt);
      const oracle = yield* ProjectionReplay.ProjectionReplay;
      const rebuilt = yield* oracle.rebuild;
      assert.isTrue(rebuilt.valid);
      assert.deepEqual(yield* readTaskStatus(threadId), before);

      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* maintenance.pruneEventStore();
      yield* TestClock.adjust("24 hours");
      assert.isAbove((yield* maintenance.pruneEventStore()).deletedEventCount, 0);
      return { threadId, botKey, before };
    }).pipe(Effect.provide(ProjectionReplay.layer.pipe(Layer.provideMerge(layer))));
    yield* Effect.gen(function* () {
      assert.deepEqual(yield* readTaskStatus(threadId), before);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.stop",
        threadId,
        commandId: CommandId.make(botKey),
      });
      assert.deepEqual(yield* readTaskStatus(threadId), before);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("review: a second Stop preserves an already recorded background interruption", () =>
  Effect.gen(function* () {
    const { threadId, runId, providerTurn, dispatchStop, botKey, settle } =
      yield* reviewThread("partial-background");
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* addBackgroundCommand(threadId, runId, providerTurn);
    yield* dispatchStop(botKey);
    yield* settle();
    const partial = yield* readTaskStatus(threadId);
    assert.equal(partial.status, "running");
    assert.isDefined(partial.stop?.backgroundStoppedAt);

    yield* dispatchStop("user-stop:after-partial-settlement");
    const provider = (yield* orchestrator.getThreadProjection(threadId)).providerThreads.find(
      (owner) => owner.id === providerTurn.providerThreadId,
    )!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:${runId}:remaining-work-finished`),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: { ...provider, pendingBackgroundTasks: [], updatedAt: now },
    });
    assert.equal((yield* readTaskStatus(threadId)).status, "cancelled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("review: old settlement leaves a live follow-up working", () =>
  Effect.gen(function* () {
    const { threadId, sessionId, runId, providerTurn, dispatchStop, botKey, settle } =
      yield* reviewThread("live-follow-up-before-settle");
    yield* addBackgroundCommand(threadId, runId, providerTurn);
    yield* dispatchStop(botKey);
    yield* send(threadId, "follow-up already running");
    const followUp = yield* reach(threadId, "unanswering", sessionId);
    assert.notEqual(followUp, runId);
    yield* settle();
    const { status, stop } = yield* readTaskStatus(threadId);
    assert.equal(status, "running");
    assert.equal(stop?.runId, runId);
    assert.isUndefined(stop?.backgroundStoppedAt);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("review: a tagged provider timeout exposes Force stop through the effect worker", () =>
  Effect.gen(function* () {
    const { threadId, botKey, dispatchStop } = yield* reviewThread("explicit-timeout");
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* outbox.cancelUnsettled({
      threadId,
      effectTypes: ["provider-turn.start"],
      reason: "fixture has already projected the run",
    });
    yield* dispatchStop(botKey);
    yield* worker.drain();
    const { status, stop } = yield* readTaskStatus(threadId);
    assert.equal(status, "running");
    assert.isDefined(stop?.unresponsiveAt);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("review: an interrupt that never returns exposes Force stop", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { threadId, botKey, dispatchStop } = yield* reviewThread("interrupt-never-returns");
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["provider-turn.start"],
        reason: "fixture has already projected the run",
      });
      yield* dispatchStop(botKey);
      const drain = yield* worker.drain().pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(ProviderSessionManager.PROVIDER_INTERRUPT_TIMEOUT_MS);
      yield* Fiber.join(drain);
      yield* dispatchStop(botKey);
      const effects = yield* outbox.listByCommandId(CommandId.make(botKey));
      assert.equal(
        effects.find((effect) => effect.request.type === "provider-turn.interrupt")?.status,
        "succeeded",
      );
      const { status, stop } = yield* readTaskStatus(threadId);
      assert.equal(status, "running");
      assert.isDefined(
        stop?.unresponsiveAt,
        "the Bot card needs Force stop when an adapter never returns",
      );
    }).pipe(Effect.provide(makeLayerTest(SqlitePersistence.layerMemory, makeAdapter(entered))));
  }),
);
