import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BotId,
  type BotLearningPolicy,
  type BotTaskResult,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as CheckpointRollbackService from "../orchestration-v2/CheckpointRollbackService.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderTurnControlService from "../orchestration-v2/ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "../orchestration-v2/ProviderTurnStartService.ts";
import * as RunFinalizationService from "../orchestration-v2/RunFinalizationService.ts";
import * as RuntimeRequestService from "../orchestration-v2/RuntimeRequestService.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTitleRegenerationService from "../orchestration-v2/ThreadTitleRegenerationService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotProjectGuard from "./BotProjectGuard.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as BotMigrations from "./persistence/Migrations.ts";
import * as BotMaintenance from "./BotMaintenance.ts";
import type * as Evidence from "./BotMaintenanceEvidence.ts";
import * as BotService from "./BotService.ts";
import * as BotStore from "./BotStore.ts";
import * as BotTaskService from "./BotTaskService.ts";
import * as BotTurnContext from "./BotTurnContext.ts";

const scope = { botId: BotId.make("bot"), projectId: ProjectId.make("project") };
const home = ThreadId.make("bot-home:bot:project");
const now = "2026-11-09T10:00:00.000Z";
const database = Sqlite.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-maintenance-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const storeOnly = BotStore.layer.pipe(Layer.provideMerge(database));
// Settings tests never learn, so the learning and task services are inert here.
const inertLearning = Layer.mergeAll(
  Layer.mock(BotService.BotService)({}),
  Layer.mock(BotTaskService.BotTaskService)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
);
const production = BotMaintenance.layer.pipe(
  Layer.provide(Layer.mergeAll(EventStore.layer, ThreadCommandExecutor.layer, inertLearning)),
  Layer.provideMerge(storeOnly),
);
const context = (detachedAt: string | null): BotStore.BotContextRow => ({
  home_thread_id: home,
  bot_id: "bot",
  project_id: "project",
  guidance: "",
  sources_json: "[]",
  revision: 1,
  thread_sync: null,
  attached_at: now,
  detached_at: detachedAt,
  updated_at: now,
});
const seed = Effect.gen(function* () {
  const store = yield* BotStore.BotStore;
  yield* store.insertBot({
    bot_id: "bot",
    name: "Companion",
    instructions: "",
    model_selection_json: '{"instanceId":"codex","model":"gpt-6-luna"}',
    learning_policy: "after_adoption",
    appearance_json: null,
    created_at: now,
    updated_at: now,
    archived_at: null,
  });
  yield* store.upsertContext(context(null));
});
const message = Effect.fn("fixture.message")(function* (
  id: string,
  run: { readonly id: string; readonly ordinal: number; readonly status: string },
  options: { readonly thread?: ThreadId; readonly role?: string } = {},
) {
  const main = yield* SqlClient.SqlClient;
  const thread = options.thread ?? home;
  const role = options.role ?? "user";
  yield* main`INSERT OR IGNORE INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (${run.id}, ${thread}, ${run.ordinal}, 'codex', ${run.status}, ${now}, '{}')`;
  yield* main`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json) VALUES (${id}, ${thread}, ${run.id}, ${role}, 0, ${now}, ${now}, ${JSON.stringify({ id, role, text: id })})`;
});
const task = Effect.fn("fixture.task")(function* (
  id: string,
  status: string,
  cancelRequested = false,
) {
  const bots = yield* BotDatabase.BotDatabase;
  yield* bots`INSERT INTO bot_tasks (task_id, bot_id, project_id, home_thread_id, origin, title, prompt, runtime_mode, status, cancel_requested_at, created_at, updated_at) VALUES (${id}, 'bot', 'project', ${home}, 'direct', 'Checklist', 'Read', 'full-access', ${status}, ${cancelRequested ? now : null}, ${now}, ${now})`;
});
const receipts = Effect.gen(function* () {
  const bots = yield* BotDatabase.BotDatabase;
  const rows = yield* bots<{
    readonly kind: string;
    readonly source_id: string;
    readonly state: string;
  }>`SELECT kind, source_id, state FROM bot_maintenance_sources WHERE home_thread_id = ${home} ORDER BY kind, source_id`;
  return rows.map((row) => `${row.kind}:${row.source_id}:${row.state}`);
});
const floors = Effect.gen(function* () {
  const bots = yield* BotDatabase.BotDatabase;
  return (yield* bots<{
    readonly scan_through_sequence: number | null;
    readonly processed_through_sequence: number | null;
  }>`SELECT scan_through_sequence, processed_through_sequence FROM bot_maintenance WHERE home_thread_id = ${home}`)[0];
});

/**
 * Enablement with a generator that is never called. Snapshots record whether the Home command
 * lock was held.
 */
const withReadyGeneration = Effect.gen(function* () {
  const sequence = yield* Ref.make(0);
  const snapshots = yield* Ref.make<ReadonlyArray<boolean>>([]);
  const executor = yield* KeyedLock.make<ThreadId>();
  const maintenance = yield* BotMaintenance.make({
    unavailableReason: null,
    generate: () => Effect.die("settings tests never generate"),
  }).pipe(
    Effect.provide(
      Layer.merge(
        Layer.mock(EventStore.EventStoreV2)({
          latestSequence: () =>
            executor.activeKeys.pipe(
              Effect.flatMap((keys) =>
                Ref.update(snapshots, (all) => [...all, keys.includes(home)]),
              ),
              Effect.andThen(Ref.get(sequence)),
            ),
        }),
        inertLearning,
      ),
    ),
    Effect.provideService(ThreadCommandExecutor.ThreadCommandExecutor, executor),
  );
  return { maintenance, sequence, snapshots };
});

it.effect("stays off by default and refuses enabling while no tool-free generator exists", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* message("before", { id: "run-1", ordinal: 1, status: "completed" });
    const maintenance = yield* BotMaintenance.BotMaintenance;
    assert.deepEqual(yield* maintenance.get(scope), {
      ...scope,
      homeThreadId: home,
      revision: 0,
      enabled: false,
      startedAt: null,
      unavailableReason: "no_tool_profile_unavailable",
      writable: true,
    });
    const refused = yield* maintenance
      .configure({ ...scope, baseRevision: 0, enabled: true })
      .pipe(Effect.flip);
    assert.include(refused.message, "not available");
    const off = yield* maintenance.configure({ ...scope, baseRevision: 0, enabled: false });
    assert.equal(off._tag, "saved");
    const bots = yield* BotDatabase.BotDatabase;
    assert.deepEqual(yield* bots`SELECT * FROM bot_maintenance`, []);
    assert.deepEqual(yield* receipts, []);
  }).pipe(Effect.provide(production)),
);

