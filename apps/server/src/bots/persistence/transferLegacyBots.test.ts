import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";

import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as BotDatabase from "./BotDatabase.ts";
import * as BotMigrations from "./Migrations.ts";
import { transferLegacyBots } from "./transferLegacyBots.ts";

import { seedLegacy } from "./legacyBotTestFixture.ts";

const tables = ["bots", "bot_project_contexts", "bot_tasks", "bot_learning_revisions"];

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bot-transfer-" });
  const mainPath = path.join(dir, "statev2.sqlite");
  const main = NodeSqliteClient.layer({ filename: mainPath });
  const bots = Layer.effect(
    BotDatabase.BotDatabase,
    Effect.gen(function* () {
      yield* BotMigrations.runMigrations();
      return yield* SqlClient.SqlClient;
    }),
  ).pipe(Layer.provide(NodeSqliteClient.layer({ filename: path.join(dir, "bots.sqlite") })));
  return { mainPath, main, both: Layer.merge(main, bots) };
});

it.effect.each([78, 79, 80, 81, 82, 83])(
  "preserves every legacy row at fork head %s and runs real upstream migrations",
  (head) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const before = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedLegacy(head);
        const snapshot: Record<string, ReadonlyArray<object>> = {};
        for (const table of tables.slice(0, head >= 81 ? 4 : head >= 80 ? 3 : 2))
          snapshot[table] = yield* sql`SELECT * FROM ${sql(table)}`;
        return snapshot;
      }).pipe(Effect.provide(f.main));
      const transferred = yield* Effect.gen(function* () {
        const main = yield* SqlClient.SqlClient;
        const bots = yield* BotDatabase.BotDatabase;
        yield* transferLegacyBots();
        for (const [table, rows] of Object.entries(before)) {
          assert.deepStrictEqual(
            yield* bots`SELECT * FROM ${bots(table)}`,
            rows.map((row) => ({
              ...row,
              ...(table === "bots" && head === 78 ? { appearance_json: null } : {}),
              ...(table === "bots" ? { mcp_grant_revision: 0, mcp_own_codex_servers: 0 } : {}),
              ...(table === "bot_tasks" && head < 83 ? { allow_changes: 0 } : {}),
              ...(table === "bot_tasks"
                ? {
                    return_home_run_id: null,
                    return_home_message_id: null,
                    return_finished_at: null,
                    model_selection_json: null,
                  }
                : {}),
            })),
          );
        }
        if (head >= 80) {
          assert.deepStrictEqual(yield* bots`SELECT * FROM bot_routines ORDER BY task_id`, [
            {
              task_id: "converted",
              bot_id: null,
              bot_session_at: null,
              schedule_revision: 12,
              bot_allow_changes: 0,
            },
            {
              task_id: "routine",
              bot_id: "bot",
              bot_session_at: "session",
              schedule_revision: 9,
              bot_allow_changes: head >= 83 ? 1 : 0,
            },
          ]);
          const [routine] = yield* main`SELECT * FROM scheduled_tasks WHERE task_id = 'routine'`;
          assert.equal(routine?.last_run_status, "running");
          assert.equal(routine?.run_count, 3);
        }
        // Even the merged fork's displaced 082 must not stand in for executing upstream 078.
        yield* main`CREATE INDEX IF NOT EXISTS idx_orch_events_correlation_id ON orchestration_events(correlation_id)`;
        assert.deepStrictEqual(yield* runMigrations(), [
          [78, "DropOrchestrationEventCorrelationIndex"],
          [79, "DelegatedRecoveryIndexes"],
          [80, "ScheduledTaskThreadMode"],
          [81, "ScheduledTaskCreationProvenance"],
        ]);
        assert.deepStrictEqual(
          yield* main`SELECT name FROM sqlite_master WHERE name = 'idx_orch_events_correlation_id'`,
          [],
        );
        // A later upstream migration uses its normal ledger without any Bot reservation.
        const run = Migrator.make({});
        yield* run({
          loader: Migrator.fromRecord({
            "82_TestLaterUpstream": main`CREATE TABLE later_upstream(value TEXT)`,
          }),
        });
        assert.deepStrictEqual(
          yield* main`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 78 ORDER BY migration_id`,
          [
            { migration_id: 78, name: "DropOrchestrationEventCorrelationIndex" },
            { migration_id: 79, name: "DelegatedRecoveryIndexes" },
            { migration_id: 80, name: "ScheduledTaskThreadMode" },
            { migration_id: 81, name: "ScheduledTaskCreationProvenance" },
            { migration_id: 82, name: "TestLaterUpstream" },
          ],
        );
        const copied: Record<string, ReadonlyArray<object>> = {};
        for (const table of [...tables, "bot_routines"])
          copied[table] = yield* bots`SELECT * FROM ${bots(table)}`;
        return { copied, schedules: yield* main`SELECT * FROM scheduled_tasks ORDER BY task_id` };
      }).pipe(Effect.provide(f.both));
      for (let startup = 0; startup < 2; startup++) {
        yield* Effect.gen(function* () {
          const bots = yield* BotDatabase.BotDatabase;
          const main = yield* SqlClient.SqlClient;
          for (const [table, rows] of Object.entries(transferred.copied)) {
            assert.deepStrictEqual(yield* bots`SELECT * FROM ${bots(table)}`, rows);
          }
          assert.deepStrictEqual(
            yield* main`SELECT * FROM scheduled_tasks ORDER BY task_id`,
            transferred.schedules,
          );
          assert.deepStrictEqual(yield* main`SELECT * FROM later_upstream`, []);
          assert.deepStrictEqual(
            yield* main`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
            [
              ...migrationManifest.map(([migration_id, name]) => ({ migration_id, name })),
              { migration_id: 82, name: "TestLaterUpstream" },
            ],
          );
          assert.deepStrictEqual(yield* main`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
          assert.deepStrictEqual(yield* bots`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
          assert.deepStrictEqual(yield* main`PRAGMA foreign_key_check`, []);
          assert.deepStrictEqual(yield* bots`PRAGMA foreign_key_check`, []);
          assert.deepStrictEqual(
            yield* main`SELECT name FROM sqlite_master WHERE name LIKE 'bot%'`,
            [],
          );
        }).pipe(Effect.provide(SqlitePersistence.layerFromPath(f.mainPath)));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("retries a committed copy after source cleanup was interrupted", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const main = yield* SqlClient.SqlClient;
      const bots = yield* BotDatabase.BotDatabase;
      yield* seedLegacy(82);
      yield* main`CREATE TRIGGER stop_cleanup BEFORE DELETE ON effect_sql_migrations BEGIN SELECT RAISE(ABORT, 'injected cleanup interruption'); END`;
      const failed = yield* transferLegacyBots().pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      assert.lengthOf(yield* main`SELECT * FROM bot_tasks`, 4);
      assert.lengthOf(yield* bots`SELECT * FROM bot_tasks`, 4);
      assert.lengthOf(yield* main`SELECT * FROM effect_sql_migrations WHERE migration_id >= 78`, 5);
      yield* main`DROP TRIGGER stop_cleanup`;
    }).pipe(Effect.provide(f.both));
    yield* Effect.gen(function* () {
      const bots = yield* BotDatabase.BotDatabase;
      const main = yield* SqlClient.SqlClient;
      assert.lengthOf(yield* bots`SELECT * FROM bot_learning_revisions`, 5);
      assert.deepStrictEqual(
        yield* main`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
        migrationManifest.map(([migration_id, name]) => ({ migration_id, name })),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerFromPath(f.mainPath)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  "history",
  "schema",
  "target",
  "unknown-suffix",
  "task-mode",
  "routine-mode",
  "routine-schema",
  "task-schema",
  "routine-target",
  "journal",
])("retains both databases when %s is ambiguous", (fault) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const main = yield* SqlClient.SqlClient;
      const bots = yield* BotDatabase.BotDatabase;
      yield* seedLegacy(83);
      if (fault === "history")
        yield* main`UPDATE effect_sql_migrations SET name = 'Unknown' WHERE migration_id = 80`;
      if (fault === "schema") yield* main`ALTER TABLE bot_tasks ADD COLUMN unknown_data TEXT`;
      if (fault === "target")
        yield* bots`INSERT INTO bots SELECT 'bot', 'Conflicting', '', '{}', 'automatic', 'created', 'updated', NULL, NULL, 0, 0`;
      if (fault === "unknown-suffix")
        yield* main`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (84, 'Unknown')`;
      if (fault === "task-mode") yield* main`UPDATE bot_tasks SET allow_changes = 2`;
      if (fault === "routine-mode")
        yield* main`UPDATE scheduled_tasks SET bot_allow_changes = 'true'`;
      if (fault === "routine-schema") {
        yield* main`ALTER TABLE scheduled_tasks DROP COLUMN bot_allow_changes`;
        yield* main`ALTER TABLE scheduled_tasks ADD COLUMN bot_allow_changes TEXT NOT NULL DEFAULT '0'`;
      }
      if (fault === "task-schema") yield* main`ALTER TABLE bot_tasks DROP COLUMN allow_changes`;
      if (fault === "routine-target")
        yield* bots`INSERT INTO bot_routines (task_id, bot_id, bot_session_at, schedule_revision, bot_allow_changes) VALUES ('routine', 'bot', 'session', 9, 0)`;
      if (fault === "journal")
        yield* bots`INSERT INTO bot_routine_intent (singleton, task_id, query, parameters_json, schedule_revision, removing) VALUES (1, 'routine', 'SELECT 1', '[]', 9, 0)`;
      const failed = yield* transferLegacyBots().pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      assert.include(String(failed), "Cannot transfer legacy Bots");
      assert.lengthOf(yield* main`SELECT * FROM bot_learning_revisions`, 5);
      assert.lengthOf(
        yield* main`SELECT * FROM effect_sql_migrations WHERE migration_id >= 78`,
        fault === "unknown-suffix" ? 7 : 6,
      );
    }).pipe(Effect.provide(f.both));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([false, true])(
  "starts fresh or upstream-only databases (upstream-only: %s) repeatedly",
  (upstreamOnly) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      if (upstreamOnly) yield* runMigrations().pipe(Effect.provide(f.main));
      for (let startup = 0; startup < 2; startup++) {
        yield* Effect.gen(function* () {
          const main = yield* SqlClient.SqlClient;
          const bots = yield* BotDatabase.BotDatabase;
          assert.deepStrictEqual(
            yield* main`SELECT name FROM sqlite_master WHERE name LIKE 'bot%'`,
            [],
          );
          assert.deepStrictEqual(yield* bots`SELECT * FROM bots`, []);
          assert.deepStrictEqual(
            yield* main`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
            migrationManifest.map(([migration_id, name]) => ({ migration_id, name })),
          );
        }).pipe(Effect.provide(SqlitePersistence.layerFromPath(f.mainPath)));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
