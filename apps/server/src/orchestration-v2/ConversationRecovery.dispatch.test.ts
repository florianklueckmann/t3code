import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2FreshConversationPreparation,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

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
        { name: "conversation-recovery" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const threadId = ThreadId.make("thread:conversation-recovery");
const workerId = "test-worker";
const summarizeEffectId = (commandId: string) =>
  `effect:${commandId}:conversation-recovery.summarize`;

const send = (text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${text}`),
      threadId,
      messageId: MessageId.make(`message:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

/** Claims the next effect and settles it, as the worker would once it finished. */
const runNextEffect = Effect.gen(function* () {
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const claimed = yield* outbox.claimNext({ workerId });
  if (Option.isSome(claimed)) yield* outbox.succeed({ effectId: claimed.value.id, workerId });
  return Option.map(claimed, (effect) => effect.request.type);
});

/** A thread whose one run completed on a loaded native conversation, with no effect pending. */
const setupIdleThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId: ProjectId.make("project:conversation-recovery"),
    title: "Recovery",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* send("first");
  assert.deepEqual(yield* runNextEffect, Option.some("provider-turn.start"));
  const projection = yield* orchestrator.getThreadProjection(threadId);
  const now = yield* DateTime.now;
  let sequence = 0;
  const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "threadId">) =>
    projections.apply({
      ...event,
      id: EventId.make(`event:setup:${sequence++}`),
      threadId,
    } as OrchestrationV2DomainEvent);
  const run = projection.runs[0]!;
  yield* apply({
    type: "run.updated",
    runId: run.id,
    occurredAt: now,
    payload: { ...run, status: "completed", startedAt: now, completedAt: now },
  });
  yield* apply({
    type: "provider-thread.updated",
    occurredAt: now,
    payload: {
      ...projection.providerThreads[0]!,
      nativeThreadRef: { driver: adapter.driver, nativeId: "native-thread", strength: "strong" },
    },
  });
});

const startFresh = (commandId: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.conversation.recover",
      commandId: CommandId.make(commandId),
      threadId,
      mode: "fresh",
    });
  });

const record = (requestId: string, prepared: OrchestrationV2FreshConversationPreparation) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.conversation.summary.record",
      commandId: CommandId.make(`${requestId}:summary-record:${prepared.type}`),
      threadId,
      requestId: CommandId.make(requestId),
      prepared,
    });
  });

const freshState = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projection = yield* orchestrator.getThreadProjection(threadId);
  return {
    recovery: projection.providerThreads[0]?.conversationRecovery,
    notices: projection.turnItems.flatMap((item) =>
      item.type === "system_notice"
        ? [{ level: item.level, message: item.message, detail: item.detail }]
        : [],
    ),
  };
});

const summary = { type: "summary", summary: { text: "## Goals", throughRunOrdinal: 1 } } as const;