it.effect(
  "baselines every earlier Home input and finished task on first enable, and keeps that baseline across pause and resume",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const { maintenance, sequence, snapshots } = yield* withReadyGeneration;
      yield* message("delivered", { id: "run-1", ordinal: 1, status: "completed" });
      yield* message("failed-preparation", { id: "run-2", ordinal: 2, status: "failed" });
      yield* message("preparing", { id: "run-3", ordinal: 3, status: "preparing" });
      yield* message("queued", { id: "run-4", ordinal: 4, status: "queued" });
      yield* message(
        "assistant",
        { id: "run-1", ordinal: 1, status: "completed" },
        {
          role: "assistant",
        },
      );
      yield* message(
        "other-thread",
        { id: "run-x", ordinal: 1, status: "completed" },
        {
          thread: ThreadId.make("other"),
        },
      );
      yield* task("task-completed", "completed");
      yield* task("task-failed", "failed");
      yield* task("task-running", "running");
      yield* task("task-cancelling", "running", true);
      yield* Ref.set(sequence, 40);

      const enabled = yield* maintenance.configure({ ...scope, baseRevision: 0, enabled: true });
      if (enabled._tag !== "saved") return assert.fail();
      assert.equal(enabled.view.revision, 1);
      assert.isTrue(enabled.view.enabled);
      assert.isNotNull(enabled.view.startedAt);
      assert.deepEqual(yield* Ref.get(snapshots), [true]);
      const baseline = [
        "home-input:delivered:baseline",
        "home-input:failed-preparation:baseline",
        "home-input:preparing:baseline",
        "home-input:queued:baseline",
        "task-result:task-completed:baseline",
        "task-result:task-failed:baseline",
      ];
      assert.deepEqual(yield* receipts, baseline);
      assert.deepEqual(yield* floors, {
        scan_through_sequence: 40,
        processed_through_sequence: 40,
      });

      // After the baseline: new input, a task finishing, and an old queued input edited and promoted.
      const main = yield* SqlClient.SqlClient;
      yield* message("after", { id: "run-5", ordinal: 5, status: "running" });
      yield* main`UPDATE orchestration_v2_projection_messages SET run_id = 'run-5', payload_json = json_set(payload_json, '$.text', 'edited') WHERE message_id = 'queued'`;
      const bots = yield* BotDatabase.BotDatabase;
      yield* bots`UPDATE bot_tasks SET status = 'completed' WHERE task_id = 'task-running'`;
      yield* Ref.set(sequence, 99);

      const paused = yield* maintenance.configure({ ...scope, baseRevision: 1, enabled: false });
      if (paused._tag !== "saved") return assert.fail();
      assert.isFalse(paused.view.enabled);
      assert.equal(paused.view.startedAt, enabled.view.startedAt);
      const resumed = yield* maintenance.configure({ ...scope, baseRevision: 2, enabled: true });
      if (resumed._tag !== "saved") return assert.fail();
      assert.equal(resumed.view.revision, 3);
      assert.equal(resumed.view.startedAt, enabled.view.startedAt);
      assert.deepEqual(yield* Ref.get(snapshots), [true]);
      assert.deepEqual(yield* receipts, baseline);
      assert.deepEqual(yield* floors, {
        scan_through_sequence: 40,
        processed_through_sequence: 40,
      });
    }).pipe(Effect.provide(storeOnly)),
);

it.effect(
  "lets one of two racing enables take the baseline and keeps an archived or detached Bot off",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const { maintenance } = yield* withReadyGeneration;
      yield* message("delivered", { id: "run-1", ordinal: 1, status: "completed" });
      yield* task("task-completed", "completed");
      const raced = yield* Effect.all(
        [
          maintenance.configure({ ...scope, baseRevision: 0, enabled: true }),
          maintenance.configure({ ...scope, baseRevision: 0, enabled: true }),
        ],
        { concurrency: 2 },
      );
      assert.sameMembers(
        raced.map((result) => result._tag),
        ["saved", "conflict"],
      );
      assert.deepEqual(yield* receipts, [
        "home-input:delivered:baseline",
        "task-result:task-completed:baseline",
      ]);
      const stale = yield* maintenance.configure({ ...scope, baseRevision: 0, enabled: false });
      if (stale._tag !== "conflict") return assert.fail();
      assert.equal(stale.current.revision, 1);
      assert.isTrue(stale.current.enabled);

      const store = yield* BotStore.BotStore;
      yield* store.upsertContext(context(now));
      const paused = yield* maintenance.configure({ ...scope, baseRevision: 1, enabled: false });
      if (paused._tag !== "saved") return assert.fail();
      assert.isFalse(paused.view.writable);
      const refused = yield* maintenance
        .configure({ ...scope, baseRevision: 2, enabled: true })
        .pipe(Effect.flip);
      assert.include(refused.message, "archived or detached");
      assert.equal((yield* maintenance.get(scope)).revision, 2);
      yield* store.upsertContext(context(null));
      const resumed = yield* maintenance.configure({ ...scope, baseRevision: 2, enabled: true });
      assert.equal(resumed._tag, "saved");
    }).pipe(Effect.provide(storeOnly)),
);

it.effect(
  "upgrades a version-10 Bot database to default-off and enforces one receipt per source and one active run per Home",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const bots = yield* BotDatabase.BotDatabase;
      yield* bots`DROP TABLE bot_maintenance_sources`;
      yield* bots`DROP TABLE bot_maintenance_runs`;
      yield* bots`DROP TABLE bot_maintenance`;
      yield* bots`DELETE FROM effect_sql_migrations WHERE migration_id >= 11`;
      yield* BotMigrations.runMigrations().pipe(Effect.provideService(SqlClient.SqlClient, bots));
      const history = yield* bots<{
        readonly migration_id: number;
        readonly name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepEqual(history.slice(-2), [
        { migration_id: 11, name: "BotMaintenance" },
        { migration_id: 12, name: "BotMaintenanceReceipts" },
      ]);
      const maintenance = yield* BotMaintenance.BotMaintenance;
      const view = yield* maintenance.get(scope);
      assert.isFalse(view.enabled);
      assert.equal(view.revision, 0);

      yield* bots`INSERT INTO bot_maintenance (home_thread_id, settings_revision, enabled, updated_at) VALUES (${home}, 1, 0, ${now})`;
      const run = (id: string, status: string) =>
        bots`INSERT INTO bot_maintenance_runs (run_id, home_thread_id, status, started_at) VALUES (${id}, ${home}, ${status}, ${now})`;
      yield* run("first", "running");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(run("second", "running"))));
      yield* run("second", "applied");
      const receipt = bots`INSERT INTO bot_maintenance_sources (home_thread_id, kind, source_id, state, recorded_at) VALUES (${home}, 'home-input', 'message', 'baseline', ${now})`;
      yield* receipt;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(receipt)));
    }).pipe(Effect.provide(production)),
);

it.effect("refuses a pass while no tool-free generator exists", () =>
  Effect.gen(function* () {
    yield* seed;
    const maintenance = yield* BotMaintenance.BotMaintenance;
    const refused = yield* maintenance.runNow(scope).pipe(Effect.flip);
    assert.include(refused.message, "not available");
  }).pipe(Effect.provide(production)),
);

const otherScope = { botId: scope.botId, projectId: ProjectId.make("other") };
const otherHome = ThreadId.make("bot-home:bot:other");
const later = (minute: number) => `2026-11-09T11:${String(minute).padStart(2, "0")}:00.000Z`;

const seedBot = Effect.fn("fixture.seedBot")(function* (policy: BotLearningPolicy) {
  const store = yield* BotStore.BotStore;
  yield* store.insertBot({
    bot_id: "bot",
    name: "Companion",
    instructions: "",
    model_selection_json: '{"instanceId":"codex","model":"gpt-6-luna"}',
    learning_policy: policy,
    appearance_json: null,
    created_at: now,
    updated_at: now,
    archived_at: null,
  });
  yield* store.upsertContext(context(null));
  yield* store.upsertContext({
    ...context(null),
    home_thread_id: otherHome,
    project_id: otherScope.projectId,
  });
});

/**
 * A Home message with the turn item admission writes for it. Delivered input also has the
 * provider turn that accepted it; a succeeded steer also has the acceptance the worker records.
 */
