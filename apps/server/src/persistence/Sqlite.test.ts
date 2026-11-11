// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as BotDatabase from "../bots/persistence/BotDatabase.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const workers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      workers.push(this);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

it.effect("keeps writes moving past a 48 MiB WAL while a reader retains its snapshot", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-burst-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = SqlitePersistence.layerFromPath(dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const checkpointWorker = workers.at(-1)!;
    yield* sql`CREATE TABLE burst_probe(id INTEGER PRIMARY KEY, payload BLOB)`;
    yield* sql`INSERT INTO burst_probe VALUES (1, NULL)`;
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    const reader = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath, { readOnly: true })),
      (database) => Effect.sync(() => database.close()),
    );
    reader.exec("BEGIN");
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM burst_probe").get()?.count, 1);

    yield* sql.withTransaction(
      sql`INSERT INTO burst_probe VALUES (2, zeroblob(${48 * 1024 * 1024}))`,
    );
    const state = yield* Effect.callback<{
      readonly log: number;
      readonly checkpointed: number;
      readonly blocked: boolean;
    }>((resume) => {
      const onMessage = (message: {
        readonly type?: string;
        readonly log?: number;
        readonly checkpointed?: number;
        readonly blocked?: boolean;
      }) => {
        if (
          message.type === "checkpoint" &&
          typeof message.log === "number" &&
          message.log > 10_000 &&
          typeof message.checkpointed === "number" &&
          typeof message.blocked === "boolean"
        ) {
          checkpointWorker.off("message", onMessage);
          resume(
            Effect.succeed({
              log: message.log,
              checkpointed: message.checkpointed,
              blocked: message.blocked,
            }),
          );
        }
      };
      checkpointWorker.on("message", onMessage);
      checkpointWorker.ref();
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      checkpointWorker.postMessage("barrier");
      return Effect.sync(() => checkpointWorker.off("message", onMessage));
    });
    assert.isBelow(state.checkpointed, state.log);
    assert.isFalse(state.blocked);

    yield* sql.withTransaction(sql`INSERT INTO burst_probe VALUES (3, NULL)`);
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM burst_probe").get()?.count, 1);
    reader.exec("COMMIT");
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM burst_probe").get()?.count, 3);
  }).pipe(
    Effect.scoped,
    Effect.provide(persistence),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
it.effect.each([0, 78, 79, 80])(
  "starts isolated persistence from migration %s and preserves canonical 80 across reopen",
  (previousMigrationId) => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-80-"));
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
      if (previousMigrationId === 0 || previousMigrationId === 80) {
        yield* sql`UPDATE scheduled_tasks SET thread_mode = 'fresh_session' WHERE task_id = 'bound'`;
      }
    });

    return Effect.gen(function* () {
      const before =
        previousMigrationId === 0
          ? undefined
          : yield* Effect.gen(function* () {
              yield* runMigrations({ toMigrationInclusive: previousMigrationId });
              yield* seed;
              return yield* snapshot;
            }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

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
                previousMigrationId === 0 || previousMigrationId === 80
                  ? "fresh_session"
                  : "continue",
            },
            { task_id: "unbound", thread_id: null, thread_mode: "new_thread" },
          ],
        );
        assert.lengthOf(current.indexes, 2);
        assert.deepStrictEqual(current.data, [{ id: "preserved", payload: "invalid JSON" }]);
        if (previousMigrationId === 80) assert.deepStrictEqual(current, before);
        if (before)
          assert.deepStrictEqual(
            current.schedules.map(({ thread_mode: _mode, ...row }) => row),
            before.schedules.map(({ thread_mode: _mode, ...row }) => row),
          );
        if (before)
          assert.deepStrictEqual(current.history.slice(0, before.history.length), before.history);
        const bots = yield* BotDatabase.BotDatabase;
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
