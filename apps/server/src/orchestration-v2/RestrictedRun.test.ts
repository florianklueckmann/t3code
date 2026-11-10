import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2RunRestriction,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const layerPlatformTest = Layer.merge(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-restricted-run-",
});
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const unused = (name: string) => () => Effect.die(`restricted run tests do not ${name}`);
/** A live session that can steer, so only the restriction keeps input out of a running run. */
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (input) =>
    DateTime.now.pipe(
      Effect.map((now) => ({
        instanceId: modelSelection.instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          status: "ready" as const,
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.never,
        ensureThread: unused("start provider threads"),
        resumeThread: unused("resume provider threads"),
        startTurn: unused("start turns"),
        steerTurn: unused("steer"),
        interruptTurn: unused("interrupt"),
        respondToRuntimeRequest: unused("answer requests"),
        readThreadSnapshot: unused("read snapshots"),
        rollbackThread: unused("roll back"),
        forkThread: unused("fork"),
      })),
    ),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      readRepositoryIdentity: () => Effect.succeed(null),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(layerServerConfig),
          Layer.provide(layerPlatformTest),
        ),
      ),
    ),
  ),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(layerPlatformTest),
);

/** A Bot Home whose earlier ordinary run completed on its provider conversation. */
const seedIdleHome = (name: string, options: { readonly threadId?: ThreadId } = {}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make(`restricted-project-${name}`);
    const threadId = options.threadId ?? ThreadId.make(`bot-home:bot-${name}:${projectId}`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${name}`);
    const firstRunId = RunId.make(`home-run:${name}`);
    yield* projects.create({
      commandId: CommandId.make(`seed-project:${name}`),
      projectId,
      title: "Restricted run",
      workspaceRoot: `/workspace/${projectId}`,
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "server",
      commandId: CommandId.make(`seed-thread:${name}`),
      threadId,
      projectId,
      title: "Bot Home",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    const thread = (yield* orchestrator.getThreadProjection(threadId)).thread;
    yield* sink.write({
      commandId: CommandId.make(`seed-home:${name}`),
      events: [
        {
          id: EventId.make(`seed-provider-thread:${name}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: `native:${name}`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`seed-active-provider-thread:${name}`),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...thread, activeProviderThreadId: providerThreadId },
        },
        {
          id: EventId.make(`seed-run:${name}`),
          type: "run.updated",
          threadId,
          runId: firstRunId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: firstRunId,
            threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`home-message:${name}`),
            rootNodeId: NodeId.make(`home-root:${name}`),
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    return { threadId, projectId, firstRunId };
  });

const startRestricted = (
  name: string,
  threadId: ThreadId,
  options: {
    readonly sequence?: number;
    readonly restriction?: OrchestrationV2RunRestriction;
  } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    return yield* orchestrator.dispatch({
      type: "restricted_run.start",
      commandId: CommandId.make(`restricted-start:${name}`),
      threadId,
      messageId: MessageId.make(`restricted-prompt:${name}`),
      text: "Refresh your working note.",
      restriction: options.restriction ?? "botNote",
      ifIdleAtSequence: options.sequence ?? (yield* sink.latestSequence({ threadId })),
    });
  });

/** The `/compact` nightly Bot maintenance sends, only while the Home is idle at `sequence`. */
const startMaintenanceCompaction = (threadId: ThreadId, sequence?: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const at = sequence ?? (yield* sink.latestSequence({ threadId }));
    const id = `bot-maintenance:compact:${threadId}:${at}`;
    return yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      threadId,
      messageId: MessageId.make(id),
      text: "/compact",
      attachments: [],
      createdBy: "system",
      creationSource: "server",
      dispatchMode: { type: "start_immediately" },
      ifIdleAtSequence: at,
    });
  });

const compactionRunOf = (threadId: ThreadId) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(threadId)),
    Effect.map((projection) =>
      projection.runs.find((run) => run.userMessageId.startsWith("bot-maintenance:compact:")),
    ),
  );