const input = Effect.fn("fixture.input")(function* (
  id: string,
  text: string,
  options: {
    readonly at?: string;
    readonly thread?: ThreadId;
    readonly runStatus?: string;
    readonly delivered?: boolean;
    readonly steer?: "pending" | "succeeded" | "failed";
    readonly createdBy?: "user" | "agent";
    readonly creationSource?: string;
  } = {},
) {
  const main = yield* SqlClient.SqlClient;
  const thread = options.thread ?? home;
  const at = options.at ?? later(0);
  const run = `run-${id}`;
  yield* main`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
    VALUES (${run}, ${thread}, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${thread}), 'codex', ${options.runStatus ?? "completed"}, ${at}, '{}')`;
  const payload = {
    id,
    threadId: thread,
    runId: run,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
    createdBy: options.createdBy ?? "user",
    creationSource: options.creationSource ?? "web",
  };
  yield* main`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
    VALUES (${id}, ${thread}, ${run}, 'user', 0, ${at}, ${at}, ${JSON.stringify(payload)})`;
  const node = `node-${id}`;
  const turn = options.steer === undefined ? null : `turn-${id}`;
  const item = {
    messageId: id,
    inputIntent: turn === null ? "turn_start" : "steer",
    ...(options.steer === "succeeded" ? { steerAcceptedAt: at } : {}),
  };
  yield* main`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, node_id, provider_turn_id, ordinal, type, status, updated_at, payload_json)
    VALUES (${IdAllocator.derive.userTurnItem({ messageId: MessageId.make(id) })}, ${thread}, ${run}, ${node}, ${turn}, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM orchestration_v2_projection_turn_items WHERE thread_id = ${thread}), 'user_message', 'completed', ${at}, ${JSON.stringify(item)})`;
  if (options.delivered ?? true) yield* deliver(id, thread);
  if (options.steer !== undefined) {
    const settledAt = options.steer === "pending" ? null : DateTime.formatIso(yield* DateTime.now);
    yield* main`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at, completed_at)
      VALUES (${`effect-${id}`}, ${`command-${id}`}, ${thread}, 'provider-turn.steer', ${JSON.stringify({ type: "provider-turn.steer", providerSessionId: "session", providerThreadId: "provider-thread", providerTurnId: turn, messageId: id })}, ${options.steer}, ${at}, ${at}, ${at}, ${settledAt})`;
  }
});

/** The provider turn that accepted this input on its run's root node. */
const deliver = Effect.fn("fixture.deliver")(function* (id: string, thread = home) {
  const main = yield* SqlClient.SqlClient;
  yield* main`INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, payload_json)
    VALUES (${`turn-${id}`}, ${thread}, ${`provider-thread-${id}`}, ${`node-${id}`}, 1, 'completed', '{}')`;
});

const finishedTask = Effect.fn("fixture.finishedTask")(function* (id: string, status: string) {
  const bots = yield* BotDatabase.BotDatabase;
  yield* bots`INSERT INTO bot_tasks (task_id, bot_id, project_id, home_thread_id, origin, title, prompt, runtime_mode, status, completed_at, created_at, updated_at)
    VALUES (${id}, 'bot', 'project', ${home}, 'direct', 'Checklist', 'Read', 'full-access', ${status}, ${later(30)}, ${now}, ${now})`;
});

const add = (source: string, quote: string, text: string, kind = "preference") => ({
  op: "add",
  kind,
  text,
  rationale: "Stated by the user.",
  evidence: [{ source, quote }],
});

/** Records every packet it is shown and answers from `respond`. */
const recordingGenerator = Effect.fn("fixture.recordingGenerator")(function* (
  respond: (packet: Evidence.Packet) => Effect.Effect<unknown, never, never>,
) {
  const packets = yield* Ref.make<ReadonlyArray<Evidence.Packet>>([]);
  const generate: BotMaintenance.Generator = (packet) =>
    Ref.update(packets, (all) => [...all, packet]).pipe(Effect.andThen(respond(packet)));
  return { packets, generate };
});

/**
 * Fresh services over the same database each call, as a server restart builds them. The Home's
 * event sequence and the provider runtime's background-work probe are synthetic.
 */
