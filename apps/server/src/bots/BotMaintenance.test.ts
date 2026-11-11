import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BotId,
  type BotLearningPolicy,
  type BotTaskResult,
  MessageId,
  NodeId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  SealedGenerationDiscarded,
  type SealedGenerationFailure,
  type SealedGenerationInput,
  SealedGenerationRefused,
  type SealedRefusalReason,
} from "@t3tools/provider-core/server/sealedGeneration";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as CheckpointRollbackService from "../orchestration-v2/CheckpointRollbackService.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
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
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as BotContinuation from "./BotContinuation.ts";
import * as BotHomes from "./BotHomes.ts";
import * as BotProjectGuard from "./BotProjectGuard.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as BotMigrations from "./persistence/Migrations.ts";
import * as BotMaintenance from "./BotMaintenance.ts";
import * as Evidence from "./BotMaintenanceEvidence.ts";
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
// Settings tests never learn or schedule, so these services are inert here.
const inertLearning = Layer.mergeAll(
  Layer.mock(BotService.BotService)({}),
  Layer.mock(BotTaskService.BotTaskService)({}),
  Layer.mock(BotContinuation.BotContinuation)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(EventSink.EventSinkV2)({}),
  Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
);

type TestGenerator = (packet: Evidence.Packet) => Effect.Effect<unknown, SealedGenerationFailure>;

/** A provider instance with a fake sealed generation that answers from `generate`. */
const sealedInstance = (options: {
  readonly availability?: Effect.Effect<SealedRefusalReason | null>;
  readonly generate?: TestGenerator;
  readonly calls?: Ref.Ref<ReadonlyArray<SealedGenerationInput<Schema.Top>>>;
}) =>
  ({
    driverKind: ProviderDriverKind.make("codex"),
    sealedGeneration: {
      availability: () => options.availability ?? Effect.succeed(null),
      generate: (input: SealedGenerationInput<Schema.Top>) =>
        (options.calls === undefined
          ? Effect.void
          : Ref.update(options.calls, (all) => [...all, input])
        ).pipe(
          Effect.andThen(
            options.generate?.(JSON.parse(input.packet)) ?? Effect.die("this test never generates"),
          ),
          Effect.map((value) => ({ value, model: input.selection.model })),
        ),
    },
  }) as unknown as ProviderInstance;

const registryOf = (instances: Readonly<Record<string, ProviderInstance>>) =>
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (instanceId) => Effect.succeed(instances[instanceId]),
  });

const productionWith = (instances: Readonly<Record<string, ProviderInstance>>) =>
  BotMaintenance.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        EventStore.layer,
        ThreadCommandExecutor.layer,
        EffectOutbox.layer,
        inertLearning,
        registryOf(instances),
      ),
    ),
    Layer.provideMerge(storeOnly),
  );
const production = productionWith({ codex: sealedInstance({}) });
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
  const maintenance = yield* BotMaintenance.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        registryOf({ codex: sealedInstance({}) }),
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
        EffectOutbox.layer,
        DateTime.layerCurrentZoneOffset(0),
      ),
    ),
    Effect.provideService(ThreadCommandExecutor.ThreadCommandExecutor, executor),
  );
  return { maintenance, sequence, snapshots };
});

it.effect.each<{
  readonly name: string;
  readonly instances: Readonly<Record<string, ProviderInstance>>;
  readonly reason: string;
}>([
  { name: "its instance is missing", instances: {}, reason: "instance_unavailable" },
  {
    name: "its instance cannot generate sealed",
    instances: { codex: {} as ProviderInstance },
    reason: "codex_required",
  },
  {
    name: "its Codex account is signed out",
    instances: {
      codex: sealedInstance({ availability: Effect.succeed("provider_signed_out") }),
    },
    reason: "provider_signed_out",
  },
])(
  "stays off by default and refuses enabling while the Bot's model cannot generate: $name",
  ({ instances, reason }) =>
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
        unavailableReason: reason,
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
    }).pipe(Effect.provide(productionWith(instances))),
);