it.effect("a fresh start prepares its summary once, and the next turn starts after it", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    yield* setupIdleThread;

    yield* startFresh("fresh-1");
    yield* startFresh("fresh-2");

    assert.deepEqual(
      (yield* outbox.listByCommandId(CommandId.make("fresh-1"))).map((effect) => effect.id),
      [summarizeEffectId("fresh-1")],
    );
    assert.deepEqual(yield* outbox.listByCommandId(CommandId.make("fresh-2")), []);
    const preparing = yield* freshState;
    assert.deepEqual(preparing.recovery, { type: "fresh", requestId: CommandId.make("fresh-1") });
    assert.deepEqual(preparing.notices.length, 1);
    assert.equal(preparing.notices[0]?.level, "info");
    assert.match(preparing.notices[0]!.message, /^Preparing a summary/);

    // A message sent meanwhile waits: its start is not claimable while the summary runs.
    const claimed = yield* outbox.claimNext({ workerId });
    assert.equal(Option.getOrUndefined(claimed)?.id, summarizeEffectId("fresh-1"));
    yield* send("second");
    assert.isTrue(Option.isNone(yield* outbox.claimNext({ workerId })));
    // Clicking again while that message waits joins the same fresh start.
    yield* startFresh("fresh-3");
    assert.deepEqual(yield* outbox.listByCommandId(CommandId.make("fresh-3")), []);
    yield* record("fresh-1", summary);
    yield* outbox.succeed({ effectId: summarizeEffectId("fresh-1"), workerId });
    assert.deepEqual(yield* runNextEffect, Option.some("provider-turn.start"));

    const ready = yield* freshState;
    assert.deepEqual(ready.recovery, {
      type: "fresh",
      requestId: CommandId.make("fresh-1"),
      prepared: summary,
    });
    assert.deepEqual(ready.notices, [
      {
        level: "info",
        message:
          "The summary is ready. Your next message starts a fresh conversation with a summary of this thread.",
        detail: "## Goals",
      },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a failed summary records a warning, and starting fresh again prepares a new one", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    yield* setupIdleThread;
    yield* startFresh("fresh-1");
    assert.deepEqual(yield* runNextEffect, Option.some("conversation-recovery.summarize"));

    yield* record("fresh-1", { type: "failed", reason: "model unavailable" });
    const failed = yield* freshState;
    assert.equal(failed.notices[0]?.level, "warning");
    assert.match(failed.notices[0]!.message, /\(model unavailable\)/);

    yield* startFresh("fresh-2");
    assert.deepEqual(
      (yield* outbox.listByCommandId(CommandId.make("fresh-2"))).map((effect) => effect.id),
      [summarizeEffectId("fresh-2")],
    );
    // The retried fresh start no longer takes the first one's late result.
    yield* record("fresh-1", summary);
    assert.deepEqual((yield* freshState).recovery, {
      type: "fresh",
      requestId: CommandId.make("fresh-2"),
    });
  }).pipe(Effect.provide(layerTest)),
);

const switched = ProviderThreadId.make("provider-thread:switched");
/** Another provider takes over the thread, as a message sent through it would. */
const switchProvider = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const before = yield* orchestrator.getThreadProjection(threadId);
  yield* projections.apply({
    id: EventId.make("event:switch"),
    type: "provider-thread.updated",
    threadId,
    occurredAt: yield* DateTime.now,
    payload: { ...before.providerThreads[0]!, id: switched, conversationRecovery: undefined },
  } as OrchestrationV2DomainEvent);
});

const retiredNotice = {
  level: "info" as const,
  message: "Your next message starts a fresh conversation with a summary of this thread.",
  detail: undefined,
};

it.effect("archiving after another provider took over retires the earlier fresh start", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* setupIdleThread;
    yield* startFresh("fresh-1");
    yield* switchProvider;

    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId,
    });

    assert.deepEqual((yield* freshState).notices, [retiredNotice]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a summary finished after another provider took over leaves that provider active", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* setupIdleThread;
    yield* startFresh("fresh-1");
    yield* switchProvider;

    yield* record("fresh-1", summary);

    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(after.thread.activeProviderThreadId, switched);
    assert.deepEqual((yield* freshState).notices, [retiredNotice]);

    // Archiving retires the active provider's fresh start, not the older one left behind.
    yield* startFresh("fresh-2");
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId,
    });
    const archived = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(
      archived.providerThreads.find((candidate) => candidate.id === switched)?.conversationRecovery,
      { type: "fresh" },
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.archive", "thread.delete"] as const)(
  "%s cancels a summary in preparation and drops its late result",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* setupIdleThread;
      yield* startFresh("fresh-1");
      yield* outbox.claimNext({ workerId });

      yield* orchestrator.dispatch({ type, commandId: CommandId.make(type), threadId });
      yield* record("fresh-1", summary);

      const effect = yield* outbox.get(summarizeEffectId("fresh-1"));
      assert.equal(Option.getOrUndefined(effect)?.status, "cancelled");
      if (type === "thread.archive") {
        // The fresh start stays, and its next turn summarizes as it did before preparation.
        const archived = yield* freshState;
        assert.deepEqual(archived.recovery, { type: "fresh" });
        assert.deepEqual(archived.notices, [retiredNotice]);
        yield* orchestrator.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("unarchive"),
          threadId,
        });
        yield* startFresh("fresh-2");
        assert.deepEqual(
          (yield* outbox.listByCommandId(CommandId.make("fresh-2"))).map((effect) => effect.id),
          [summarizeEffectId("fresh-2")],
        );
      }
    }).pipe(Effect.provide(layerTest)),
);