const withEngine = <A, E, R>(
  generate: BotMaintenance.Generator,
  body: (services: {
    readonly maintenance: BotMaintenance.BotMaintenance["Service"];
    readonly turnContext: BotTurnContext.BotTurnContext["Service"];
    readonly bots: BotService.BotService["Service"];
    readonly homeSequence: Ref.Ref<number>;
    readonly runtimeBackgroundWork: Ref.Ref<boolean>;
  }) => Effect.Effect<A, E, R>,
  taskResults: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const executor = yield* KeyedLock.make<ThreadId>();
    const homeSequence = yield* Ref.make(0);
    const runtimeBackgroundWork = yield* Ref.make(false);
    const maintenance = yield* BotMaintenance.make({ unavailableReason: null, generate }).pipe(
      Effect.provideService(ThreadCommandExecutor.ThreadCommandExecutor, executor),
      Effect.provide(
        Layer.merge(
          Layer.mock(EventStore.EventStoreV2)({ latestSequence: () => Ref.get(homeSequence) }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () =>
              Effect.succeedSome({
                hasPendingBackgroundWorkForThread: () => Ref.get(runtimeBackgroundWork),
              } as never),
          }),
        ),
      ),
    );
    return yield* body({
      maintenance,
      turnContext: yield* BotTurnContext.BotTurnContext,
      bots: yield* BotService.BotService,
      homeSequence,
      runtimeBackgroundWork,
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(BotService.layer, BotTurnContext.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(BotTaskService.BotTaskService)({
              changes: Effect.succeed(Stream.empty),
              getResult: (request) =>
                Effect.succeed({
                  task: {} as BotTaskResult["task"],
                  result:
                    taskResults[request.taskId] === undefined
                      ? { state: "unavailable" }
                      : {
                          state: "available",
                          runId: RunId.make(`result-${request.taskId}`),
                          text: taskResults[request.taskId] ?? "",
                        },
                } satisfies BotTaskResult),
            }),
            Layer.mock(EventStore.EventStoreV2)({ latestSequence: () => Effect.succeed(0) }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            BotProjectGuard.layer,
            Scheduler.layer,
            ServerSettings.layerTest(),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );

const enable = (maintenance: BotMaintenance.BotMaintenance["Service"], target = scope) =>
  maintenance
    .configure({ ...target, baseRevision: 0, enabled: true })
    .pipe(Effect.flatMap((result) => (result._tag === "saved" ? Effect.void : Effect.die(result))));

const instructionsAt = (turnContext: BotTurnContext.BotTurnContext["Service"], thread = home) =>
  turnContext
    .forThread(thread)
    .pipe(Effect.map((result) => (result._tag === "active" ? result.instructions : result._tag)));

const learningRows = Effect.gen(function* () {
  const bots = yield* BotDatabase.BotDatabase;
  return yield* bots<{
    readonly entry_id: string;
    readonly revision: number;
    readonly project_id: string | null;
    readonly text: string;
    readonly status: string;
    readonly origin: string;
    readonly source_json: string;
    readonly evidence: string;
  }>`SELECT entry_id, revision, project_id, text, status, origin, source_json, evidence FROM bot_learning_revisions ORDER BY rowid`;
});

const sourceStates = Effect.gen(function* () {
  const bots = yield* BotDatabase.BotDatabase;
  const rows = yield* bots<{
    readonly source_id: string;
    readonly state: string;
    readonly exclusion_reason: string | null;
  }>`SELECT source_id, state, exclusion_reason FROM bot_maintenance_sources WHERE home_thread_id = ${home} ORDER BY kind, source_id`;
  return Object.fromEntries(rows.map((row) => [row.source_id, row.exclusion_reason ?? row.state]));
});

const runStatuses = Effect.gen(function* () {
  const bots = yield* BotDatabase.BotDatabase;
  const rows = yield* bots<{
    readonly status: string;
  }>`SELECT status FROM bot_maintenance_runs WHERE home_thread_id = ${home} ORDER BY started_at, rowid`;
  return rows.map((row) => row.status);
});

const gold = "From now on, open every session recap with the party's gold total.";
const goldLesson = "Open every session recap with the party's gold total.";

it.effect.each(["automatic", "after_adoption"] as const)(
  "learns from new Home input once and applies it by the %s policy, active only under automatic",
  (policy) =>
    Effect.gen(function* () {
      yield* seedBot(policy);
      yield* input("before", "Old chatter from before maintenance.", { at: now });
      const { packets, generate } = yield* recordingGenerator(() =>
        Effect.succeed({ operations: [add("i1", "open every session recap", goldLesson)] }),
      );
      yield* withEngine(generate, ({ maintenance, turnContext }) =>
        Effect.gen(function* () {
          yield* enable(maintenance);
          yield* input("ask", gold);
          const pass = yield* maintenance.runNow(scope);
          assert.equal(pass.status, "applied");
          assert.deepEqual(
            (yield* Ref.get(packets)).map((packet) => packet.sources),
            [[{ key: "i1", kind: "home-input", text: gold }]],
          );
          const [lesson, ...others] = yield* learningRows;
          assert.deepEqual(others, []);
          assert.equal(lesson?.status, policy === "automatic" ? "active" : "pending");
          // Its own inference never becomes a standing instruction, even for "from now on".
          assert.equal(lesson?.origin, "correction");
          assert.equal(lesson?.project_id, "project");
          assert.equal(lesson?.source_json, '{"kind":"agent","label":"Bot maintenance"}');
          assert.include(lesson?.evidence, `run ${pass.status === "applied" ? pass.runId : ""}`);
          assert.include(lesson?.evidence, "home-input ask (sha256 ");
          assert.include(lesson?.evidence, '"open every session recap"');
          assert.equal(
            (yield* instructionsAt(turnContext)).includes(goldLesson),
            policy === "automatic",
          );

          assert.deepEqual(yield* maintenance.runNow(scope), { status: "idle" });
          assert.equal((yield* Ref.get(packets)).length, 1);
          assert.equal((yield* learningRows).length, 1);
          assert.deepEqual(yield* sourceStates, { ask: "applied", before: "baseline" });
        }),
      );
    }).pipe(Effect.provide(storeOnly)),
);

it.effect(
  "learns only from a person's delivered input and completed work, never its own output or unfinished work",
  () =>
    Effect.gen(function* () {
      yield* seedBot("automatic");
      const { packets, generate } = yield* recordingGenerator(() =>
        Effect.succeed({ operations: [] }),
      );
      yield* withEngine(
        generate,
        ({ maintenance }) =>
          Effect.gen(function* () {
            yield* enable(maintenance);
            const main = yield* SqlClient.SqlClient;
            yield* input("asked", "Keep the vault index in Index.md.", { at: later(1) });
            yield* input("task-return", "Bot work run completed. Use Index.md.", {
              at: later(2),
              createdBy: "agent",
              creationSource: "server",
            });
            yield* input("mcp", "Another agent says: use Index.md.", {
              at: later(3),
              createdBy: "agent",
              creationSource: "mcp",
            });
            yield* input("cancelled-queued", "Never mind.", {
              at: later(4),
              runStatus: "cancelled",
              delivered: false,
            });
            yield* input("rolled-back", "Undo this.", { at: later(5), runStatus: "rolled_back" });
            yield* input("failed-after-delivery", "Name the files after the session date.", {
              at: later(6),
              runStatus: "failed",
            });
            yield* input("failed-before-delivery", "Setup broke before the model saw this.", {
              at: later(7),
              runStatus: "failed",
              delivered: false,
            });
            yield* input("steered", "Also list the loot.", { at: later(8), steer: "succeeded" });
            yield* input("steer-failed", "The model never saw this steer.", {
              at: later(9),
              steer: "failed",
            });
            yield* input("still-running", "Also track loot.", {
              at: later(40),
              runStatus: "running",
            });
            yield* main`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
              VALUES ('reply', ${home}, 'run-asked', 'assistant', 0, ${later(1)}, ${later(1)}, '{}')`;
            yield* finishedTask("task-completed", "completed");
            yield* finishedTask("task-failed", "failed");
            yield* finishedTask("task-cancelled", "cancelled");
            yield* finishedTask("task-interrupted", "interrupted");

            const busy = yield* maintenance.runNow(scope);
            assert.deepEqual(busy.status === "deferred" && busy.reason, "home_active");
            assert.deepEqual(yield* Ref.get(packets), []);

            yield* main`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run-still-running'`;
            assert.equal((yield* maintenance.runNow(scope)).status, "noop");
            assert.deepEqual(
              (yield* Ref.get(packets)).map((packet) =>
                packet.sources.map((source) => [source.key, source.text]),
              ),
              [
                [
                  ["i1", "Keep the vault index in Index.md."],
                  ["i2", "Name the files after the session date."],
                  ["i3", "Also list the loot."],
                  ["t1", "Moved the notes. The index lives in Index.md."],
                  ["i4", "Also track loot."],
                ],
              ],
            );
            assert.deepEqual(yield* sourceStates, {
              asked: "applied",
              "cancelled-queued": "cancelled_before_delivery",
              "failed-after-delivery": "applied",
              "failed-before-delivery": "pending",
              mcp: "not_user_input",
              "rolled-back": "rolled_back",
              "steer-failed": "pending",
              steered: "applied",
              "still-running": "applied",
              "task-return": "not_user_input",
              "task-cancelled": "task_cancelled",
              "task-completed": "applied",
              "task-failed": "task_failed",
              "task-interrupted": "task_interrupted",
            });
            assert.deepEqual(yield* maintenance.runNow(scope), { status: "idle" });
          }),
        {
          "task-completed": "Moved the notes. The index lives in Index.md.",
          // A failed run can still leave a final answer behind; it is not evidence.
          "task-failed": "Ran the risky migration; it broke the vault.",
        },
      );
    }).pipe(Effect.provide(storeOnly)),
);

const runOutcomes = Effect.gen(function* () {
  const bots = yield* BotDatabase.BotDatabase;
  const rows = yield* bots<{
    readonly status: string;
    readonly outcome_json: string | null;
  }>`SELECT status, outcome_json FROM bot_maintenance_runs WHERE home_thread_id = ${home} ORDER BY started_at, rowid`;
  return rows.map((row) => ({
    status: row.status,
    outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json),
  }));
});

const homeRun = Effect.fn("fixture.homeRun")(function* (id: string, status: string) {
  const main = yield* SqlClient.SqlClient;
  yield* main`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
    VALUES (${id}, ${home}, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${home}), 'codex', ${status}, ${now}, '{}')`;
});

const homeTurnItem = Effect.fn("fixture.homeTurnItem")(function* (
  id: string,
  item: {
    readonly run: string;
    readonly type: string;
    readonly status: string;
    readonly input: unknown;
  },
) {
  const main = yield* SqlClient.SqlClient;
  yield* main`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, node_id, provider_turn_id, ordinal, type, status, updated_at, payload_json)
    VALUES (${id}, ${home}, ${item.run}, 'node-busy', NULL, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM orchestration_v2_projection_turn_items WHERE thread_id = ${home}), ${item.type}, ${item.status}, ${now}, ${JSON.stringify({ input: item.input })})`;
});

/** A Home provider thread on a live session, so the runtime's background-work probe runs. */
const homeProviderThread = Effect.gen(function* () {
  const main = yield* SqlClient.SqlClient;
  const payload = {
    id: "provider-thread-home",
    driver: "codex",
    providerInstanceId: "codex",
    providerSessionId: "session",
    appThreadId: home,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  yield* main`INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, provider, provider_session_id, status, updated_at, payload_json)
    VALUES ('provider-thread-home', ${home}, 'codex', 'session', 'idle', ${now}, ${JSON.stringify(payload)})`;
});

it.effect.each<{
  readonly name: string;
  readonly activity: string | null;
  readonly arrange: (
    runtimeBackgroundWork: Ref.Ref<boolean>,
  ) => Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient | BotDatabase.BotDatabase>;
}>([
  { name: "a queued run", activity: "run", arrange: () => homeRun("busy", "queued") },
  { name: "a preparing run", activity: "run", arrange: () => homeRun("busy", "preparing") },
  { name: "a running run", activity: "run", arrange: () => homeRun("busy", "running") },
  {
    name: "a run awaiting checkpoints",
    activity: "run",
    arrange: () => homeRun("busy", "waiting"),
  },
  {
    name: "a pending approval",
    activity: "request",
    arrange: () =>
      SqlClient.SqlClient.pipe(
        Effect.flatMap(
          (main) =>
            main`INSERT INTO orchestration_v2_projection_runtime_requests (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
              VALUES ('request', ${home}, 'node-busy', 'approval', 'pending', ${now}, '{}')`,
        ),
      ),
  },
  {
    name: "a running child",
    activity: "child",
    arrange: () =>
      SqlClient.SqlClient.pipe(
        Effect.flatMap(
          (main) =>
            main`INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json)
              VALUES ('child', ${home}, 'node-busy', 'codex', 'app_owned', 'running', ${now}, '{}')`,
        ),
      ),
  },
  { name: "an unfinished Bot task", activity: "task", arrange: () => task("work", "running") },
  {
    name: "a background command",
    activity: "background",
    arrange: () =>
      homeTurnItem("command", {
        run: "run-ask",
        type: "command_execution",
        status: "running",
        input: "vp run dev",
      }),
  },
  {
    name: "background work only the provider runtime knows",
    activity: "background",
    arrange: (runtimeBackgroundWork) =>
      homeProviderThread.pipe(Effect.andThen(Ref.set(runtimeBackgroundWork, true))),
  },
  {
    name: "only settled activity, a persistent tool and a rolled-back command",
    activity: null,
    arrange: (runtimeBackgroundWork) =>
      Effect.gen(function* () {
        const main = yield* SqlClient.SqlClient;
        yield* homeRun("done", "completed");
        yield* main`INSERT INTO orchestration_v2_projection_runtime_requests (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
          VALUES ('request', ${home}, 'node-busy', 'approval', 'resolved', ${now}, '{}')`;
        yield* main`INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json)
          VALUES ('child', ${home}, 'node-busy', 'codex', 'app_owned', 'completed', ${now}, '{}')`;
        yield* task("work", "completed");
        yield* homeTurnItem("watch", {
          run: "done",
          type: "dynamic_tool",
          status: "running",
          input: { persistent: true },
        });
        yield* homeRun("undone", "rolled_back");
        yield* homeTurnItem("command", {
          run: "undone",
          type: "command_execution",
          status: "running",
          input: "vp run dev",
        });
        yield* homeProviderThread;
        yield* Ref.set(runtimeBackgroundWork, false);
      }),
  },
])("defers a pass without a model call while the Home has $name", ({ activity, arrange }) =>
  Effect.gen(function* () {
    yield* seedBot("automatic");
    const { packets, generate } = yield* recordingGenerator(() =>
      Effect.succeed({ operations: [add("i1", "open every session recap", goldLesson)] }),
    );
    yield* withEngine(generate, ({ maintenance, runtimeBackgroundWork }) =>
      Effect.gen(function* () {
        yield* enable(maintenance);
        yield* input("ask", gold);
        yield* arrange(runtimeBackgroundWork);
        const pass = yield* maintenance.runNow(scope);
        const [run, ...otherRuns] = yield* runOutcomes;
        assert.deepEqual(otherRuns, []);
        assert.deepEqual(
          {
            status: pass.status,
            reason: pass.status === "deferred" ? pass.reason : null,
            activity: (run?.outcome?.activity as string | undefined) ?? null,
            calls: (yield* Ref.get(packets)).length,
            lessons: (yield* learningRows).length,
            ask: (yield* sourceStates).ask ?? "missing",
          },
          {
            status: activity === null ? "applied" : "deferred",
            reason: activity === null ? null : "home_active",
            activity,
            calls: activity === null ? 1 : 0,
            lessons: activity === null ? 1 : 0,
            ask: activity === null ? "applied" : "pending",
          },
        );
      }),
    );
  }).pipe(Effect.provide(storeOnly)),
);

it.effect.each<{
  readonly name: string;
  readonly meanwhile: (
    homeSequence: Ref.Ref<number>,
  ) => Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>;
}>([
  {
    // Provider events commit without the Home command lock, so only the sequence shows them.
    name: "a whole turn ran and settled",
    meanwhile: (homeSequence) =>
      input("meanwhile", "Keep recaps under a page.").pipe(
        Effect.andThen(Ref.update(homeSequence, (sequence) => sequence + 3)),
      ),
  },
  {
    name: "a turn is still running",
    meanwhile: () => homeRun("meanwhile", "running"),
  },
])(
  "defers applying a proposal when the Home was busy while the model worked: $name",
  ({ meanwhile }) =>
    Effect.gen(function* () {
      yield* seedBot("automatic");
      const duringGeneration = yield* Ref.make<Effect.Effect<void>>(Effect.void);
      yield* withEngine(
        () =>
          Ref.get(duringGeneration).pipe(
            Effect.flatten,
            Effect.as({ operations: [add("i1", "open every session recap", goldLesson)] }),
          ),
        ({ maintenance, homeSequence }) =>
          Effect.gen(function* () {
            yield* enable(maintenance);
            yield* input("ask", gold);
            const main = yield* SqlClient.SqlClient;
            yield* Ref.set(
              duringGeneration,
              meanwhile(homeSequence).pipe(
                Effect.provideService(SqlClient.SqlClient, main),
                Effect.orDie,
              ),
            );
            const pass = yield* maintenance.runNow(scope);
            assert.deepEqual(
              {
                status: pass.status,
                reason: pass.status === "deferred" ? pass.reason : null,
                lessons: (yield* learningRows).length,
                receipts: (yield* sourceStates).ask,
              },
              { status: "deferred", reason: "home_active", lessons: 0, receipts: "pending" },
            );
          }),
      );
    }).pipe(Effect.provide(storeOnly)),
);

const pruneSettledEffects = EffectOutbox.EffectOutboxV2.pipe(
  Effect.flatMap((outbox) => outbox.pruneSettled),
  Effect.provide(EffectOutbox.layer),
);

it.effect.each([
  { runStatus: "failed", pruned: false },
  { runStatus: "cancelled", pruned: false },
  { runStatus: "failed", pruned: true },
  { runStatus: "cancelled", pruned: true },
] as const)(
  "never learns a steer cancelled before delivery after its run ended $runStatus (pruned: $pruned)",
  ({ runStatus, pruned }) =>
    Effect.gen(function* () {
      yield* seedBot("automatic");
      const { packets, generate } = yield* recordingGenerator(() =>
        Effect.succeed({ operations: [add("i1", "open every session recap", goldLesson)] }),
      );
      yield* withEngine(generate, ({ maintenance }) =>
        Effect.gen(function* () {
          yield* enable(maintenance);
          yield* input("steer", gold, { runStatus, steer: "pending" });
          const cancelled = yield* EffectOutbox.EffectOutboxV2.pipe(
            Effect.flatMap((outbox) =>
              outbox.cancelUnsettled({
                threadId: home,
                effectTypes: ["provider-turn.steer"],
                reason: "Provider process lost before the steer reached it.",
              }),
            ),
            Effect.provide(EffectOutbox.layer),
          );
          assert.deepEqual(cancelled, ["effect-steer"]);
          if (pruned) yield* TestClock.adjust("8 days");
          assert.equal(yield* pruneSettledEffects, pruned ? 1 : 0);

          const result = yield* maintenance.runNow(scope);
          assert.deepEqual(
            {
              status: result.status,
              calls: (yield* Ref.get(packets)).length,
              lessons: (yield* learningRows).length,
            },
            { status: "idle", calls: 0, lessons: 0 },
          );
        }),
      );
    }).pipe(Effect.provide(storeOnly)),
);

it.effect.each([
  { ending: "completed", observed: false, paused: true },
  { ending: "failed", observed: false, paused: true },
  { ending: "cancelled", observed: false, paused: true },
  { ending: "completed", observed: false, paused: false },
  { ending: "completed", observed: true, paused: true },
  { ending: "failed", observed: true, paused: true },
  { ending: "cancelled", observed: true, paused: true },
  { ending: "completed", observed: true, paused: false },
] as const)(
  "learns an accepted steer after its run ended $ending and the outbox pruned it (seen by a pass: $observed, paused: $paused)",
  ({ ending, observed, paused }) =>
    Effect.gen(function* () {
      yield* seedBot("automatic");
      const { packets, generate } = yield* recordingGenerator(() =>
        Effect.succeed({ operations: [add("i1", "open every session recap", goldLesson)] }),
      );
      yield* withEngine(generate, ({ maintenance }) =>
        Effect.gen(function* () {
          yield* enable(maintenance);
          const pause = maintenance
            .configure({ ...scope, baseRevision: 1, enabled: false })
            .pipe(Effect.map((result) => result._tag));
          if (paused && !observed) assert.equal(yield* pause, "saved");
          yield* input("steer", gold, { runStatus: "running", steer: "succeeded" });
          if (observed) {
            // Discovery records the receipt even though the busy Home defers the pass.
            const busy = yield* maintenance.runNow(scope);
            assert.deepEqual(busy.status === "deferred" && busy.reason, "home_active");
            assert.deepEqual(yield* sourceStates, { steer: "pending" });
            if (paused) assert.equal(yield* pause, "saved");
          }
          if (paused)
            assert.include((yield* maintenance.runNow(scope).pipe(Effect.flip)).message, "off");

          const main = yield* SqlClient.SqlClient;
          yield* main`UPDATE orchestration_v2_projection_runs SET status = ${ending} WHERE run_id = 'run-steer'`;
          yield* TestClock.adjust("8 days");
          assert.equal(yield* pruneSettledEffects, 1);
          if (paused) yield* maintenance.configure({ ...scope, baseRevision: 2, enabled: true });

          const result = yield* maintenance.runNow(scope);
          assert.deepEqual(
            {
              status: result.status,
              packets: (yield* Ref.get(packets)).map((packet) =>
                packet.sources.map((source) => source.text),
              ),
              lessons: (yield* learningRows).length,
              receipts: yield* sourceStates,
            },
            { status: "applied", packets: [[gold]], lessons: 1, receipts: { steer: "applied" } },
          );
        }),
      );
    }).pipe(Effect.provide(storeOnly)),
);

/**
 * Runs the input's pending steer effect through the real control service, executor and outbox.
 * The provider session, the control projection and command dispatch are synthetic.
 */
const executeSteer = Effect.fn("fixture.executeSteer")(function* (
  id: string,
  options: {
    readonly turnStatus: "running" | "completed";
    readonly steerTurn?: Effect.Effect<void>;
    readonly dispatch: ThreadManagementService.ThreadManagementService["Service"]["dispatch"];
  },
) {
  const main = yield* SqlClient.SqlClient;
  yield* main`UPDATE orchestration_v2_effect_outbox SET available_at = '1970-01-01T00:00:00.000Z' WHERE effect_id = ${`effect-${id}`}`;
  const message = {
    id,
    runId: `run-${id}`,
    text: gold,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  };
  const run = { id: `run-${id}`, status: options.turnStatus };
  const control = ProviderTurnControlService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () =>
            Effect.succeed(
              options.steerTurn === undefined
                ? Option.none()
                : Option.some({ steerTurn: () => options.steerTurn } as never),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getProviderControlContext: () =>
            Effect.succeed({
              providerThread: { id: "provider-thread", providerSessionId: "session" },
              providerTurn: {
                id: `turn-${id}`,
                providerThreadId: "provider-thread",
                status: options.turnStatus,
              },
              run,
              message,
            } as never),
        }),
      ),
    ),
  );
  const executor = EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        control,
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(RunFinalizationService.RunFinalizationService)({}),
        Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({}),
        Layer.mock(ProviderTurnStartService.ProviderTurnStartServiceV2)({}),
        Layer.mock(RuntimeRequestService.RuntimeRequestServiceV2)({}),
        Layer.mock(ThreadTitleRegenerationService.ThreadTitleRegenerationService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed({ messages: [message], runs: [run] } as never),
          dispatch: options.dispatch,
        }),
        ServerSettings.layerTest(),
      ),
    ),
  );
  yield* Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const claimed = yield* outbox.claimNext({ workerId: "worker" });
    if (Option.isNone(claimed)) return assert.fail("the steer was not claimable");
    const execution = yield* (yield* EffectWorker.OrchestrationEffectExecutorV2)
      .execute(claimed.value)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("1 minute");
    yield* Fiber.join(execution);
    assert.isTrue(yield* outbox.succeed({ effectId: claimed.value.id, workerId: "worker" }));
    assert.isTrue(Option.isNone(yield* outbox.claimNext({ workerId: "worker" })));
  }).pipe(Effect.provide(Layer.merge(EffectOutbox.layer, executor)));
});

