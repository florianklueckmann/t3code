import * as BotMigrations from "../bots/persistence/Migrations.ts";
import * as ScheduledTaskProvenance from "../bots/persistence/transferScheduledTaskProvenance.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeWorkerThreads from "node:worker_threads";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as BotDatabase from "../bots/persistence/BotDatabase.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const workerData = vi.hoisted((): Array<unknown> => []);

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      workerData.push(args[1]?.workerData);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

it.effect.each(
  [0, 78, 79, 80, 81].flatMap((previousMigrationId) =>
    (previousMigrationId === 81 ? [false, true] : [false]).map((interrupted) => ({
      previousMigrationId,
      interrupted,
    })),
  ),
)(
  "starts persistence from migration $previousMigrationId (interrupted transfer: $interrupted)",
  ({ previousMigrationId, interrupted }) => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-81-"));
    const dbPath = NodePath.join(tempDir, "statev2.sqlite");
    const persistence = () =>
      SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
    const snapshot = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        history: yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        indexes: yield* sql`
          SELECT name, sql, rootpage FROM sqlite_schema
          WHERE name IN ('orchestration_v2_projection_threads_subagent_result_idx',
                         'orchestration_v2_projection_runs_delegated_delivery_idx')
          ORDER BY name
        `,
        data: yield* sql`SELECT * FROM migration_probe`,
        schedules: yield* sql`SELECT * FROM scheduled_tasks ORDER BY task_id`,
      };
    });
    const seed = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE migration_probe(id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
      yield* sql`INSERT INTO migration_probe VALUES ('preserved', 'invalid JSON')`;
      for (const threadId of [null, "bound"]) {
        yield* sql`INSERT INTO scheduled_tasks (
          task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
          workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
          created_by, creation_source, created_at, updated_at, last_run_status, run_count
        ) VALUES (${threadId ?? "unbound"}, 'Schedule', 'brief', 0, '{}', 'project', ${threadId},
          '{}', '{}', 'full-access', 'default', 'user', 'mcp', 'created', 'updated', 'never', 0)`;
      }
      if (previousMigrationId === 0 || previousMigrationId >= 80) {
        yield* sql`UPDATE scheduled_tasks SET thread_mode = 'fresh_session' WHERE task_id = 'bound'`;
      }
      if (previousMigrationId === 81) {
        yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN created_by_thread_id TEXT`;
        yield* sql`UPDATE scheduled_tasks SET created_by_thread_id = 'creator' WHERE task_id = 'unbound'`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (81, 'ScheduledTaskCreationProvenance')`;
      }
    });

    return Effect.gen(function* () {
      const before =
        previousMigrationId === 0
          ? undefined
          : yield* Effect.gen(function* () {
              yield* runMigrations({ toMigrationInclusive: Math.min(previousMigrationId, 80) });
              yield* seed;
              return yield* snapshot;
            }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

      if (previousMigrationId === 81) {
        const bots = Layer.effect(
          BotDatabase.BotDatabase,
          Effect.gen(function* () {
            yield* BotMigrations.runMigrations();
            return yield* SqlClient.SqlClient;
          }),
        ).pipe(
          Layer.provide(
            NodeSqliteClient.layer({ filename: NodePath.join(tempDir, "bots.sqlite") }),
          ),
        );
        yield* Effect.gen(function* () {
          const database = yield* BotDatabase.BotDatabase;
          yield* database`INSERT INTO bot_routine_intent (
            singleton, task_id, query, parameters_json, bot_id, bot_session_at, schedule_revision, removing, bot_allow_changes
          ) VALUES (1, 'unbound', 'UPDATE scheduled_tasks SET created_by_thread_id = ? WHERE task_id = ? RETURNING task_id', '["replayed-creator","unbound"]', NULL, NULL, 0, 0, 0)`;
          if (interrupted) yield* ScheduledTaskProvenance.prepareTransfer();
        }).pipe(Effect.provide(Layer.merge(NodeSqliteClient.layer({ filename: dbPath }), bots)));
      }
      const first = yield* Effect.gen(function* () {
        if (previousMigrationId === 0) yield* seed;
        const current = yield* snapshot;
        assert.deepStrictEqual(
          current.history.map(({ migration_id, name }) => [migration_id, name]),
          migrationManifest.map(([id, name]) => [id, name]),
        );
        assert.deepStrictEqual(
          current.schedules.map(({ task_id, thread_id, thread_mode }) => ({
            task_id,
            thread_id,
            thread_mode,
          })),
          [
            {
              task_id: "bound",
              thread_id: "bound",
              thread_mode:
                previousMigrationId === 0 || previousMigrationId >= 80
                  ? "fresh_session"
                  : "continue",
            },
            {
              task_id: "unbound",
              thread_id: null,
              thread_mode: "new_thread",
            },
          ],
        );
        assert.lengthOf(current.indexes, 2);
        assert.deepStrictEqual(current.data, [{ id: "preserved", payload: "invalid JSON" }]);
        if (previousMigrationId >= 80)
          assert.deepStrictEqual(current.history.slice(0, 80), before?.history.slice(0, 80));
        if (before)
          assert.deepStrictEqual(
            current.schedules.map(
              ({ thread_mode: _mode, created_by_thread_id: _creator, ...row }) => row,
            ),
            before.schedules.map(
              ({ thread_mode: _mode, created_by_thread_id: _creator, ...row }) => row,
            ),
          );
        if (before)
          assert.deepStrictEqual(
            current.history.slice(0, Math.min(before.history.length, 80)),
            before.history.slice(0, 80),
          );
        const bots = yield* BotDatabase.BotDatabase;
        const provenance = yield* bots`SELECT task_id, created_by_thread_id FROM bot_routines`;
        assert.deepStrictEqual(
          provenance,
          previousMigrationId === 81
            ? [{ task_id: "unbound", created_by_thread_id: "replayed-creator" }]
            : [],
        );
        const columns = yield* (yield* SqlClient.SqlClient)<{
          readonly name: string;
        }>`PRAGMA table_info(scheduled_tasks)`;
        assert.isFalse(columns.some(({ name }) => name === "created_by_thread_id"));
        const botHistory = yield* bots`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          botHistory.map(({ migration_id, name }) => [migration_id, name]),
          [
            [1, "Bots"],
            [2, "BotAppearance"],
            [3, "BotTasks"],
            [4, "BotLearning"],
            [5, "BotRoutines"],
            [6, "BotRoutineChanges"],
            [7, "BotTaskHomeReturn"],
            [8, "BotTaskHomeInput"],
            [9, "BotContinuation"],
            [10, "BotTaskModelSelection"],
            [11, "BotMaintenance"],
            [12, "BotMaintenanceReceipts"],
            [13, "BotMaintenanceNightly"],
            [14, "BotHomeCheck"],
            [15, "BotMcpGrants"],
            [16, "BotMcpOwnServers"],
            [17, "ScheduledTaskProvenance"],
            [18, "BotFailureDiagnosis"],
            [19, "BotLearningNotices"],
            [20, "BotHomeCheckEarly"],
            [21, "BotAttention"],
            [22, "BotMcpGrantLevels"],
            [23, "BotCalendarWrites"],
            [24, "BotMcpCalendarChoice"],
            [25, "BotLearningSuggestions"],
            [26, "BotWatch"],
          ],
        );
        return { ...current, botHistory };
      }).pipe(Effect.provide(persistence()));

      for (let reopen = 0; reopen < 2; reopen++) {
        yield* Effect.gen(function* () {
          assert.deepStrictEqual(yield* runMigrations(), []);
          const bots = yield* BotDatabase.BotDatabase;
          assert.deepStrictEqual(
            {
              ...(yield* snapshot),
              botHistory: yield* bots`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
            },
            first,
          );
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
          assert.deepStrictEqual(yield* bots`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
          assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
          assert.deepStrictEqual(yield* bots`PRAGMA foreign_key_check`, []);
        }).pipe(Effect.provide(persistence()));
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);

// Linux names an open, already-deleted file "<path> (deleted)" in /proc/self/fd.
// SQLite names its temp files "etilqs_*" and, without TMPDIR, puts them in
// /var/tmp while os.tmpdir() is /tmp, so match the name, not the directory.
const openDeletedTempFiles = () =>
  NodeFS.readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const target = NodeFS.readlinkSync(`/proc/self/fd/${fd}`);
      return target.includes("/etilqs_") && target.endsWith(" (deleted)") ? [target] : [];
    } catch {
      return [];
    }
  });

it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "keeps a write transaction's statement journal off the temp directory",
  () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-temp-"));
    const persistence = SqlitePersistence.layerFromPath(
      NodePath.join(tempDir, "state.sqlite"),
    ).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE journal_probe(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`;
      for (let id = 0; id < 64; id++) {
        yield* sql`INSERT INTO journal_probe VALUES (${id}, ${"x".repeat(4096)})`;
      }
      const before = new Set(openDeletedTempFiles());
      const opened = yield* sql.withTransaction(
        Effect.gen(function* () {
          // A multi-row update can fail halfway, so SQLite journals every page
          // it changes, here well past the 64 KiB it holds in memory by default.
          yield* sql`UPDATE journal_probe SET payload = payload || 'y'`;
          return openDeletedTempFiles().filter((target) => !before.has(target));
        }),
      );
      assert.deepEqual(opened, []);
    }).pipe(
      Effect.provide(persistence),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);

it.effect("drops planner statistics a database already has", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE walk_probe(node_id TEXT PRIMARY KEY, parent_node_id TEXT)`;
      yield* sql`INSERT INTO walk_probe VALUES ('node-1', NULL), ('node-2', 'node-1')`;
      yield* sql`ANALYZE walk_probe`;
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stats = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_stat1
      `;
      assert.equal(stats[0]?.count, 0);
      // A connection still using the old stats scans the table at each step.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH RECURSIVE retained(node_id) AS (
          SELECT 'node-2'
          UNION
          SELECT parent.parent_node_id FROM walk_probe AS parent
          INNER JOIN retained ON parent.node_id = retained.node_id
        )
        SELECT node_id FROM retained
      `;
      assert.include(
        plan.map((row) => row.detail),
        "SEARCH parent USING INDEX sqlite_autoindex_walk_probe_1 (node_id=?)",
      );
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("upgrades an existing database on a read-write worker connection", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-upgrade-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL;`;
      yield* runMigrations({ toMigrationInclusive: 81 });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
    const startedBefore = workerData.length;

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
    }).pipe(
      Effect.provide(
        SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
    assert.deepInclude(workerData.slice(startedBefore), {
      filename: dbPath,
      readOnly: false,
      requireWal: false,
      allowExtension: false,
      prepareCacheSize: 200,
    });
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("names a database file that is not SQLite", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-notadb-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  NodeFS.writeFileSync(dbPath, "not a db\n");

  return Effect.gen(function* () {
    const opened = yield* Effect.void.pipe(
      Effect.provide(
        SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
      ),
      Effect.result,
    );

    assert.equal(opened._tag, "Failure");
    if (opened._tag === "Failure") {
      assert.isTrue(SqlError.isSqlError(opened.failure));
      assert.include(opened.failure.message, dbPath);
    }
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

const ownT3Home = Effect.fn(function* () {
  const { serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
  // An empty home, so no boot service installed on this machine is read.
  const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
  yield* ServerOwnership.acquireServerOwnership(serverRuntimeStatePath).pipe(
    Effect.provide(ProcessRunner.layer),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, {}),
  );
});

const migrateTo = (toMigrationInclusive?: number) =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* runMigrations({ toMigrationInclusive }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
    );
  });

const latestRecordedMigrationId = Effect.gen(function* () {
  const { dbPath } = yield* ServerConfig.ServerConfig;
  const rows = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly id: number }>`
      SELECT MAX(migration_id) AS id FROM effect_sql_migrations
    `;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
  return rows[0]?.id;
});

const layerT3Home = ServerConfig.layerTest(process.cwd(), { prefix: "t3-sqlite-cli-" });

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("layerCliConfig", (it) => {
  it.effect("does not migrate a T3 home a running server owns", () =>
    Effect.gen(function* () {
      const recorded = Math.max(...migrationManifest.map(([id]) => id)) - 1;
      yield* migrateTo(recorded);
      yield* ownT3Home();

      const opened = yield* Effect.void.pipe(
        Effect.provide(SqlitePersistence.layerCliConfig),
        Effect.result,
      );

      assert.equal(yield* latestRecordedMigrationId, recorded);
      assert.equal(opened._tag, "Failure");
      if (opened._tag === "Failure") {
        assert.instanceOf(opened.failure, SqlitePersistence.ServerOwnsDatabaseError);
      }
    }).pipe(Effect.scoped, Effect.provide(layerT3Home)),
  );

  it.effect("opens a current T3 home while a running server owns it", () =>
    Effect.gen(function* () {
      yield* migrateTo();
      yield* ownT3Home();

      yield* Effect.void.pipe(Effect.provide(SqlitePersistence.layerCliConfig));
    }).pipe(Effect.scoped, Effect.provide(layerT3Home)),
  );
});