const restrictedRunOf = (threadId: ThreadId) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(threadId)),
    Effect.map((projection) => projection.runs.find((run) => run.restriction !== undefined)),
  );

const setRunStatus = (
  name: string,
  run: OrchestrationV2Run,
  status: OrchestrationV2Run["status"],
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.write({
      commandId: CommandId.make(`set-run-status:${name}:${status}`),
      events: [
        {
          id: EventId.make(`set-run-status:${name}:${status}`),
          type: "run.updated",
          threadId: run.threadId,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            ...run,
            status,
            startedAt: run.startedAt ?? now,
            completedAt: status === "running" ? null : now,
          },
        },
      ],
    });
  });

/** A Home with a restricted run that is running. */
const seedRunningRestricted = (name: string) =>
  Effect.gen(function* () {
    const home = yield* seedIdleHome(name);
    yield* startRestricted(name, home.threadId);
    const run = (yield* restrictedRunOf(home.threadId))!;
    yield* setRunStatus(name, run, "running");
    return { ...home, run: (yield* restrictedRunOf(home.threadId))! };
  });

/** A running restricted run whose provider turn is live on a session that can steer. */
const seedSteerableRestricted = (name: string) =>
  Effect.gen(function* () {
    const home = yield* seedRunningRestricted(name);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const providerSessionId = ProviderSessionId.make(`provider-session:${name}`);
    yield* (yield* ProviderSessionManager.ProviderSessionManagerV2).open({
      threadId: home.threadId,
      providerSessionId,
      modelSelection,
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
    });
    const providerThread = (yield* orchestrator.getThreadProjection(home.threadId))
      .providerThreads[0]!;
    const attemptId = RunAttemptId.make(`restricted-attempt:${name}`);
    yield* sink.write({
      commandId: CommandId.make(`seed-steerable:${name}`),
      events: [
        {
          id: EventId.make(`seed-steerable-thread:${name}`),
          type: "provider-thread.updated",
          threadId: home.threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: { ...providerThread, providerSessionId },
        },
        {
          id: EventId.make(`seed-steerable-run:${name}`),
          type: "run.updated",
          threadId: home.threadId,
          runId: home.run.id,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: { ...home.run, activeAttemptId: attemptId },
        },
        {
          id: EventId.make(`seed-steerable-turn:${name}`),
          type: "provider-turn.updated",
          threadId: home.threadId,
          occurredAt: now,
          payload: {
            id: ProviderTurnId.make(`provider-turn:${name}`),
            providerThreadId: providerThread.id,
            nodeId: home.run.rootNodeId!,
            runAttemptId: attemptId,
            nativeTurnRef: { driver, nativeId: `native-turn:${name}`, strength: "strong" },
            ordinal: 2,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        },
      ],
    });
    return { ...home, run: (yield* restrictedRunOf(home.threadId))! };
  });

it.layer(layerTest)("restricted Bot Home runs", (it) => {
  it.effect("starts a restricted run that keeps its restriction on the projected run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const home = yield* seedIdleHome("start");
      const result = yield* startRestricted("start", home.threadId, { restriction: "botWaiting" });
      assert.isUndefined(result.deferred);
      const projection = yield* orchestrator.getThreadProjection(home.threadId);
      const run = projection.runs.find((candidate) => candidate.id !== home.firstRunId)!;
      assert.strictEqual(run.restriction, "botWaiting");
      const prompt = projection.messages.find((message) => message.id === run.userMessageId)!;
      assert.strictEqual(prompt.createdBy, "agent");
      assert.strictEqual(prompt.creationSource, "server");
    }),
  );

  it.effect.each(
    (["sequence-moved", "running", "queued", "not-a-home"] as const).flatMap((state) =>
      (["restricted", "compaction"] as const).map((kind) => ({ state, kind })),
    ),
  )("defers a $kind start without a receipt: $state", ({ state, kind }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const name = `defer-${kind}-${state}`;
      const home = yield* seedIdleHome(
        name,
        state === "not-a-home" ? { threadId: ThreadId.make(`thread:${name}`) } : {},
      );
      const sequence = yield* sink.latestSequence({ threadId: home.threadId });
      const first = (yield* orchestrator.getThreadProjection(home.threadId)).runs[0]!;
      if (state === "sequence-moved" || state === "running" || state === "queued")
        yield* setRunStatus(
          name,
          first,
          state === "sequence-moved" ? "completed" : state === "running" ? "running" : "queued",
        );
      const at =
        state === "sequence-moved"
          ? sequence
          : yield* sink.latestSequence({ threadId: home.threadId });
      const start =
        kind === "restricted"
          ? startRestricted(name, home.threadId, { sequence: at })
          : startMaintenanceCompaction(home.threadId, at);
      const started = kind === "restricted" ? restrictedRunOf : compactionRunOf;
      const result = yield* start;
      assert.isTrue(result.deferred);
      assert.isUndefined(yield* started(home.threadId));
      // No receipt was consumed: the same command id is admitted once the Home is idle again.
      yield* setRunStatus(`${name}-after`, first, "completed");
      if (state === "not-a-home") return;
      const retried =
        kind === "restricted"
          ? yield* startRestricted(name, home.threadId)
          : yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`bot-maintenance:compact:${home.threadId}:${at}`),
              threadId: home.threadId,
              messageId: MessageId.make(`bot-maintenance:compact:${home.threadId}:${at}`),
              text: "/compact",
              attachments: [],
              createdBy: "system",
              creationSource: "server",
              dispatchMode: { type: "start_immediately" },
              ifIdleAtSequence: yield* sink.latestSequence({ threadId: home.threadId }),
            });
      assert.isUndefined(retried.deferred);
      assert.isDefined(yield* started(home.threadId));
    }),
  );

  it.effect("starts a maintenance compaction on a settled Home without unsettling it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const home = yield* seedIdleHome("compact-settled");
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:compact-settled"),
        threadId: home.threadId,
      });
      const result = yield* startMaintenanceCompaction(home.threadId);
      assert.isUndefined(result.deferred);
      const projection = yield* orchestrator.getThreadProjection(home.threadId);
      assert.strictEqual(projection.thread.settledOverride, "settled");
      const run = (yield* compactionRunOf(home.threadId))!;
      const prompt = projection.messages.find((message) => message.id === run.userMessageId)!;
      assert.strictEqual(prompt.createdBy, "system");
      assert.isUndefined(prompt.idleCompaction);
    }),
  );

  it.effect.each([
    { name: "start", deliveryIntent: undefined },
    { name: "steer", deliveryIntent: "steer" as const },
  ])(
    "a message sent before a maintenance compaction reaches its provider skips it: $name",
    ({ name, deliveryIntent }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const home = yield* seedIdleHome(`compact-skip-${name}`);
        yield* startMaintenanceCompaction(home.threadId);
        const compaction = (yield* compactionRunOf(home.threadId))!;
        assert.include(["preparing", "starting"], compaction.status);
        const messageId = MessageId.make(`user-before-compact:${name}`);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`user-before-compact:${name}`),
          threadId: home.threadId,
          messageId,
          text: "Plan tomorrow.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          ...(deliveryIntent === undefined ? {} : { deliveryIntent }),
          dispatchMode:
            deliveryIntent === undefined
              ? { type: "start_immediately" }
              : { type: "steer_active", targetRunId: compaction.id },
        });
        const projection = yield* orchestrator.getThreadProjection(home.threadId);
        const skipped = projection.runs.find((run) => run.id === compaction.id)!;
        assert.notInclude(["preparing", "starting", "running"], skipped.status);
        const userRun = projection.runs.find((run) => run.userMessageId === messageId)!;
        assert.strictEqual(userRun.status, "queued");
        assert.strictEqual(userRun.queuePosition, 1);
        assert.isTrue(projection.messages.some((message) => message.id === messageId));
      }),
  );

  it.effect("a message sent after a maintenance compaction reached its provider waits for it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const home = yield* seedIdleHome("compact-wait");
      yield* startMaintenanceCompaction(home.threadId);
      yield* setRunStatus("compact-wait", (yield* compactionRunOf(home.threadId))!, "running");
      const compaction = (yield* compactionRunOf(home.threadId))!;
      const messageId = MessageId.make("user-after-compact");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("user-after-compact"),
        threadId: home.threadId,
        messageId,
        text: "Plan tomorrow.",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      const projection = yield* orchestrator.getThreadProjection(home.threadId);
      assert.strictEqual(
        projection.runs.find((run) => run.id === compaction.id)?.status,
        "running",
      );
      assert.strictEqual(
        projection.runs.find((run) => run.userMessageId === messageId)?.status,
        "queued",
      );
    }),
  );

  it.effect.each([
    { name: "steer", deliveryIntent: "steer" as const },
    { name: "restart", deliveryIntent: "restart" as const },
    { name: "auto", deliveryIntent: "auto" as const },
    { name: "explicit-steer", deliveryIntent: undefined },
  ])("queues user input sent during a restricted run: $name", ({ name, deliveryIntent }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const home = yield* seedSteerableRestricted(`input-${name}`);
      const messageId = MessageId.make(`user-input:${name}`);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`user-input:${name}`),
        threadId: home.threadId,
        messageId,
        text: "What is on my plate?",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        ...(deliveryIntent === undefined ? {} : { deliveryIntent }),
        dispatchMode:
          deliveryIntent === undefined
            ? { type: "steer_active", targetRunId: home.run.id }
            : { type: "queue_after_active" },
      });
      const projection = yield* orchestrator.getThreadProjection(home.threadId);
      const userRun = projection.runs.find((run) => run.userMessageId === messageId)!;
      assert.strictEqual(userRun.status, "queued");
      assert.isUndefined(userRun.restriction);
      const restricted = projection.runs.find((run) => run.id === home.run.id)!;
      assert.strictEqual(restricted.status, "running");
      assert.strictEqual(restricted.userMessageId, home.run.userMessageId);
    }),
  );

  it.effect("queues a delegated task notification instead of steering a restricted run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const home = yield* seedSteerableRestricted("notification");
      const messageId = MessageId.make("delegated-notification");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("delegated-notification"),
        threadId: home.threadId,
        messageId,
        text: "A child task finished.",
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        notification: {
          source: { kind: "delegated_task", taskIds: [NodeId.make("child")] },
          outcome: "completed",
          summary: "Child finished",
        },
        dispatchMode: { type: "queue_after_active" },
      });
      const projection = yield* orchestrator.getThreadProjection(home.threadId);
      assert.strictEqual(
        projection.runs.find((run) => run.userMessageId === messageId)?.status,
        "queued",
      );
    }),
  );

  it.effect("refuses to promote a queued message into a restricted run and keeps it queued", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const home = yield* seedRunningRestricted("promote");
      const messageId = MessageId.make("queued-user-input");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("queued-user-input"),
        threadId: home.threadId,
        messageId,
        text: "Do this next.",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
      });
      const queued = (yield* orchestrator.getThreadProjection(home.threadId)).runs.find(
        (run) => run.userMessageId === messageId,
      )!;
      const refusal = yield* Effect.flip(
        orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote-into-restricted"),
          threadId: home.threadId,
          queuedRunId: queued.id,
          targetRunId: home.run.id,
        }),
      );
      assert.include(JSON.stringify(refusal), "maintenance turn");
      const after = yield* orchestrator.getThreadProjection(home.threadId);
      assert.strictEqual(after.runs.find((run) => run.id === queued.id)?.status, "queued");
    }),
  );

  it.effect.each(["manual", "restart", "usage-limit"] as const)(
    "never continues a restricted run: %s",
    (kind) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const home = yield* seedRunningRestricted(`continue-${kind}`);
        // Each continuation gets a source it would accept from an ordinary run.
        yield* setRunStatus(
          `continue-${kind}`,
          home.run,
          kind === "manual" ? "interrupted" : kind === "restart" ? "cancelled" : "failed",
        );
        const recoveryRequestId = CommandId.make(`limit-recovery:${kind}`);
        if (kind === "usage-limit") {
          const sink = yield* EventSink.EventSinkV2;
          const now = yield* DateTime.now;
          const resetAt = DateTime.formatIso(now);
          const { thread } = yield* orchestrator.getThreadProjection(home.threadId);
          yield* sink.write({
            commandId: CommandId.make(`seed-usage-limit:${kind}`),
            events: [
              {
                id: EventId.make(`seed-usage-limit-error:${kind}`),
                type: "turn-item.updated",
                threadId: home.threadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`usage-limit-error:${kind}`),
                  type: "error",
                  threadId: home.threadId,
                  runId: home.run.id,
                  nodeId: home.run.rootNodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "failed",
                  title: "Usage limit reached",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  failure: {
                    class: "usage_limit",
                    message: "Plan limit reached.",
                    code: "usageLimitExceeded",
                    retryable: null,
                    resetAt,
                  },
                },
              },
              {
                id: EventId.make(`seed-usage-limit-recovery:${kind}`),
                type: "thread.metadata-updated",
                threadId: home.threadId,
                occurredAt: now,
                payload: {
                  ...thread,
                  limitRecovery: {
                    runId: home.run.id,
                    resetAt,
                    autoResume: true,
                    snooze: false,
                    requestId: recoveryRequestId,
                  },
                },
              },
            ],
          });
        }
        const messageId = MessageId.make(`continue:${kind}`);
        const dispatched = yield* Effect.exit(
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`continue:${kind}`),
            threadId: home.threadId,
            messageId,
            text: "Continue.",
            attachments: [],
            createdBy: kind === "manual" ? "user" : "agent",
            creationSource: kind === "manual" ? "web" : "server",
            dispatchMode: { type: "start_immediately" },
            ...(kind === "manual"
              ? { manualContinuationOfRunId: home.run.id }
              : kind === "restart"
                ? { restartContinuationOfRunId: home.run.id }
                : {
                    usageLimitContinuationOfRunId: home.run.id,
                    usageLimitRecoveryRequestId: recoveryRequestId,
                  }),
          }),
        );
        // A client resume is refused; automatic producers get an accepted no-op so they stop.
        assert.strictEqual(dispatched._tag, kind === "manual" ? "Failure" : "Success");
        const projection = yield* orchestrator.getThreadProjection(home.threadId);
        assert.isFalse(projection.runs.some((run) => run.userMessageId === messageId));
        assert.isFalse(projection.messages.some((message) => message.id === messageId));
      }),
  );

  it.effect("keeps a restricted run live for Stop but out of the presented shell", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      // getThreadShell reads the SQL shell; threadShellFromProjection is its JavaScript mirror.
      const projectionStore = { getThreadShell: orchestrator.getThreadShell };
      const home = yield* seedRunningRestricted("shell");
      const projection = yield* orchestrator.getThreadProjection(home.threadId);
      const shells = [
        ProjectionStore.threadShellFromProjection(projection),
        (yield* projectionStore.getThreadShell(home.threadId))!,
      ];
      for (const shell of shells) {
        assert.strictEqual(shell.activeRunId, home.run.id);
        assert.strictEqual(shell.latestRunId, home.firstRunId);
        assert.strictEqual(shell.status, "completed");
        assert.isNull(shell.latestUserMessageAt);
      }

      yield* setRunStatus("shell-done", home.run, "completed");
      const completed = yield* projectionStore.getThreadShell(home.threadId);
      assert.strictEqual(completed?.latestRunId, home.firstRunId);
      assert.isNull(completed?.activeRunId);

      yield* setRunStatus("shell-failed", home.run, "failed");
      const failedProjection = yield* orchestrator.getThreadProjection(home.threadId);
      for (const shell of [
        ProjectionStore.threadShellFromProjection(failedProjection),
        (yield* projectionStore.getThreadShell(home.threadId))!,
      ]) {
        assert.strictEqual(shell.latestRunId, home.run.id);
        assert.strictEqual(shell.status, "failed");
        assert.isNotNull(shell.latestUserMessageAt);
      }
    }),
  );
});