it.effect("never learns a steer whose turn ended first and whose follow-up was refused", () =>
  Effect.gen(function* () {
    yield* seedBot("automatic");
    const { packets, generate } = yield* recordingGenerator(() =>
      Effect.succeed({ operations: [add("i1", "open every session recap", goldLesson)] }),
    );
    yield* withEngine(generate, ({ maintenance }) =>
      Effect.gen(function* () {
        yield* enable(maintenance);
        yield* input("dropped", gold, { steer: "pending" });
        const dispatched = yield* Ref.make<ReadonlyArray<string>>([]);
        // The real control refuses the completed target; the project has since disabled the instance.
        yield* executeSteer("dropped", {
          turnStatus: "completed",
          dispatch: (command) =>
            Ref.update(dispatched, (all) => [...all, command.type]).pipe(
              Effect.andThen(
                command.type === "message.dispatch"
                  ? new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                      projectId: scope.projectId,
                      instanceId: ProviderInstanceId.make("codex"),
                    })
                  : Effect.succeed({ sequence: 1, storedEvents: [] }),
              ),
            ),
        });
        assert.deepEqual(yield* Ref.get(dispatched), ["message.dispatch"]);

        const result = yield* maintenance.runNow(scope);
        assert.deepEqual(
          {
            status: result.status,
            calls: (yield* Ref.get(packets)).length,
            lessons: (yield* learningRows).length,
            receipts: yield* sourceStates,
          },
          { status: "idle", calls: 0, lessons: 0, receipts: { dropped: "pending" } },
        );
      }),
    );
  }).pipe(Effect.provide(storeOnly)),
);

