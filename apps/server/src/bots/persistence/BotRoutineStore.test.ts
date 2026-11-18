import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as BotDatabase from "./BotDatabase.ts";
import * as BotRoutineStore from "./BotRoutineStore.ts";
import * as BotMigrations from "./Migrations.ts";

const restart = <A, E, R>(effect: Effect.Effect<A, E, R | BotRoutineStore.BotRoutineStore>) =>
  effect.pipe(Effect.provide(Layer.fresh(BotRoutineStore.layer)));

const upsert = (main: SqlClient.SqlClient, title: string, enabled: number) =>
  main<{ readonly task_id: string }>`INSERT INTO scheduled_tasks (
      task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
      workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
      created_by, creation_source, created_at, updated_at, last_run_status, run_count
    ) VALUES ('routine', ${title}, 'brief', ${enabled}, '{}', 'project', NULL,
      '{}', '{}', 'full-access', 'default', 'user', 'mcp', 'created', 'updated', 'never', 0)
    ON CONFLICT(task_id) DO UPDATE SET title = excluded.title, enabled = excluded.enabled
    RETURNING task_id`;

const target = { botId: "bot", sessionAt: "session", allowChanges: true };
const operations = {
  create: {
    seeded: null,
    change: (main: SqlClient.SqlClient) => upsert(main, "Created", 1),
    input: { target, bump: true, createdByThreadId: "creator" },
    applied: { task: { title: "Created", enabled: 1 }, revision: 0 },
  },
  update: {
    seeded: 1,
    change: (main: SqlClient.SqlClient) => upsert(main, "Updated", 1),
    input: { target, bump: true },
    applied: { task: { title: "Updated", enabled: 1 }, revision: 4 },
  },
  pause: {
    seeded: 1,
    change: (main: SqlClient.SqlClient) =>
      main`UPDATE scheduled_tasks SET enabled = 0 WHERE task_id = 'routine' RETURNING task_id`,
    input: { target, bump: true },
    applied: { task: { title: "Seeded", enabled: 0 }, revision: 4 },
  },
  resume: {
    seeded: 0,
    change: (main: SqlClient.SqlClient) =>
      main`UPDATE scheduled_tasks SET enabled = 1 WHERE task_id = 'routine' RETURNING task_id`,
    input: { target, bump: true },
    applied: { task: { title: "Seeded", enabled: 1 }, revision: 4 },
  },
  delete: {
    seeded: 1,
    change: (main: SqlClient.SqlClient) =>
      main`DELETE FROM scheduled_tasks WHERE task_id = 'routine' RETURNING task_id`,
    input: { bump: false, removing: true },
    applied: null,
  },
} as const;