it.effect("asks the Bot's own selected model whether it can generate sealed", () =>
  Effect.gen(function* () {
    yield* seed;
    const maintenance = yield* BotMaintenance.BotMaintenance;
    assert.isNull((yield* maintenance.get(scope)).unavailableReason);
    const store = yield* BotStore.BotStore;
    const bot = yield* store.getBot(scope.botId);
    if (bot === undefined) return assert.fail();
    yield* store.updateBot({
      ...bot,
      model_selection_json: '{"instanceId":"claude","model":"claude-haiku-5-5"}',
    });
    assert.equal((yield* maintenance.get(scope)).unavailableReason, "codex_required");
  }).pipe(
    Effect.provide(productionWith({ codex: sealedInstance({}), claude: {} as ProviderInstance })),
  ),
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
      yield* bots`DROP TABLE bot_home_checks`;
      yield* bots`DELETE FROM effect_sql_migrations WHERE migration_id >= 11`;
      yield* BotMigrations.runMigrations().pipe(Effect.provideService(SqlClient.SqlClient, bots));
      const history = yield* bots<{
        readonly migration_id: number;
        readonly name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepEqual(history.slice(-4, -1), [
        { migration_id: 11, name: "BotMaintenance" },
        { migration_id: 12, name: "BotMaintenanceReceipts" },
        { migration_id: 13, name: "BotMaintenanceNightly" },
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

it.effect("refuses a pass while the Bot's model cannot generate sealed", () =>
  Effect.gen(function* () {
    yield* seed;
    const maintenance = yield* BotMaintenance.BotMaintenance;
    const refused = yield* maintenance.runNow(scope).pipe(Effect.flip);
    assert.include(refused.message, "not available");
  }).pipe(Effect.provide(productionWith({}))),
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
  respond: (packet: Evidence.Packet) => Effect.Effect<unknown, SealedGenerationFailure>,
) {
  const packets = yield* Ref.make<ReadonlyArray<Evidence.Packet>>([]);
  const generate: TestGenerator = (packet) =>
    Ref.update(packets, (all) => [...all, packet]).pipe(Effect.andThen(respond(packet)));
  return { packets, generate };
});

/**
 * Fresh services over the same database each call, as a server restart builds them. The Bot's
 * Codex instance, its sealed generation, the Home's event sequence and the provider runtime's
 * background-work probe are synthetic.
 */
const withEngine = <A, E, R>(
  generate: TestGenerator,
  body: (services: {
    readonly maintenance: BotMaintenance.BotMaintenance["Service"];
    readonly turnContext: BotTurnContext.BotTurnContext["Service"];
    readonly bots: BotService.BotService["Service"];
    readonly homeSequence: Ref.Ref<number>;
    readonly runtimeBackgroundWork: Ref.Ref<boolean>;
    readonly availability: Ref.Ref<SealedRefusalReason | null>;
    /** Runs once at the next availability check, before it answers. */
    readonly availabilityHook: Ref.Ref<Effect.Effect<void>>;
    readonly sealedCalls: Ref.Ref<ReadonlyArray<SealedGenerationInput<Schema.Top>>>;
    /** Runs once when the next pass applies, after its final Home check and before the Bot commit. */
    readonly beforeApply: Ref.Ref<Effect.Effect<void>>;
    /** Runs once at the next lesson write, inside the Bot commit and after its runtime probe. */
    readonly beforeRecord: Ref.Ref<Effect.Effect<void>>;
    /** The provider runtime's start gate, which a background start takes around its roster change. */
    readonly runtimeStarts: Semaphore.Semaphore;
    /** Runtimes for particular provider sessions; every other session gets the shared one above. */
    readonly sessionRuntimes: Ref.Ref<ReadonlyMap<string, object>>;
    readonly executor: KeyedLock.KeyedLock<ThreadId>;
    /** The source maintenance registered with the Scheduler, run by hand in UTC. */
    readonly runScheduled: Effect.Effect<void>;
    /** Answers every orchestration command maintenance dispatches. */
    readonly homeTurns: Ref.Ref<
      ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
    >;
    /** The Home's persisted and live events, as maintenance's subscription reads them. */
    readonly homeEvents: Queue.Queue<OrchestrationV2StoredEvent>;
    /** Each outbox effect maintenance starts waiting on to settle. */
    readonly settling: Queue.Queue<string>;
  }) => Effect.Effect<A, E, R>,
  taskResults: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const executor = yield* KeyedLock.make<ThreadId>();
    const homeSequence = yield* Ref.make(0);
    const runtimeBackgroundWork = yield* Ref.make(false);
    const availability = yield* Ref.make<SealedRefusalReason | null>(null);
    const availabilityHook = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const sealedCalls = yield* Ref.make<ReadonlyArray<SealedGenerationInput<Schema.Top>>>([]);
    const beforeApply = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const beforeRecord = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const runtimeStarts = yield* Semaphore.make(1);
    const sessionRuntimes = yield* Ref.make<ReadonlyMap<string, object>>(new Map());
    const scheduled = yield* Ref.make<ReadonlyArray<readonly [string, Effect.Effect<void>]>>([]);
    const homeTurns = yield* Ref.make<
      ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
    >(() => Effect.die("this test starts no Home turn"));
    const homeEvents = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const settling = yield* Queue.unbounded<string>();
    const bots = yield* BotService.BotService;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const maintenance = yield* BotMaintenance.make.pipe(
      Effect.provideService(ThreadCommandExecutor.ThreadCommandExecutor, executor),
      Effect.provideService(EffectOutbox.EffectOutboxV2, {
        ...outbox,
        awaitSettled: (effectId) =>
          Queue.offer(settling, effectId).pipe(Effect.andThen(outbox.awaitSettled(effectId))),
      }),
      Effect.provideService(ThreadManagementService.ThreadManagementService, {
        dispatch: (command) => Ref.get(homeTurns).pipe(Effect.flatMap((turn) => turn(command))),
      } as ThreadManagementService.ThreadManagementService["Service"]),
      // Like the real sink, a subscription replays what committed after its sequence.
      Effect.provideService(EventSink.EventSinkV2, {
        stream: (filter?: { readonly threadId?: ThreadId; readonly afterSequence?: number }) =>
          Stream.fromQueue(homeEvents).pipe(
            Stream.filter(
              (stored) =>
                stored.sequence > (filter?.afterSequence ?? 0) &&
                stored.event.threadId === filter?.threadId,
            ),
          ),
      } as unknown as EventSink.EventSinkV2["Service"]),
      Effect.provideService(BotService.BotService, {
        ...bots,
        maintainLearning: (target, change) =>
          Ref.getAndSet(beforeApply, Effect.void).pipe(
            Effect.flatten,
            Effect.andThen(
              bots.maintainLearning(target, (learning) =>
                change({
                  ...learning,
                  record: (policy, entry) =>
                    Ref.getAndSet(beforeRecord, Effect.void).pipe(
                      Effect.flatten,
                      Effect.andThen(learning.record(policy, entry)),
                    ),
                }),
              ),
            ),
          ),
      }),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Scheduler.Scheduler)({
            register: <E, R>(name: string, run: Effect.Effect<void, E, R>) =>
              Effect.context<R>().pipe(
                Effect.flatMap((context) =>
                  Ref.update(scheduled, (all) => [
                    ...all,
                    [name, run.pipe(Effect.provideContext(context), Effect.orDie)] as const,
                  ]),
                ),
              ),
          }),
          DateTime.layerCurrentZoneOffset(0),
          registryOf({
            codex: sealedInstance({
              availability: Ref.getAndSet(availabilityHook, Effect.void).pipe(
                Effect.flatten,
                Effect.andThen(Ref.get(availability)),
              ),
              generate,
              calls: sealedCalls,
            }),
          }),
          Layer.mock(EventStore.EventStoreV2)({ latestSequence: () => Ref.get(homeSequence) }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: (id) =>
              Ref.get(sessionRuntimes).pipe(
                Effect.map((runtimes) =>
                  Option.some(
                    (runtimes.get(id) ?? {
                      hasPendingBackgroundWorkForThread: () => Ref.get(runtimeBackgroundWork),
                      holdBackgroundStarts: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                        runtimeStarts.withPermit(effect),
                    }) as never,
                  ),
                ),
              ),
          }),
        ),
      ),
    );
    return yield* body({
      maintenance,
      turnContext: yield* BotTurnContext.BotTurnContext,
      bots,
      homeSequence,
      runtimeBackgroundWork,
      availability,
      availabilityHook,
      sealedCalls,
      beforeApply,
      beforeRecord,
      runtimeStarts,
      sessionRuntimes,
      executor,
      homeTurns,
      homeEvents,
      settling,
      runScheduled: Ref.get(scheduled).pipe(
        Effect.flatMap((sources) => {
          const [entry, ...others] = sources;
          return entry?.[0] === "bot-maintenance" && others.length === 0
            ? entry[1]
            : Effect.die(`expected one bot-maintenance source, got ${sources.length}`);
        }),
      ),
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        BotService.layer,
        BotTurnContext.layer,
        BotContinuation.layer,
        EffectOutbox.layer,
      ).pipe(
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
            // A real Scheduler would replay every 5-second tick when a test moves the clock days ahead.
            Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
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

/** Learning passes only; a nightly note refresh and compaction record their own rows. */
const runStatuses = Effect.gen(function* () {
  const bots = yield* BotDatabase.BotDatabase;
  const rows = yield* bots<{
    readonly status: string;
  }>`SELECT status FROM bot_maintenance_runs WHERE home_thread_id = ${home} AND json_extract(outcome_json, '$.note') IS NULL
    AND json_extract(outcome_json, '$.compact') IS NULL ORDER BY started_at, rowid`;
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
      yield* withEngine(generate, ({ maintenance, turnContext, sealedCalls }) =>
        Effect.gen(function* () {
          yield* enable(maintenance);
          yield* input("ask", gold);
          const pass = yield* maintenance.runNow(scope);
          assert.equal(pass.status, "applied");
          assert.deepEqual(
            (yield* Ref.get(packets)).map((packet) => packet.sources),
            [[{ key: "i1", kind: "home-input", text: gold }]],
          );
          // One call on exactly the Bot's own selection, under the fixed policy and schema.
          const [call] = yield* Ref.get(sealedCalls);
          assert.deepEqual(call?.selection, {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-6-luna",
          });
          assert.equal(call?.instructions, Evidence.MAINTENANCE_POLICY);
          assert.equal(call?.schema, Evidence.Proposal);
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

/** The Home's own thread row, with the lifecycle a test gives it. */
const homeThread = Effect.fn("fixture.homeThread")(function* (lifecycle: {
  readonly archivedAt?: string;
  readonly deletedAt?: string;
  readonly settledAt?: string;
  readonly snoozedUntil?: string;
}) {
  const main = yield* SqlClient.SqlClient;
  yield* main`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, archived_at, deleted_at, payload_json)
    VALUES (${home}, 'project', 'Home', 'codex', 'full-access', 'default', ${now}, ${now}, ${lifecycle.archivedAt ?? null}, ${lifecycle.deletedAt ?? null},
      ${JSON.stringify({ settledAt: lifecycle.settledAt ?? null, snoozedUntil: lifecycle.snoozedUntil ?? null })})`;
});

const homeTransfer = Effect.fn("fixture.homeTransfer")(function* (
  type: "merge_back" | "provider_handoff",
  status: string,
) {
  const main = yield* SqlClient.SqlClient;
  yield* main`INSERT INTO orchestration_v2_projection_context_transfers (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
    VALUES (${`transfer-${type}`}, 'other', ${home}, ${type}, ${status}, ${now}, '{}')`;
});

const homeEffect = Effect.fn("fixture.homeEffect")(function* (type: string, status: string) {
  const main = yield* SqlClient.SqlClient;
  yield* main`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at, completed_at)
    VALUES (${`effect-${type}`}, ${`command-${type}`}, ${home}, ${type}, ${JSON.stringify({ type })}, ${status}, ${now}, ${now}, ${now}, ${status === "succeeded" ? now : null})`;
});

/** A finished task whose result still has to reach the Home, or already did. */
const returningTask = Effect.fn("fixture.returningTask")(function* (finished: boolean) {
  const bots = yield* BotDatabase.BotDatabase;
  yield* task("returning", "completed");
  yield* bots`UPDATE bot_tasks SET result_run_id = 'result', work_thread_id = 'work', return_home_run_id = 'return-run',
    return_home_message_id = 'return-message', return_finished_at = ${finished ? now : null} WHERE task_id = 'returning'`;
});

const homeProviderThreadState = Effect.fn("fixture.homeProviderThreadState")(function* (
  status: string,
  pendingBackgroundTasks: ReadonlyArray<unknown>,
) {
  const main = yield* SqlClient.SqlClient;
  yield* main`UPDATE orchestration_v2_projection_provider_threads SET status = ${status},
    payload_json = json_set(payload_json, '$.status', ${status}, '$.pendingBackgroundTasks', json(${JSON.stringify(pendingBackgroundTasks)}))
    WHERE provider_thread_id = 'provider-thread-home'`;
});

it.effect.each<{
  readonly name: string;
  readonly activity: string | null;
  readonly arrange: (
    runtimeBackgroundWork: Ref.Ref<boolean>,
  ) => Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient | BotDatabase.BotDatabase>;
}>([
  {
    name: "been snoozed",
    activity: "lifecycle",
    arrange: () => homeThread({ snoozedUntil: "2027-01-01T00:00:00.000Z" }),
  },
  { name: "been archived", activity: "lifecycle", arrange: () => homeThread({ archivedAt: now }) },
  { name: "been deleted", activity: "lifecycle", arrange: () => homeThread({ deletedAt: now }) },
  {
    name: "been settled while idle",
    activity: null,
    arrange: () => homeThread({ settledAt: now }),
  },
  {
    name: "a pending merge into it",
    activity: "transfer",
    arrange: () => homeTransfer("merge_back", "pending"),
  },
  {
    name: "a pending provider switch",
    activity: "transfer",
    arrange: () => homeTransfer("provider_handoff", "pending"),
  },
  {
    name: "a pending rollback",
    activity: "effect",
    arrange: () => homeEffect("provider-thread.rollback", "pending"),
  },
  {
    name: "a restart continuation waiting to resume",
    activity: "effect",
    arrange: () => homeEffect("provider-runtime.continue", "running"),
  },
  {
    name: "an active provider thread",
    activity: "provider",
    arrange: () => homeProviderThread.pipe(Effect.andThen(homeProviderThreadState("active", []))),
  },
  {
    name: "background work on its provider thread's roster",
    activity: "provider",
    arrange: () =>
      homeProviderThread.pipe(
        Effect.andThen(homeProviderThreadState("idle", [{ taskId: "bash", kind: "shell" }])),
      ),
  },
  {
    name: "a Bot task result still returning to it",
    activity: "task",
    arrange: () => returningTask(false),
  },
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
        yield* homeThread({ snoozedUntil: "1970-01-01T00:00:00.000Z" });
        yield* homeTransfer("merge_back", "consumed");
        yield* homeEffect("provider-thread.rollback", "succeeded");
        yield* homeEffect("thread-title.generate", "pending");
        yield* returningTask(true);
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

it.effect(
  "a child that starts on the Home after the final check lands after learning commits",
  () =>
    Effect.gen(function* () {
      yield* seedBot("automatic");
      const { generate } = yield* recordingGenerator(() =>
        Effect.succeed({ operations: [add("i1", "open every session recap", goldLesson)] }),
      );
      yield* withEngine(generate, ({ maintenance, beforeApply, executor }) =>
        Effect.gen(function* () {
          yield* enable(maintenance);
          yield* input("ask", gold);
          const main = yield* SqlClient.SqlClient;
          const lockRequested = yield* Deferred.make<void>();
          const ingestorLayer = ProviderEventIngestor.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                EventSink.layer.pipe(
                  Layer.provide(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
                ),
                ProjectionStore.layer,
                IdAllocator.layer,
                BotHomes.layer,
                Layer.succeed(ThreadCommandExecutor.ThreadCommandExecutor, {
                  ...executor,
                  withLock: (key, effect) =>
                    Deferred.succeed(lockRequested, undefined).pipe(
                      Effect.andThen(executor.withLock(key, effect)),
                    ),
                }),
                Layer.mock(GitVcsDriver.GitVcsDriver)({}),
                registryOf({}),
              ),
            ),
          );
          const at = yield* DateTime.now;
          const childStatus = main<{
            readonly status: string;
          }>`SELECT status FROM orchestration_v2_projection_subagents WHERE subagent_id = 'late-child'`.pipe(
            Effect.map((rows) => rows[0]?.status ?? "none"),
          );
          const ingest = (input: ProviderEventIngestor.ProviderEventIngestInput) =>
            ProviderEventIngestor.ProviderEventIngestorV2.pipe(
              Effect.flatMap((ingestor) => ingestor.ingestNormalized(input)),
              Effect.provide(ingestorLayer),
            );
          const childStart = ingest({
            providerSessionId: ProviderSessionId.make("session"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            threadId: home,
            event: {
              type: "subagent.updated",
              driver: ProviderDriverKind.make("codex"),
              subagent: {
                id: NodeId.make("late-child"),
                threadId: home,
                runId: null,
                parentNodeId: NodeId.make("parent"),
                origin: "provider_native",
                createdBy: "agent",
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerThreadId: null,
                childThreadId: null,
                nativeTaskRef: null,
                prompt: "Review",
                title: null,
                model: null,
                status: "running",
                result: null,
                startedAt: at,
                completedAt: null,
                updatedAt: at,
              },
            },
          });
          const services = yield* Effect.context<SqlClient.SqlClient | BotDatabase.BotDatabase>();
          const atFinalCheck = yield* Ref.make({ start: "never", child: "none" });
          const started = yield* Ref.make(Option.none<Fiber.Fiber<unknown>>());
          yield* Ref.set(
            beforeApply,
            Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(childStart.pipe(Effect.orDie));
              yield* Ref.set(started, Option.some(fiber));
              const start = yield* Effect.raceFirst(
                Fiber.join(fiber).pipe(Effect.as("landed")),
                Deferred.await(lockRequested).pipe(Effect.as("waits for the Home lock")),
              );
              yield* Ref.set(atFinalCheck, { start, child: yield* childStatus });
            }).pipe(Effect.orDie, Effect.provideContext(services)),
          );
          const pass = yield* maintenance.runNow(scope);
          assert.deepEqual(yield* Ref.get(atFinalCheck), {
            start: "waits for the Home lock",
            child: "none",
          });
          assert.deepEqual(
            {
              status: pass.status,
              lessons: (yield* learningRows).length,
              ask: (yield* sourceStates).ask,
            },
            { status: "applied", lessons: 1, ask: "applied" },
          );
          const fiber = Option.getOrThrow(yield* Ref.get(started));
          yield* Fiber.join(fiber);
          assert.equal(yield* childStatus, "running");
        }),
      );
    }).pipe(Effect.provide(storeOnly)),
);

it.effect("defers when runtime-only background work starts after the final Home check", () =>
  Effect.gen(function* () {
    yield* seedBot("automatic");
    const { generate } = yield* recordingGenerator(() =>
      Effect.succeed({ operations: [add("i1", "open every session recap", goldLesson)] }),
    );
    yield* withEngine(generate, ({ maintenance, beforeApply, runtimeBackgroundWork }) =>
      Effect.gen(function* () {
        yield* enable(maintenance);
        yield* input("ask", gold);
        yield* homeProviderThread;
        yield* Ref.set(beforeApply, Ref.set(runtimeBackgroundWork, true));
        const pass = yield* maintenance.runNow(scope);
        assert.deepEqual(
          {
            status: pass.status,
            reason: pass.status === "deferred" ? pass.reason : null,
            lessons: (yield* learningRows).length,
            ask: (yield* sourceStates).ask,
          },
          { status: "deferred", reason: "home_active", lessons: 0, ask: "pending" },
        );
      }),
    );
  }).pipe(Effect.provide(storeOnly)),
);

it.effect.each([true, false])(
  "a runtime-only start after the commit's probe lands after learning commits (starts: %s)",
  (starts) =>
    Effect.gen(function* () {
      yield* seedBot("automatic");
      const { generate } = yield* recordingGenerator(() =>
        Effect.succeed({ operations: [add("i1", "open every session recap", goldLesson)] }),
      );
      yield* withEngine(
        generate,
        ({ maintenance, beforeRecord, runtimeBackgroundWork, runtimeStarts, executor }) =>
          Effect.gen(function* () {
            yield* enable(maintenance);
            yield* input("ask", gold);
            yield* homeProviderThread;
            const backgroundAtCommit = yield* Ref.make(false);
            const waiting = yield* Ref.make(Option.none<Fiber.Fiber<void>>());
            const start = Ref.set(runtimeBackgroundWork, starts);
            yield* Ref.set(
              beforeRecord,
              Effect.gen(function* () {
                assert.include(yield* executor.activeKeys, home);
                const landed = yield* runtimeStarts.withPermitsIfAvailable(1)(start);
                if (Option.isNone(landed))
                  yield* Ref.set(
                    waiting,
                    Option.some(yield* Effect.forkChild(runtimeStarts.withPermit(start))),
                  );
                yield* Ref.set(backgroundAtCommit, yield* Ref.get(runtimeBackgroundWork));
              }),
            );
            const pass = yield* maintenance.runNow(scope);
            const fiber = yield* Ref.get(waiting);
            if (Option.isSome(fiber)) yield* Fiber.join(fiber.value);
            assert.deepEqual(
              {
                backgroundAtCommit: yield* Ref.get(backgroundAtCommit),
                status: pass.status,
                lessons: (yield* learningRows).length,
                ask: (yield* sourceStates).ask,
                background: yield* Ref.get(runtimeBackgroundWork),
              },
              {
                backgroundAtCommit: false,
                status: "applied",
                lessons: 1,
                ask: "applied",
                background: starts,
              },
            );
          }),
      );
    }).pipe(Effect.provide(storeOnly)),
);

/** The Home whose pass asks a runtime for its start gate. */
class GateCaller extends Context.Service<GateCaller, ThreadId>()(
  "t3/bots/BotMaintenance.test/GateCaller",
) {}

it.effect("two Homes on the same provider sessions take their start gates in one order", () =>
  Effect.gen(function* () {
    yield* seedBot("automatic");
    const { generate } = yield* recordingGenerator(() =>
      Effect.succeed({ operations: [add("i1", "open every session recap", goldLesson)] }),
    );
    yield* withEngine(generate, ({ maintenance, sessionRuntimes }) =>
      Effect.gen(function* () {
        yield* enable(maintenance);
        yield* enable(maintenance, otherScope);
        yield* input("ask-one", gold);
        yield* input("ask-two", gold, { thread: otherHome });
        const main = yield* SqlClient.SqlClient;
        // The Homes met the two sessions in opposite orders.
        for (const [owner, session] of [
          [home, "A"],
          [home, "B"],
          [otherHome, "B"],
          [otherHome, "A"],
        ] as const) {
          const id = `${owner}:${session}`;
          const payload = {
            id,
            driver: "codex",
            providerInstanceId: session,
            providerSessionId: session,
            appThreadId: owner,
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
            VALUES (${id}, ${owner}, 'codex', ${session}, 'idle', ${now}, ${JSON.stringify(payload)})`;
        }
        const requests = yield* Ref.make<ReadonlyMap<ThreadId, ReadonlyArray<string>>>(new Map());
        const holders = yield* Ref.make<ReadonlyMap<string, ThreadId>>(new Map());
        const tried = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
        const bothTried = yield* Deferred.make<void>();
        const cycle = yield* Deferred.make<void>();
        const markTried = (owner: ThreadId) =>
          Ref.updateAndGet(tried, (all) => new Set(all).add(owner)).pipe(
            Effect.flatMap((all) =>
              all.size === 2 ? Deferred.succeed(bothTried, undefined) : Effect.void,
            ),
          );
        // Each pass holds its first gate until both passes have tried theirs.
        const runtime = (session: string) =>
          Semaphore.make(1).pipe(
            Effect.map((permit) => ({
              hasPendingBackgroundWorkForThread: () => Effect.succeed(false),
              holdBackgroundStarts: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                Effect.gen(function* () {
                  const owner = yield* GateCaller;
                  const asked = yield* Ref.updateAndGet(requests, (all) =>
                    new Map(all).set(owner, [...(all.get(owner) ?? []), session]),
                  );
                  const held = yield* Ref.get(holders);
                  const waitsOnTheOther = (pass: ThreadId) => {
                    const [first, second] = asked.get(pass) ?? [];
                    return (
                      second !== undefined &&
                      held.get(first ?? "") === pass &&
                      held.get(second) !== pass
                    );
                  };
                  if (waitsOnTheOther(home) && waitsOnTheOther(otherHome))
                    yield* Deferred.succeed(cycle, undefined);
                  const first = asked.get(owner)?.length === 1;
                  const holding = Ref.update(holders, (all) =>
                    new Map(all).set(session, owner),
                  ).pipe(
                    Effect.andThen(
                      first
                        ? markTried(owner).pipe(Effect.andThen(Deferred.await(bothTried)))
                        : Effect.void,
                    ),
                    Effect.andThen(effect),
                    Effect.ensuring(
                      Ref.update(holders, (all) => {
                        const next = new Map(all);
                        next.delete(session);
                        return next;
                      }),
                    ),
                  );
                  if (first) {
                    const landed = yield* permit.withPermitsIfAvailable(1)(holding);
                    if (Option.isSome(landed)) return landed.value;
                    yield* markTried(owner);
                  }
                  return yield* permit.withPermit(holding);
                }),
            })),
          );
        yield* Ref.set(
          sessionRuntimes,
          new Map([
            ["A", yield* runtime("A")],
            ["B", yield* runtime("B")],
          ]),
        );
        const passOf = (target: typeof scope, owner: ThreadId) =>
          maintenance
            .runNow(target)
            .pipe(Effect.provideService(GateCaller, owner), Effect.forkChild);
        const one = yield* passOf(scope, home);
        const two = yield* passOf(otherScope, otherHome);
        const outcome = yield* Effect.raceFirst(
          Deferred.await(cycle).pipe(Effect.as("deadlocked" as const)),
          Effect.all([Fiber.join(one), Fiber.join(two)]).pipe(
            Effect.map((passes) => passes.map((pass) => pass.status)),
          ),
        );
        yield* Fiber.interrupt(one);
        yield* Fiber.interrupt(two);
        assert.deepEqual(outcome, ["applied", "applied"]);
      }),
    );
  }).pipe(Effect.provide(storeOnly)),
);

it.effect("a queued pass generates with the model the Bot has when the pass starts", () =>
  Effect.gen(function* () {
    yield* seedBot("automatic");
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const secondAsked = yield* Deferred.make<void>();
    const calls = yield* Ref.make(0);
    const { generate } = yield* recordingGenerator(() =>
      Ref.getAndUpdate(calls, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          count === 0
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
        Effect.as({ operations: [add("i1", "open every session recap", goldLesson)] }),
      ),
    );
    yield* withEngine(generate, ({ maintenance, availabilityHook, sealedCalls }) =>
      Effect.gen(function* () {
        yield* enable(maintenance);
        yield* input("ask", gold);
        const first = yield* maintenance.runNow(scope).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Ref.set(
          availabilityHook,
          Deferred.succeed(secondAsked, undefined).pipe(Effect.asVoid),
        );
        const second = yield* maintenance.runNow(scope).pipe(Effect.forkChild);
        yield* Deferred.await(secondAsked);
        const bots = yield* BotDatabase.BotDatabase;
        yield* bots`UPDATE bots SET model_selection_json = '{"instanceId":"codex","model":"new-selected-model"}' WHERE bot_id = 'bot'`;
        yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.join(first)).status, "deferred");
        assert.equal((yield* Fiber.join(second)).status, "applied");
        assert.deepEqual(
          (yield* Ref.get(sealedCalls)).map((call) => call.selection.model),
          ["gpt-6-luna", "new-selected-model"],
        );
      }),
    );
  }).pipe(Effect.provide(storeOnly)),
);

it.effect.each([
  { name: "refuses", failure: new SealedGenerationRefused({ reason: "provider_signed_out" }) },
  {
    name: "discards its output",
    failure: new SealedGenerationDiscarded({ reason: "tool_attempt" }),
  },
])(
  "consumes nothing when sealed generation $name, and learns on the next good call",
  ({ failure }) =>
    Effect.gen(function* () {
      yield* seedBot("automatic");
      const failed = yield* Ref.make(false);
      const { packets, generate } = yield* recordingGenerator(() =>
        Ref.getAndSet(failed, true).pipe(
          Effect.flatMap((once) =>
            once
              ? Effect.succeed({ operations: [add("i1", "open every session recap", goldLesson)] })
              : Effect.fail(failure),
          ),
        ),
      );
      yield* withEngine(generate, ({ maintenance }) =>
        Effect.gen(function* () {
          yield* enable(maintenance);
          yield* input("ask", gold);
          const pass = yield* maintenance.runNow(scope);
          assert.deepEqual(pass.status === "failed" && pass.reason, "generation_failed");
          assert.deepEqual(yield* learningRows, []);
          assert.deepEqual(yield* sourceStates, { ask: "pending" });
          assert.deepEqual(
            (yield* runOutcomes).map((run) => run.outcome),
            [{ reason: "generation_failed", detail: failure.reason }],
          );

          assert.equal((yield* maintenance.runNow(scope)).status, "applied");
          assert.equal((yield* Ref.get(packets)).length, 2);
          assert.deepEqual(yield* sourceStates, { ask: "applied" });
        }),
      );
    }).pipe(Effect.provide(storeOnly)),
);

it.effect(
  "refuses a pass without discovery or a model call once the Bot's provider stops being able to generate",
  () =>
    Effect.gen(function* () {
      yield* seedBot("automatic");
      const { packets, generate } = yield* recordingGenerator(() =>
        Effect.succeed({ operations: [] }),
      );
      yield* withEngine(generate, ({ maintenance, availability }) =>
        Effect.gen(function* () {
          yield* enable(maintenance);
          yield* input("ask", gold);
          yield* Ref.set(availability, "provider_signed_out");
          const refused = yield* maintenance.runNow(scope).pipe(Effect.flip);
          assert.include(refused.message, "not available");
          assert.equal((yield* maintenance.get(scope)).unavailableReason, "provider_signed_out");
          assert.deepEqual(yield* sourceStates, {});
          assert.deepEqual(yield* Ref.get(packets), []);
        }),
      );
    }).pipe(Effect.provide(storeOnly)),
);

const at = (iso: string) => TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(iso)));
const sourceTexts = (packets: Ref.Ref<ReadonlyArray<Evidence.Packet>>) =>
  Ref.get(packets).pipe(
    Effect.map((all) => all.map((packet) => packet.sources.map((source) => source.text))),
  );

it.effect(
  "runs one nightly pass per enabled Bot project at 03:00 and coalesces missed nights",
  () =>
    Effect.gen(function* () {
      yield* seedBot("automatic");
      const { packets, generate } = yield* recordingGenerator(() =>
        Effect.succeed({ operations: [] }),
      );
      yield* withEngine(generate, ({ maintenance, runScheduled }) =>
        Effect.gen(function* () {
          yield* at("2026-11-09T14:00:00.000Z");
          yield* enable(maintenance);
          yield* input("ask", gold);
          yield* input("elsewhere", "Here we start in Waterdeep.", { thread: otherHome });
          yield* runScheduled;
          yield* at("2026-11-10T02:59:00.000Z");
          yield* runScheduled;
          assert.deepEqual(yield* Ref.get(packets), []);

          yield* at("2026-11-10T03:00:00.000Z");
          yield* runScheduled;
          yield* runScheduled;
          assert.deepEqual(yield* sourceTexts(packets), [[gold]]);

          // Three nights pass while the server is down: one pass on return, not three.
          yield* input("later", "Keep recaps under a page.", { at: later(5) });
          yield* at("2026-11-13T09:00:00.000Z");
          yield* runScheduled;
          yield* runScheduled;
          assert.deepEqual(yield* sourceTexts(packets), [[gold], ["Keep recaps under a page."]]);
          assert.deepEqual(yield* runStatuses, ["noop", "noop"]);
        }),
      );
    }).pipe(Effect.provide(storeOnly)),
);

it.effect(
  "skips the night while the Bot is paused, its model cannot generate or its Home is busy",
  () =>
    Effect.gen(function* () {
      yield* seedBot("automatic");
      const { packets, generate } = yield* recordingGenerator(() =>
        Effect.succeed({ operations: [] }),
      );
      yield* withEngine(generate, ({ maintenance, runScheduled, availability }) =>
        Effect.gen(function* () {
          const main = yield* SqlClient.SqlClient;
          yield* at("2026-11-09T14:00:00.000Z");
          yield* enable(maintenance);
          yield* input("ask", gold);
          yield* maintenance.configure({ ...scope, baseRevision: 1, enabled: false });
          yield* at("2026-11-10T03:00:00.000Z");
          yield* runScheduled;

          // Resuming starts the schedule over, so the next pass waits for the next 03:00.
          yield* at("2026-11-10T04:00:00.000Z");
          yield* maintenance.configure({ ...scope, baseRevision: 2, enabled: true });
          yield* runScheduled;

          yield* Ref.set(availability, "provider_signed_out");
          yield* at("2026-11-11T03:00:00.000Z");
          yield* runScheduled;
          yield* Ref.set(availability, null);
          yield* at("2026-11-11T03:30:00.000Z");
          yield* runScheduled;

          yield* homeRun("busy", "running");
          yield* at("2026-11-12T03:00:00.000Z");
          yield* runScheduled;
          yield* main`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'busy'`;
          yield* at("2026-11-12T08:00:00.000Z");
          yield* runScheduled;
          assert.deepEqual(yield* Ref.get(packets), []);
          assert.deepEqual(yield* runStatuses, ["deferred"]);

          yield* at("2026-11-13T03:00:00.000Z");
          yield* runScheduled;
          assert.deepEqual(yield* sourceTexts(packets), [[gold]]);
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
        assert.deepEqual(yield* Ref.get(dispatched), ["message.dispatch", "message.delivery.fail"]);

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

/** A Bot Home on the Bot's Codex instance, on a host that can scope a Home turn. */
const refreshHome = Effect.fn("fixture.refreshHome")(function* (instance = "codex") {
  yield* seedBot("automatic");
  yield* homeThread({});
  const main = yield* SqlClient.SqlClient;
  yield* main`UPDATE orchestration_v2_projection_threads SET provider_instance_id = ${instance} WHERE thread_id = ${home}`;
});

/**
 * Admits `restricted_run.start`, and a message that waits for an idle Home, the way the
 * orchestrator does: only at the captured Home sequence. Opens the run; the test plays its turn.
 */
const scopedTurns = Effect.fn("fixture.scopedTurns")(function* (homeSequence: Ref.Ref<number>) {
  const main = yield* SqlClient.SqlClient;
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const started = yield* Queue.unbounded<string>();
  const dispatch: ThreadManagementService.ThreadManagementService["Service"]["dispatch"] = (
    command,
  ) =>
    Effect.gen(function* () {
      yield* Ref.update(commands, (all) => [...all, command]);
      const sequence = yield* Ref.get(homeSequence);
      if (
        (command.type !== "restricted_run.start" && command.type !== "message.dispatch") ||
        command.ifIdleAtSequence !== sequence
      )
        return { sequence, storedEvents: [], deferred: true } as const;
      const runId = `scoped-${command.messageId}`;
      const restriction = command.type === "restricted_run.start" ? command.restriction : undefined;
      const createdBy = command.type === "message.dispatch" ? command.createdBy : "agent";
      yield* main`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${runId}, ${home}, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${home}), 'codex', 'running', ${now},
          ${JSON.stringify({ userMessageId: command.messageId, restriction, startedAt: now })})`;
      yield* main`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${command.messageId}, ${home}, ${runId}, 'user', 0, ${now}, ${now},
          ${JSON.stringify({ id: command.messageId, threadId: home, runId, nodeId: null, role: "user", text: command.text, attachments: [], streaming: false, createdAt: now, updatedAt: now, createdBy, creationSource: "server" })})`;
      yield* Ref.set(homeSequence, sequence + 1);
      yield* Queue.offer(started, runId);
      return { sequence: sequence + 1, storedEvents: [] };
    }).pipe(Effect.orDie);
  return { dispatch, commands, started };
});

/** Ends the scoped run as its provider turn would, committing and then publishing the event. */
const endScopedRun = Effect.fn("fixture.endScopedRun")(function* (
  runId: string,
  status: string,
  homeSequence: Ref.Ref<number>,
  homeEvents: Queue.Queue<OrchestrationV2StoredEvent>,
) {
  const main = yield* SqlClient.SqlClient;
  yield* main`UPDATE orchestration_v2_projection_runs SET status = ${status} WHERE run_id = ${runId}`;
  const sequence = (yield* Ref.get(homeSequence)) + 1;
  yield* Ref.set(homeSequence, sequence);
  yield* Queue.offer(homeEvents, {
    sequence,
    commandId: null,
    event: { type: "run.updated", threadId: home, runId, payload: { status } },
  } as unknown as OrchestrationV2StoredEvent);
});

/**
 * The save the scoped turn's model makes through t3_bot, with the basis of its read_continuation,
 * or of its Home instructions, which show no source.
 */
const saveNoteAsBot = Effect.fn("fixture.saveNoteAsBot")(function* (
  updateId: string,
  read: "shown" | "unshown" = "shown",
) {
  const notes = yield* BotContinuation.BotContinuation;
  const view = yield* notes.get(scope, { page: read === "shown" });
  return yield* notes.save(
    {
      ...scope,
      updateId,
      baseRevision: view.revision,
      note: { requests: [{ text: "Harbor checklist" }], waiting: [], decided: [], context: [] },
      basis: view.basis!,
      acks: view.uncovered?.sources.flatMap((source) => source.parts.map((part) => part.ack)),
    },
    { kind: "bot", threadId: home },
  );
});

const noteOutcomes = runOutcomes.pipe(
  Effect.map((rows) => rows.filter((row) => row.outcome?.note !== undefined)),
);

it.effect(
  "refreshes a note behind the Home in one scoped turn once learning is done, then finds it current",
  () =>
    Effect.gen(function* () {
      yield* refreshHome();
      const { generate } = yield* recordingGenerator(() => Effect.succeed({ operations: [] }));
      yield* withEngine(generate, ({ maintenance, homeSequence, homeTurns, homeEvents }) =>
        Effect.gen(function* () {
          yield* enable(maintenance);
          const turns = yield* scopedTurns(homeSequence);
          yield* Ref.set(homeTurns, turns.dispatch);
          yield* input("ask", "Draft the Harbor checklist once I send the dates.");
          // Learning still owes this input, so the note waits for it.
          const early = yield* maintenance.refreshNote(scope);
          assert.deepEqual(early.status === "deferred" && early.reason, "learning_pending");
          assert.equal((yield* maintenance.runNow(scope)).status, "noop");

          yield* Ref.set(homeSequence, 7);
          const refresh = yield* maintenance
            .refreshNote(scope)
            .pipe(Effect.forkChild({ startImmediately: true }));
          const runId = yield* Queue.take(turns.started);
          const messageId = `bot-maintenance:note:${home}:7`;
          assert.deepEqual((yield* Ref.get(turns.commands)) as ReadonlyArray<unknown>, [
            {
              type: "restricted_run.start",
              commandId: messageId,
              threadId: home,
              messageId,
              text: BotMaintenance.NOTE_REFRESH_PROMPT,
              restriction: "botNote",
              ifIdleAtSequence: 7,
            },
          ]);
          assert.equal((yield* saveNoteAsBot("refresh"))._tag, "saved");
          yield* endScopedRun(runId, "completed", homeSequence, homeEvents);
          const refreshed = yield* Fiber.join(refresh);
          assert.deepEqual(
            refreshed.status === "refreshed" && refreshed.homeRunId,
            `scoped-${messageId}`,
          );
          assert.deepEqual(
            (yield* noteOutcomes).map((row) => row.outcome),
            [
              { note: "deferred", reason: "learning_pending" },
              { note: "refreshed", homeRunId: runId },
            ],
          );

          // Learning sets the refresh prompt aside as not the user's; then nothing is owed.
          assert.deepEqual(yield* maintenance.runNow(scope), { status: "idle" });
          assert.deepEqual(yield* sourceStates, { ask: "applied", [messageId]: "not_user_input" });
          assert.deepEqual(yield* maintenance.refreshNote(scope), { status: "current" });
          assert.lengthOf(yield* Ref.get(turns.commands), 1);
          assert.lengthOf(yield* noteOutcomes, 2);
        }),
      );
    }).pipe(Effect.provide(storeOnly), Effect.provideService(HostProcess.Platform, "darwin")),
);

it.effect.each([
  { ending: "failed", save: "shown", reason: "run_failed" },
  { ending: "interrupted", save: null, reason: "run_interrupted" },
  { ending: "completed", save: null, reason: "not_saved" },
  { ending: "completed", save: "unshown", reason: "not_shown" },
] as const)(
  "keeps the evidence for the next refresh when the scoped turn ends $ending (save: $save)",
  ({ ending, save, reason }) =>
    Effect.gen(function* () {
      yield* refreshHome();
      const { generate } = yield* recordingGenerator(() => Effect.succeed({ operations: [] }));
      yield* withEngine(generate, ({ maintenance, homeSequence, homeTurns, homeEvents }) =>
        Effect.gen(function* () {
          yield* enable(maintenance);
          const turns = yield* scopedTurns(homeSequence);
          yield* Ref.set(homeTurns, turns.dispatch);
          yield* input("ask", "Draft the Harbor checklist once I send the dates.");
          yield* maintenance.runNow(scope);
          const refresh = yield* maintenance
            .refreshNote(scope)
            .pipe(Effect.forkChild({ startImmediately: true }));
          const runId = yield* Queue.take(turns.started);
          if (save !== null) assert.equal((yield* saveNoteAsBot("refresh", save))._tag, "saved");
          yield* endScopedRun(runId, ending, homeSequence, homeEvents);
          const result = yield* Fiber.join(refresh);
          assert.deepEqual(result.status === "not_refreshed" && result.reason, reason);
          assert.deepEqual(
            (yield* noteOutcomes).map((row) => [row.status, row.outcome]),
            [["failed", { note: "not_refreshed", reason, homeRunId: runId }]],
          );
          // A save made before the run failed still stands; only the outcome reports the failure.
          const notes = yield* BotContinuation.BotContinuation;
          assert.equal(
            (yield* notes.coverage(scope))._tag,
            save === "shown" ? "current" : "behind",
          );

          // Nothing was consumed: the next attempt is a new turn at the Home's new sequence.
          if (save === "shown") return;
          yield* maintenance.runNow(scope);
          const retry = yield* maintenance
            .refreshNote(scope)
            .pipe(Effect.forkChild({ startImmediately: true }));
          const retried = yield* Queue.take(turns.started);
          assert.notEqual(retried, runId);
          assert.equal((yield* saveNoteAsBot("retry"))._tag, "saved");
          yield* endScopedRun(retried, "completed", homeSequence, homeEvents);
          assert.equal((yield* Fiber.join(retry)).status, "refreshed");
        }),
      );
    }).pipe(Effect.provide(storeOnly), Effect.provideService(HostProcess.Platform, "darwin")),
);

it.effect(
  "refreshes at most three pages a night, one scoped turn each, and stops once the Home is busy",
  () =>
    Effect.gen(function* () {
      yield* refreshHome();
      const { generate } = yield* recordingGenerator(() => Effect.succeed({ operations: [] }));
      yield* withEngine(
        generate,
        ({ maintenance, homeSequence, homeTurns, homeEvents, settling }) =>
          Effect.gen(function* () {
            yield* enable(maintenance);
            const turns = yield* scopedTurns(homeSequence);
            yield* Ref.set(homeTurns, turns.dispatch);
            // Each input fills a refresh page of its own.
            for (const id of ["one", "two", "three", "four", "five"])
              yield* input(id, `${id}: ${"Harbor detail. ".repeat(1_300)}`);
            let learned = yield* maintenance.runNow(scope);
            while (learned.status === "partial") learned = yield* maintenance.runNow(scope);
            const notes = yield* BotContinuation.BotContinuation;
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            const main = yield* SqlClient.SqlClient;
            const night = Effect.fn("fixture.night")(function* (
              pages: number,
              busyAfterLast = false,
            ) {
              // As the nightly pass does, learning runs first.
              assert.equal((yield* maintenance.runNow(scope)).status, "idle");
              const refresh = yield* maintenance
                .refreshNote(scope)
                .pipe(Effect.forkChild({ startImmediately: true }));
              const runs: Array<string> = [];
              for (let page = 1; page <= pages; page += 1) {
                const runId = yield* Queue.take(turns.started);
                runs.push(runId);
                assert.equal((yield* saveNoteAsBot(`${runId}-save`))._tag, "saved");
                if (busyAfterLast && page === pages) yield* homeRun("busy", "running");
                // The run completes while its own checkpoint capture and workspace refresh run on.
                const checkpoint = `effect:checkpoint.capture:${runId}`;
                yield* main`INSERT INTO orchestration_v2_effect_outbox
                  (effect_id, command_id, thread_id, effect_type, payload_json, status, lease_owner, available_at, created_at, updated_at)
                  VALUES (${checkpoint}, ${`command:${checkpoint}`}, ${home}, 'checkpoint.capture',
                    ${JSON.stringify({ type: "checkpoint.capture", runId, scopeId: "scope" })}, 'running', 'worker', ${now}, ${now}, ${now})`;
                yield* endScopedRun(runId, "completed", homeSequence, homeEvents);
                // The night's last page needs no wait; every earlier one waits for its own effect.
                if (page < 3)
                  assert.equal(
                    yield* Effect.raceFirst(Queue.take(settling), Fiber.join(refresh)),
                    checkpoint,
                  );
                assert.isTrue(yield* outbox.succeed({ effectId: checkpoint, workerId: "worker" }));
              }
              return { result: yield* Fiber.join(refresh), runs };
            });

            const first = yield* night(3);
            assert.deepEqual(
              first.result.status === "refreshed" && first.result.homeRunId,
              first.runs[2],
            );
            assert.deepEqual(yield* notes.coverage(scope), {
              _tag: "behind",
              inputs: 2,
              results: 0,
            });
            const second = yield* night(1, true);
            assert.deepEqual(
              second.result.status === "deferred" && second.result.reason,
              "home_active",
            );
            assert.deepEqual(
              (yield* noteOutcomes).map((row) => row.outcome),
              [
                ...[...first.runs, ...second.runs].map((homeRunId) => ({
                  note: "refreshed",
                  homeRunId,
                })),
                { note: "deferred", reason: "home_active" },
              ],
            );
            assert.deepEqual(yield* notes.coverage(scope), {
              _tag: "behind",
              inputs: 1,
              results: 0,
            });
            assert.lengthOf(yield* Ref.get(turns.commands), 4);
          }),
      );
    }).pipe(Effect.provide(storeOnly), Effect.provideService(HostProcess.Platform, "darwin")),
);

it.effect.each([
  { name: "a running Home turn", reason: "home_active" },
  { name: "Home input after the captured sequence", reason: "home_active" },
  { name: "a note that leaves no room for a page", reason: "note_too_large" },
  { name: "a Linux host", reason: "unsupported" },
  { name: "a Home on another provider", reason: "unsupported" },
] as const)("defers the refresh without a lasting turn for $name", ({ name, reason }) =>
  Effect.gen(function* () {
    yield* refreshHome(name === "a Home on another provider" ? "claude" : "codex");
    const { generate } = yield* recordingGenerator(() => Effect.succeed({ operations: [] }));
    yield* withEngine(generate, ({ maintenance, homeSequence, homeTurns }) =>
      Effect.gen(function* () {
        const turns = yield* scopedTurns(homeSequence);
        if (name === "a note that leaves no room for a page") {
          // A legal note: JSON writes each control character as six bytes.
          const crowded = "\u0001".repeat(200);
          const item = {
            text: crowded,
            refs: [
              {
                kind: "message",
                messageId: "earlier",
                ordinal: 1,
                digest: "0".repeat(64),
                quote: crowded,
                directUser: true,
                availability: "available",
              },
            ],
          };
          const revision = JSON.stringify({
            revision: 1,
            note: {
              requests: Array.from({ length: 20 }, () => item),
              waiting: [],
              decided: [],
              context: [],
            },
            coverage: null,
            updatedBy: { kind: "user" },
            updatedAt: now,
            restoredFrom: null,
          });
          const bots = yield* BotDatabase.BotDatabase;
          yield* bots`INSERT INTO bot_continuation_revisions (home_thread_id, revision, update_id, request_hash, revision_json) VALUES (${home}, 1, 'crowded', 'crowded', ${revision})`;
        }
        yield* enable(maintenance);
        yield* input("ask", "Draft the Harbor checklist once I send the dates.");
        yield* maintenance.runNow(scope);
        if (name === "a running Home turn") yield* homeRun("busy", "running");
        // The admission refuses because an event committed after the sequence was read.
        const lateInput: typeof turns.dispatch = (command) =>
          Ref.update(homeSequence, (sequence) => sequence + 1).pipe(
            Effect.andThen(turns.dispatch(command)),
          );
        yield* Ref.set(
          homeTurns,
          name === "Home input after the captured sequence" ? lateInput : turns.dispatch,
        );
        const result = yield* maintenance
          .refreshNote(scope)
          .pipe(
            Effect.provideService(
              HostProcess.Platform,
              name === "a Linux host" ? "linux" : "darwin",
            ),
          );
        assert.deepEqual(result.status === "deferred" && result.reason, reason);
        assert.deepEqual(
          (yield* noteOutcomes).map((row) => [row.status, row.outcome]),
          [["deferred", { note: "deferred", reason }]],
        );
        const main = yield* SqlClient.SqlClient;
        assert.deepEqual(
          yield* main`SELECT run_id FROM orchestration_v2_projection_runs WHERE run_id LIKE 'scoped-%'`,
          [],
        );
        assert.lengthOf(
          yield* Ref.get(turns.commands),
          name === "Home input after the captured sequence" ? 1 : 0,
        );
      }),
    );
  }).pipe(Effect.provide(storeOnly)),
);

/** A Home on `driver` whose latest provider turn reported `usage`, or none. */
const compactableHome = Effect.fn("fixture.compactableHome")(function* (
  usage: { readonly usedTokens: number; readonly maxTokens?: number } | null,
  driver = "codex",
) {
  yield* refreshHome(driver);
  const main = yield* SqlClient.SqlClient;
  yield* main`UPDATE orchestration_v2_projection_threads SET active_provider_thread_id = 'home-native' WHERE thread_id = ${home}`;
  yield* main`INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, provider, driver, status, updated_at, payload_json)
    VALUES ('home-native', ${home}, ${driver}, ${driver}, 'idle', ${now}, '{}')`;
  if (usage !== null)
    yield* main`INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, payload_json)
      VALUES ('home-native-turn', ${home}, 'home-native', 'home-native-node', 1, 'completed', ${JSON.stringify({ tokenUsage: { ...usage, updatedAt: now } })})`;
});
const large = { usedTokens: 180_000, maxTokens: 272_000 };

const compactOutcomes = runOutcomes.pipe(
  Effect.map((rows) => rows.filter((row) => row.outcome?.compact !== undefined)),
);

it.effect(
  "compacts a large idle Home only after its learning and note are saved, and only once",
  () =>
    Effect.gen(function* () {
      yield* compactableHome(large);
      const { generate } = yield* recordingGenerator(() =>
        Effect.succeed({ operations: [add("i1", "open every session recap", goldLesson)] }),
      );
      yield* withEngine(generate, ({ maintenance, homeSequence, homeTurns, homeEvents }) =>
        Effect.gen(function* () {
          yield* enable(maintenance);
          const turns = yield* scopedTurns(homeSequence);
          yield* Ref.set(homeTurns, turns.dispatch);
          yield* input("ask", gold);
          const unlearned = yield* maintenance.compactHome(scope);
          assert.deepEqual(unlearned.status === "deferred" && unlearned.reason, "learning_pending");
          assert.equal((yield* maintenance.runNow(scope)).status, "applied");
          const unsaved = yield* maintenance.compactHome(scope);
          assert.deepEqual(unsaved.status === "deferred" && unsaved.reason, "note_behind");

          const refresh = yield* maintenance
            .refreshNote(scope)
            .pipe(Effect.forkChild({ startImmediately: true }));
          const refreshRun = yield* Queue.take(turns.started);
          assert.equal((yield* saveNoteAsBot("refresh"))._tag, "saved");
          yield* endScopedRun(refreshRun, "completed", homeSequence, homeEvents);
          assert.equal((yield* Fiber.join(refresh)).status, "refreshed");
          assert.deepEqual(yield* maintenance.runNow(scope), { status: "idle" });

          yield* Ref.set(homeSequence, 40);
          const compaction = yield* maintenance
            .compactHome(scope)
            .pipe(Effect.forkChild({ startImmediately: true }));
          const runId = yield* Queue.take(turns.started);
          const messageId = `bot-maintenance:compact:${home}:40`;
          assert.deepEqual((yield* Ref.get(turns.commands)).at(-1) as unknown, {
            type: "message.dispatch",
            commandId: messageId,
            threadId: home,
            messageId,
            text: "/compact",
            attachments: [],
            createdBy: "system",
            creationSource: "server",
            dispatchMode: { type: "start_immediately" },
            ifIdleAtSequence: 40,
          });
          yield* endScopedRun(runId, "completed", homeSequence, homeEvents);
          const compacted = yield* Fiber.join(compaction);
          assert.deepEqual(compacted.status === "compacted" && compacted.homeRunId, runId);
          // Preservation committed before the compaction was asked for.
          assert.deepEqual(
            (yield* runOutcomes).map((row) =>
              row.outcome?.compact !== undefined
                ? `compact:${row.outcome.compact}`
                : row.outcome?.note !== undefined
                  ? `note:${row.outcome.note}`
                  : `learning:${row.status}`,
            ),
            [
              "compact:deferred",
              "learning:applied",
              "compact:deferred",
              "note:refreshed",
              "compact:compacted",
            ],
          );
          assert.equal((yield* learningRows).length, 1);

          // Nothing happened since, so the next night leaves the compacted Home alone.
          assert.deepEqual(yield* maintenance.runNow(scope), { status: "idle" });
          assert.deepEqual(yield* maintenance.compactHome(scope), {
            status: "not_needed",
            reason: "already_compacted",
          });
          assert.lengthOf(yield* Ref.get(turns.commands), 2);
          assert.lengthOf(yield* compactOutcomes, 3);
        }),
      );
    }).pipe(Effect.provide(storeOnly), Effect.provideService(HostProcess.Platform, "darwin")),
);

it.effect.each([
  { name: "a small context", usage: { usedTokens: 60_000, maxTokens: 272_000 } },
  { name: "less than half the window", usage: { usedTokens: 130_000, maxTokens: 272_000 } },
  { name: "unknown usage", usage: null },
])("leaves a Home with $name uncompacted, without a turn or a row", ({ usage }) =>
  Effect.gen(function* () {
    yield* compactableHome(usage);
    const { generate } = yield* recordingGenerator(() => Effect.succeed({ operations: [] }));
    yield* withEngine(generate, ({ maintenance, homeSequence, homeTurns }) =>
      Effect.gen(function* () {
        yield* enable(maintenance);
        const turns = yield* scopedTurns(homeSequence);
        yield* Ref.set(homeTurns, turns.dispatch);
        assert.deepEqual(yield* maintenance.compactHome(scope), {
          status: "not_needed",
          reason: usage === null ? "usage_unknown" : "below_threshold",
        });
        assert.lengthOf(yield* Ref.get(turns.commands), 0);
        assert.lengthOf(yield* compactOutcomes, 0);
      }),
    );
  }).pipe(Effect.provide(storeOnly)),
);

it.effect.each([
  { name: "a running Home turn", reason: "home_active" },
  { name: "unlearned Home input", reason: "learning_pending" },
  { name: "a note behind the Home", reason: "note_behind" },
  { name: "Home input after the captured sequence", reason: "home_active" },
  { name: "a Home on another provider", reason: "unsupported" },
] as const)("defers the compaction without a lasting turn for $name", ({ name, reason }) =>
  Effect.gen(function* () {
    yield* compactableHome(large, name === "a Home on another provider" ? "claude" : "codex");
    const { generate } = yield* recordingGenerator(() => Effect.succeed({ operations: [] }));
    yield* withEngine(generate, ({ maintenance, homeSequence, homeTurns }) =>
      Effect.gen(function* () {
        yield* enable(maintenance);
        const turns = yield* scopedTurns(homeSequence);
        if (name === "a running Home turn") yield* homeRun("busy", "running");
        if (name === "unlearned Home input" || name === "a note behind the Home")
          yield* input("ask", gold);
        if (name === "a note behind the Home") yield* maintenance.runNow(scope);
        const lateInput: typeof turns.dispatch = (command) =>
          Ref.update(homeSequence, (sequence) => sequence + 1).pipe(
            Effect.andThen(turns.dispatch(command)),
          );
        yield* Ref.set(
          homeTurns,
          name === "Home input after the captured sequence" ? lateInput : turns.dispatch,
        );
        const result = yield* maintenance.compactHome(scope);
        assert.deepEqual(result.status === "deferred" && result.reason, reason);
        assert.deepEqual(
          (yield* compactOutcomes).map((row) => [row.status, row.outcome]),
          [["deferred", { compact: "deferred", reason }]],
        );
        const main = yield* SqlClient.SqlClient;
        assert.deepEqual(
          yield* main`SELECT run_id FROM orchestration_v2_projection_runs WHERE run_id LIKE 'scoped-%'`,
          [],
        );
        assert.lengthOf(
          yield* Ref.get(turns.commands),
          name === "Home input after the captured sequence" ? 1 : 0,
        );
      }),
    );
  }).pipe(Effect.provide(storeOnly)),
);

it.effect("retries a failed compaction under a new identity, at most twice in a row", () =>
  Effect.gen(function* () {
    yield* compactableHome(large);
    const { generate } = yield* recordingGenerator(() => Effect.succeed({ operations: [] }));
    yield* withEngine(generate, ({ maintenance, homeSequence, homeTurns, homeEvents }) =>
      Effect.gen(function* () {
        yield* enable(maintenance);
        const turns = yield* scopedTurns(homeSequence);
        yield* Ref.set(homeTurns, turns.dispatch);
        const failedAttempt = Effect.gen(function* () {
          // Learning sets the previous attempt's `/compact` aside as not the user's.
          yield* maintenance.runNow(scope);
          const attempt = yield* maintenance
            .compactHome(scope)
            .pipe(Effect.forkChild({ startImmediately: true }));
          const runId = yield* Queue.take(turns.started);
          yield* endScopedRun(runId, "failed", homeSequence, homeEvents);
          const result = yield* Fiber.join(attempt);
          assert.deepEqual(result.status === "failed" && result.reason, "run_failed");
          return runId;
        });
        const first = yield* failedAttempt;
        const second = yield* failedAttempt;
        assert.notEqual(first, second);
        assert.deepEqual(
          new Set((yield* Ref.get(turns.commands)).map((command) => command.commandId)).size,
          2,
        );

        yield* maintenance.runNow(scope);
        const exhausted = yield* maintenance.compactHome(scope);
        assert.deepEqual(exhausted.status === "deferred" && exhausted.reason, "retry_exhausted");
        assert.lengthOf(yield* Ref.get(turns.commands), 2);
        assert.deepEqual(
          (yield* compactOutcomes).map((row) => [row.status, row.outcome]),
          [
            ["failed", { compact: "failed", reason: "run_failed", homeRunId: first }],
            ["failed", { compact: "failed", reason: "run_failed", homeRunId: second }],
            ["deferred", { compact: "deferred", reason: "retry_exhausted" }],
          ],
        );
        // The failed attempts leave the Home's history and saved note as they were.
        const notes = yield* BotContinuation.BotContinuation;
        assert.deepEqual(yield* notes.coverage(scope), { _tag: "current" });
        const main = yield* SqlClient.SqlClient;
        assert.lengthOf(
          yield* main`SELECT message_id FROM orchestration_v2_projection_messages WHERE thread_id = ${home}`,
          2,
        );
      }),
    );
  }).pipe(Effect.provide(storeOnly)),
);

it.effect(
  "the nightly pass compacts after the refresh turn's checkpoint settles and its prompt is set aside",
  () =>
    Effect.gen(function* () {
      yield* compactableHome(large);
      const { generate } = yield* recordingGenerator(() => Effect.succeed({ operations: [] }));
      yield* withEngine(
        generate,
        ({ maintenance, homeSequence, homeTurns, homeEvents, runScheduled, settling }) =>
          Effect.gen(function* () {
            yield* at("2026-11-09T14:00:00.000Z");
            yield* enable(maintenance);
            const turns = yield* scopedTurns(homeSequence);
            yield* Ref.set(homeTurns, turns.dispatch);
            yield* input("ask", gold);
            yield* at("2026-11-10T03:00:00.000Z");
            yield* runScheduled;
            const refreshRun = yield* Queue.take(turns.started);
            assert.equal((yield* saveNoteAsBot("nightly"))._tag, "saved");
            yield* endScopedRun(refreshRun, "completed", homeSequence, homeEvents);
            assert.equal(yield* Queue.take(settling), `effect:checkpoint.capture:${refreshRun}`);
            yield* Queue.take(turns.started);
            assert.deepEqual(
              (yield* Ref.get(turns.commands)).map((command) =>
                command.type === "message.dispatch" ? command.text : command.type,
              ),
              ["restricted_run.start", "/compact"],
            );
          }),
      );
    }).pipe(Effect.provide(storeOnly), Effect.provideService(HostProcess.Platform, "darwin")),
);