it.effect(
  "keeps a cancelled steer whose acceptance was never recorded until the record lands",
  () =>
    Effect.gen(function* () {
      yield* seedBot("automatic");
      const { packets, generate } = yield* recordingGenerator(() =>
        Effect.succeed({ operations: [add("i1", "open every session recap", goldLesson)] }),
      );
      yield* withEngine(generate, ({ maintenance }) =>
        Effect.gen(function* () {
          yield* enable(maintenance);
          yield* input("unrecorded", gold, { runStatus: "running", steer: "pending" });
          const steers = yield* Ref.make(0);
          const records = yield* Ref.make(0);
          yield* executeSteer("unrecorded", {
            turnStatus: "running",
            steerTurn: Ref.update(steers, (n) => n + 1),
            dispatch: (command) =>
              Ref.update(records, (n) => n + 1).pipe(
                Effect.andThen(
                  new Orchestrator.OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                  }),
                ),
              ),
          });
          assert.equal(yield* Ref.get(steers), 1);
          assert.isAbove(yield* Ref.get(records), 0);

          const main = yield* SqlClient.SqlClient;
          yield* main`UPDATE orchestration_v2_projection_runs SET status = 'cancelled' WHERE run_id = 'run-unrecorded'`;
          const outcome = Effect.gen(function* () {
            const result = yield* maintenance.runNow(scope);
            return {
              status: result.status,
              calls: (yield* Ref.get(packets)).length,
              lessons: (yield* learningRows).length,
              receipts: yield* sourceStates,
            };
          });
          assert.deepEqual(yield* outcome, {
            status: "idle",
            calls: 0,
            lessons: 0,
            receipts: { unrecorded: "pending" },
          });

          // The acceptance a later successful `message.steer.accept` would project.
          yield* main`UPDATE orchestration_v2_projection_turn_items SET payload_json = json_set(payload_json, '$.steerAcceptedAt', ${now})
          WHERE turn_item_id = ${IdAllocator.derive.userTurnItem({ messageId: MessageId.make("unrecorded") })}`;
          assert.deepEqual(yield* outcome, {
            status: "applied",
            calls: 1,
            lessons: 1,
            receipts: { unrecorded: "applied" },
          });
        }),
      );
    }).pipe(Effect.provide(storeOnly)),
);

