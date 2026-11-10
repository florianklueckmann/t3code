import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { BotId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as BotMigrations from "./persistence/Migrations.ts";
import * as BotMaintenance from "./BotMaintenance.ts";
import * as BotStore from "./BotStore.ts";

const scope = { botId: BotId.make("bot"), projectId: ProjectId.make("project") };
const home = ThreadId.make("bot-home:bot:project");
const now = "2026-11-09T10:00:00.000Z";
const database = Sqlite.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-maintenance-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const storeOnly = BotStore.layer.pipe(Layer.provideMerge(database));
const production = BotMaintenance.layer.pipe(
  Layer.provide(Layer.merge(EventStore.layer, ThreadCommandExecutor.layer)),
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
 * A stand-in for the tool-free generator U2 wires. It proves enablement metadata only, never
 * that production can generate. Snapshots record whether the Home command lock was held.
 */
const withReadyGeneration = Effect.gen(function* () {
  const sequence = yield* Ref.make(0);
  const snapshots = yield* Ref.make<ReadonlyArray<boolean>>([]);
  const executor = yield* KeyedLock.make<ThreadId>();
  const maintenance = yield* BotMaintenance.make({ unavailableReason: null }).pipe(
    Effect.provide(
      Layer.mock(EventStore.EventStoreV2)({
        latestSequence: () =>
          executor.activeKeys.pipe(
            Effect.flatMap((keys) => Ref.update(snapshots, (all) => [...all, keys.includes(home)])),
            Effect.andThen(Ref.get(sequence)),
          ),
      }),
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
      yield* bots`DELETE FROM effect_sql_migrations WHERE migration_id = 11`;
      yield* BotMigrations.runMigrations().pipe(Effect.provideService(SqlClient.SqlClient, bots));
      const history = yield* bots<{
        readonly migration_id: number;
        readonly name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepEqual(history.at(-1), { migration_id: 11, name: "BotMaintenance" });
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