it.effect.each(
  (["main-fails", "stops-before-main", "stops-between-writes"] as const).flatMap((stage) =>
    (Object.keys(operations) as ReadonlyArray<keyof typeof operations>).map(
      (operation) => [stage, operation] as const,
    ),
  ),
)("%s during a Bot routine %s ends fully applied or not at all", ([stage, name]) =>
  Effect.gen(function* () {
    const main = yield* SqlClient.SqlClient;
    const bots = yield* BotDatabase.BotDatabase;
    const store = yield* BotRoutineStore.BotRoutineStore;
    const operation = operations[name];
    if (operation.seeded !== null) {
      yield* upsert(main, "Seeded", operation.seeded);
      yield* bots`INSERT INTO bot_routines (task_id, bot_id, bot_session_at, schedule_revision, bot_allow_changes)
        VALUES ('routine', 'bot', 'session', 3, 1)`;
    }
    const state = Effect.gen(function* () {
      const [task] = yield* main<{
        readonly title: string;
        readonly enabled: number;
      }>`SELECT title, enabled FROM scheduled_tasks WHERE task_id = 'routine'`;
      const [routine] = yield* bots<{
        readonly bot_id: string | null;
        readonly schedule_revision: number;
      }>`SELECT bot_id, schedule_revision FROM bot_routines WHERE task_id = 'routine'`;
      const pending = yield* bots`SELECT task_id FROM bot_routine_intent`;
      return {
        task: task === undefined ? null : { title: task.title, enabled: task.enabled },
        revision: routine?.schedule_revision ?? null,
        pending: pending.length,
      };
    });
    const before = yield* state;
    const applied = {
      task: operation.applied?.task ?? null,
      revision: operation.applied?.revision ?? null,
      pending: 0,
    };

    const faults = {
      main: ["INSERT", "UPDATE", "DELETE"].map(
        (event) =>
          `CREATE TRIGGER fail_main_${event} BEFORE ${event} ON scheduled_tasks BEGIN SELECT RAISE(ABORT, 'injected'); END`,
      ),
      // Clearing the marker is the last write of a change, so failing it stands in for a stop.
      stop: [
        `CREATE TRIGGER stop_bots BEFORE DELETE ON bot_routine_intent BEGIN SELECT RAISE(ABORT, 'injected'); END`,
      ],
    };
    const inject =
      stage === "main-fails"
        ? { main: faults.main, bots: [] }
        : stage === "stops-before-main"
          ? { main: faults.main, bots: faults.stop }
          : { main: [], bots: faults.stop };
    for (const trigger of inject.main) yield* main.unsafe(trigger);
    for (const trigger of inject.bots) yield* bots.unsafe(trigger);
    const clear = Effect.gen(function* () {
      for (const event of ["INSERT", "UPDATE", "DELETE"])
        yield* main.unsafe(`DROP TRIGGER IF EXISTS fail_main_${event}`);
      yield* bots`DROP TRIGGER IF EXISTS stop_bots`;
    });

    const failed = yield* store
      .mutate(operation.change(main), { taskId: "routine", ...operation.input })
      .pipe(Effect.result);
    assert.equal(failed._tag, "Failure");

    if (stage === "main-fails") {
      // The caller saw the failure, so nothing of the change may surface later.
      assert.deepStrictEqual(yield* state, before);
      assert.equal((yield* store.get("routine"))?.schedule_revision, before.revision ?? undefined);
      yield* clear;
      yield* restart(Effect.void);
      assert.deepStrictEqual(yield* state, before);
      return;
    }

    assert.equal((yield* state).pending, 1);
    if (stage === "stops-before-main") {
      assert.deepStrictEqual(yield* state, { ...before, pending: 1 });
      yield* clear;
      // The next routine operation finishes the change without a restart.
      assert.equal((yield* store.get("routine"))?.schedule_revision, applied.revision ?? undefined);
      assert.deepStrictEqual(yield* state, applied);
    } else {
      assert.deepStrictEqual(yield* state, { ...applied, revision: before.revision, pending: 1 });
      // Recovery itself is stopped at the next start; the server still starts.
      yield* restart(
        Effect.gen(function* () {
          const recovering = yield* BotRoutineStore.BotRoutineStore;
          assert.isUndefined(yield* recovering.get("unrelated"));
          assert.equal((yield* recovering.get("routine").pipe(Effect.result))._tag, "Failure");
        }),
      );
      assert.equal((yield* state).pending, 1);
      yield* clear;
    }
    for (let start = 0; start < 2; start++) {
      yield* restart(
        Effect.gen(function* () {
          const recovered = yield* BotRoutineStore.BotRoutineStore;
          assert.deepStrictEqual(yield* state, applied);
          assert.equal(
            (yield* recovered.get("routine"))?.bot_allow_changes,
            operation.applied === null ? undefined : 1,
          );
        }),
      );
    }
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["bot", "generic", "fresh_session"] as const)(
  "recovers a pre-Main80 %s routine insert",
  (target) =>
    Effect.gen(function* () {
      const main = yield* SqlClient.SqlClient;
      const bots = yield* BotDatabase.BotDatabase;
      const store = yield* BotRoutineStore.BotRoutineStore;
      const legacy = main`INSERT INTO scheduled_tasks (
        task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
        workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
        created_by, creation_source, created_at, updated_at, last_run_status, run_count
      ) VALUES ('legacy', 'Legacy', 'brief', 0, '{}', 'project', 'bound',
        '{}', '{}', 'full-access', 'default', 'user', 'mcp', 'created', 'updated', 'never', 0)
      ON CONFLICT(task_id) DO UPDATE SET title = excluded.title RETURNING task_id`;
      const [query, params] = legacy.compile();
      if (target === "fresh_session") {
        yield* legacy;
        yield* main`UPDATE scheduled_tasks SET thread_mode = 'fresh_session' WHERE task_id = 'legacy'`;
      }
      yield* bots`INSERT INTO bot_routine_intent
        (singleton, task_id, query, parameters_json, bot_id, bot_session_at,
         bot_allow_changes, schedule_revision, removing)
        VALUES (1, 'legacy', ${query}, ${JSON.stringify(params)},
                ${target === "bot" ? "bot" : null}, NULL, 1, 7, 0)`;
      for (let start = 0; start < 2; start++) {
        yield* restart(
          Effect.gen(function* () {
            const recovered = yield* BotRoutineStore.BotRoutineStore;
            assert.equal((yield* recovered.get("legacy"))?.schedule_revision, 7);
            assert.deepStrictEqual(
              yield* main`SELECT thread_id, thread_mode FROM scheduled_tasks WHERE task_id = 'legacy'`,
              [
                {
                  thread_id: target === "bot" ? null : "bound",
                  thread_mode:
                    target === "bot"
                      ? "new_thread"
                      : target === "generic"
                        ? "continue"
                        : "fresh_session",
                },
              ],
            );
            assert.lengthOf(yield* bots`SELECT * FROM bot_routine_intent`, 0);
          }),
        );
      }
      yield* store.mutate(
        main`UPDATE scheduled_tasks SET enabled = 1 WHERE task_id = 'legacy' RETURNING task_id`,
        { taskId: "legacy", bump: true },
      );
      assert.equal((yield* store.get("legacy"))?.bot_id, null);
      assert.equal((yield* store.get("legacy"))?.bot_allow_changes, 0);
      assert.equal((yield* store.get("legacy"))?.schedule_revision, 8);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "a routine change waits out a busy checkpoint while reads of it wait for the change",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bot-routine-" });
      const file = path.join(directory, "state.sqlite");
      const bots = Layer.effect(
        BotDatabase.BotDatabase,
        Effect.gen(function* () {
          yield* BotMigrations.runMigrations();
          return yield* SqlClient.SqlClient;
        }),
      ).pipe(
        Layer.provide(NodeSqliteClient.layer({ filename: path.join(directory, "bots.sqlite") })),
      );
      const databases = Layer.merge(NodeSqliteClient.layer({ filename: file }), bots);
      yield* Effect.gen(function* () {
        const main = yield* SqlClient.SqlClient;
        yield* main`PRAGMA journal_mode = WAL`;
        // A checkpoint that cannot finish reports busy at once instead of after the timeout.
        yield* main`PRAGMA busy_timeout = 0`;
        yield* main`CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY, enabled INTEGER,
          thread_id TEXT, thread_mode TEXT)`;
        yield* main`INSERT INTO scheduled_tasks VALUES ('routine', 1, NULL, 'new_thread')`;
        yield* restart(
          Effect.gen(function* () {
            const store = yield* BotRoutineStore.BotRoutineStore;
            // An open read keeps the WAL pinned, so the change's checkpoint is busy.
            const reader = new NodeSqlite.DatabaseSync(file);
            yield* Effect.addFinalizer(() => Effect.sync(() => reader.close()));
            reader.exec("BEGIN");
            reader.prepare("SELECT * FROM scheduled_tasks").all();
            const change = yield* Effect.forkChild(
              store.mutate(
                main`UPDATE scheduled_tasks SET enabled = 0 WHERE task_id = 'routine' RETURNING task_id`,
                { taskId: "routine", target: { botId: "bot" }, bump: true },
              ),
              { startImmediately: true },
            );
            const read = yield* Effect.forkChild(store.get("routine"), {
              startImmediately: true,
            });
            reader.exec("COMMIT");
            yield* TestClock.adjust("1 second");
            assert.lengthOf(yield* Fiber.join(change), 1);
            assert.equal((yield* Fiber.join(read))?.bot_id, "bot");
          }),
        );
      }).pipe(Effect.provide(databases));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