it.effect("keeps a project fact out of the Bot's other projects", () =>
  Effect.gen(function* () {
    yield* seedBot("automatic");
    const fact = "The campaign starts in Barovia.";
    const { packets, generate } = yield* recordingGenerator((packet) =>
      Effect.succeed({
        operations:
          packet.projectId === "project" ? [add("i1", "starts in Barovia", fact, "fact")] : [],
      }),
    );
    yield* withEngine(generate, ({ maintenance, turnContext }) =>
      Effect.gen(function* () {
        yield* enable(maintenance);
        yield* enable(maintenance, otherScope);
        yield* input("barovia", "Remember: this campaign starts in Barovia.");
        yield* input("elsewhere", "Here we start in Waterdeep.", { thread: otherHome });
        assert.equal((yield* maintenance.runNow(scope)).status, "applied");
        assert.equal((yield* maintenance.runNow(otherScope)).status, "noop");
        assert.deepEqual((yield* Ref.get(packets))[1]?.learning, []);
        assert.include(yield* instructionsAt(turnContext), fact);
        assert.notInclude(yield* instructionsAt(turnContext, otherHome), fact);
      }),
    );
  }).pipe(Effect.provide(storeOnly)),
);

it.effect(
  "resumes after a crash during generation or before its receipts commit without applying twice",
  () =>
    Effect.gen(function* () {
      yield* seedBot("automatic");
      const valid = () =>
        Effect.succeed({ operations: [add("i1", "open every session recap", goldLesson)] });
      const generating = yield* Deferred.make<void>();
      yield* withEngine(
        () => Deferred.succeed(generating, undefined).pipe(Effect.andThen(Effect.never)),
        ({ maintenance }) =>
          Effect.gen(function* () {
            yield* enable(maintenance);
            yield* input("ask", gold);
            const crashed = yield* maintenance.runNow(scope).pipe(Effect.forkChild);
            yield* Deferred.await(generating);
            yield* Fiber.interrupt(crashed);
          }),
      );
      assert.deepEqual(yield* runStatuses, ["running"]);
      assert.deepEqual(yield* sourceStates, { ask: "pending" });

      // The learning write succeeds, then the receipt write fails inside the same transaction.
      const bots = yield* BotDatabase.BotDatabase;
      yield* bots`CREATE TRIGGER crash_before_receipt BEFORE UPDATE OF state ON bot_maintenance_sources
        WHEN NEW.state = 'applied' BEGIN SELECT RAISE(ABORT, 'crash before receipt'); END`;
      const { packets, generate } = yield* recordingGenerator(valid);
      yield* withEngine(generate, ({ maintenance }) =>
        Effect.gen(function* () {
          yield* maintenance.runNow(scope).pipe(Effect.flip);
          assert.deepEqual(yield* learningRows, []);
          assert.deepEqual(yield* sourceStates, { ask: "pending" });
        }),
      );
      yield* bots`DROP TRIGGER crash_before_receipt`;

      yield* withEngine(generate, ({ maintenance }) =>
        Effect.gen(function* () {
          const pass = yield* maintenance.runNow(scope);
          assert.equal(pass.status, "applied");
          assert.deepEqual(yield* runStatuses, ["interrupted", "interrupted", "applied"]);
          assert.deepEqual(yield* sourceStates, { ask: "applied" });
          assert.deepEqual(
            (yield* learningRows).map((row) => row.text),
            [goldLesson],
          );
          assert.deepEqual(yield* maintenance.runNow(scope), { status: "idle" });
          assert.equal((yield* Ref.get(packets)).length, 2);
        }),
      );
    }).pipe(Effect.provide(storeOnly)),
);

it.effect("keeps changed, rejected and oversized input eligible instead of consuming it", () =>
  Effect.gen(function* () {
    yield* seedBot("automatic");
    const main = yield* SqlClient.SqlClient;
    const bots = yield* BotDatabase.BotDatabase;
    const responses = yield* Ref.make<ReadonlyArray<Effect.Effect<unknown>>>([]);
    const { packets, generate } = yield* recordingGenerator(() =>
      Ref.modify(responses, ([next, ...rest]) => [next ?? Effect.die("no response"), rest]).pipe(
        Effect.flatten,
      ),
    );
    const valid = {
      operations: [add("i1", "the gold total and XP", "Open recaps with gold and XP.")],
    };
    yield* withEngine(generate, ({ maintenance, bots: service }) =>
      Effect.gen(function* () {
        yield* Ref.set(responses, [
          // The user edits the message while the model is working on the old text.
          main`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.text', 'From now on, open every session recap with the gold total and XP.') WHERE message_id = 'ask'`.pipe(
            Effect.orDie,
            Effect.as({ operations: [add("i1", "open every session recap", goldLesson)] }),
          ),
          Effect.succeed({ operations: [add("i1", "a quote the user never wrote", goldLesson)] }),
          // The user records their own instruction while the model is working.
          service
            .recordLearning({
              ...scope,
              kind: "fact",
              text: "Use metric units.",
              origin: "instruction",
              source: { kind: "user" },
            })
            .pipe(Effect.orDie, Effect.as(valid)),
          // The user tightens the Bot's instructions, then the project's guidance.
          bots`UPDATE bots SET instructions = 'Never include finances in recaps.' WHERE bot_id = 'bot'`.pipe(
            Effect.orDie,
            Effect.as(valid),
          ),
          bots`UPDATE bot_project_contexts SET guidance = 'Recaps stay spoiler-free.' WHERE home_thread_id = ${home}`.pipe(
            Effect.orDie,
            Effect.as(valid),
          ),
          // The user pauses maintenance while the model is working.
          bots`UPDATE bot_maintenance SET enabled = 0, settings_revision = settings_revision + 1`.pipe(
            Effect.orDie,
            Effect.as(valid),
          ),
          Effect.succeed(valid),
        ]);
        yield* enable(maintenance);
        yield* input("ask", gold);
        const changed = yield* maintenance.runNow(scope);
        assert.deepEqual(changed.status === "deferred" && changed.reason, "source_changed");
        const rejected = yield* maintenance.runNow(scope);
        assert.deepEqual(rejected.status === "failed" && rejected.reason, "quote_not_in_source");
        for (const _change of ["learning", "instructions", "guidance"]) {
          const changedBasis = yield* maintenance.runNow(scope);
          assert.deepEqual(
            changedBasis.status === "deferred" && changedBasis.reason,
            "basis_changed",
          );
        }
        const paused = yield* maintenance.runNow(scope);
        assert.deepEqual(paused.status === "deferred" && paused.reason, "settings_changed");
        assert.deepEqual(
          (yield* learningRows).map((row) => row.text),
          ["Use metric units."],
        );
        assert.deepEqual(yield* sourceStates, { ask: "pending" });

        yield* maintenance.configure({ ...scope, baseRevision: 2, enabled: true });
        assert.equal((yield* maintenance.runNow(scope)).status, "applied");
        assert.deepEqual(
          (yield* learningRows).map((row) => row.text),
          ["Use metric units.", "Open recaps with gold and XP."],
        );
        assert.deepEqual(yield* runStatuses, [
          "deferred",
          "failed",
          "deferred",
          "deferred",
          "deferred",
          "deferred",
          "applied",
        ]);
        const applied = (yield* Ref.get(packets)).at(-1);
        assert.deepEqual(
          [applied?.instructions, applied?.guidance],
          ["Never include finances in recaps.", "Recaps stay spoiler-free."],
        );

        yield* input("huge", "x".repeat(48_001), { at: later(5) });
        const oversized = yield* maintenance.runNow(scope);
        assert.deepEqual(oversized.status === "deferred" && oversized.reason, "oversized_evidence");
        assert.equal((yield* Ref.get(packets)).length, 7);
        assert.equal((yield* sourceStates).huge, "pending");
      }),
    );
  }).pipe(Effect.provide(storeOnly)),
);

it.effect("never lets an inferred lesson override or sidestep a standing instruction", () =>
  Effect.gen(function* () {
    yield* seedBot("automatic");
    const rule = "Recaps start with the session date.";
    const { generate } = yield* recordingGenerator((packet) =>
      Effect.succeed({
        operations: [
          {
            op: "replace",
            target: packet.learning.find((entry) => entry.text === rule)?.key ?? "missing",
            text: goldLesson,
            rationale: "",
            evidence: [{ source: "i1", quote: "open every session recap" }],
          },
          add("i1", "with the party's gold total", "Mention the gold total early."),
          add("i1", "the party's gold total", "The party tracks a gold total.", "fact"),
        ],
      }),
    );
    yield* withEngine(generate, ({ maintenance, turnContext, bots }) =>
      Effect.gen(function* () {
        yield* bots.recordLearning({
          ...scope,
          kind: "preference",
          text: rule,
          origin: "instruction",
          source: { kind: "user" },
        });
        yield* enable(maintenance);
        yield* input("ask", gold);
        const pass = yield* maintenance.runNow(scope);
        assert.deepEqual(pass.status === "applied" && pass.outcome, {
          sources: 1,
          active: 1,
          pending: 2,
          stale: 0,
          duplicate: 0,
        });
        assert.deepEqual(
          (yield* learningRows).map((row) => [row.text, row.origin, row.status]),
          [
            [rule, "instruction", "active"],
            [goldLesson, "correction", "pending"],
            ["Mention the gold total early.", "correction", "pending"],
            ["The party tracks a gold total.", "correction", "active"],
          ],
        );
        const instructions = yield* instructionsAt(turnContext);
        assert.include(instructions, rule);
        assert.include(instructions, "The party tracks a gold total.");
        assert.notInclude(instructions, goldLesson);
      }),
    );
  }).pipe(Effect.provide(storeOnly)),
);

it.effect(
  "keeps input that failed before delivery pending without holding back later input, and learns it once a retry delivers it",
  () =>
    Effect.gen(function* () {
      yield* seedBot("automatic");
      const { packets, generate } = yield* recordingGenerator(() =>
        Effect.succeed({ operations: [] }),
      );
      yield* withEngine(generate, ({ maintenance }) =>
        Effect.gen(function* () {
          const main = yield* SqlClient.SqlClient;
          yield* enable(maintenance);
          yield* input("retried", gold, { at: later(1), runStatus: "failed", delivered: false });
          yield* input("after", "Keep recaps under a page.", { at: later(2) });
          assert.equal((yield* maintenance.runNow(scope)).status, "noop");

          // A retry in progress keeps the Home busy, so nothing admitted after it is learned yet.
          yield* main`UPDATE orchestration_v2_projection_runs SET status = 'preparing' WHERE run_id = 'run-retried'`;
          yield* input("during", "Use the party's names.", { at: later(3) });
          const busy = yield* maintenance.runNow(scope);
          assert.deepEqual(busy.status === "deferred" && busy.reason, "home_active");

          yield* main`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run-retried'`;
          yield* deliver("retried");
          assert.equal((yield* maintenance.runNow(scope)).status, "noop");
          assert.deepEqual(
            (yield* Ref.get(packets)).map((packet) => packet.sources.map((source) => source.text)),
            [["Keep recaps under a page."], [gold, "Use the party's names."]],
          );
          assert.deepEqual(yield* sourceStates, {
            after: "applied",
            during: "applied",
            retried: "applied",
          });
        }),
      );
    }).pipe(Effect.provide(storeOnly)),
);

it.effect("orders input admitted at the same instant by the Home's own turn order", () =>
  Effect.gen(function* () {
    yield* seedBot("automatic");
    const { packets, generate } = yield* recordingGenerator(() =>
      Effect.succeed({ operations: [] }),
    );
    yield* withEngine(generate, ({ maintenance }) =>
      Effect.gen(function* () {
        const main = yield* SqlClient.SqlClient;
        yield* enable(maintenance);
        yield* input("z-earlier", "Use detailed recaps.", {
          runStatus: "queued",
          delivered: false,
        });
        yield* input("a-later", "Actually use short recaps.");
        const busy = yield* maintenance.runNow(scope);
        assert.deepEqual(busy.status === "deferred" && busy.reason, "home_active");
        assert.deepEqual(yield* Ref.get(packets), []);

        yield* main`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run-z-earlier'`;
        yield* deliver("z-earlier");
        assert.equal((yield* maintenance.runNow(scope)).status, "noop");
        assert.deepEqual(
          (yield* Ref.get(packets)).map((packet) => packet.sources.map((source) => source.text)),
          [["Use detailed recaps.", "Actually use short recaps."]],
        );
      }),
    );
  }).pipe(Effect.provide(storeOnly)),
);
