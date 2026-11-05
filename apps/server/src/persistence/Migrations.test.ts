import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect.each(["fresh", 78] as const)(
    "adds delegated recovery indexes from %s without changing projection data",
    (previousMigrationId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({
          toMigrationInclusive: previousMigrationId === "fresh" ? undefined : previousMigrationId,
        });
        const beforeHistory = yield* sql`
        SELECT * FROM effect_sql_migrations WHERE migration_id <= 78 ORDER BY migration_id
      `;
        const payloads = [
          "invalid JSON",
          "{}",
          JSON.stringify({
            lineage: { relationshipToParent: "subagent", parentThreadId: "parent" },
            forkedFrom: { type: "node" },
            delegatedCompletion: { delivery: {} },
          }),
          JSON.stringify({
            lineage: { relationshipToParent: "fork", parentThreadId: "parent" },
            forkedFrom: { type: "node" },
            delegatedCompletion: { delivery: "pending" },
          }),
          JSON.stringify({
            lineage: { relationshipToParent: "subagent" },
            forkedFrom: { type: "node" },
            delegatedCompletion: { delivery: null },
          }),
          JSON.stringify({
            lineage: { relationshipToParent: "subagent", parentThreadId: "parent" },
            forkedFrom: { type: "thread" },
          }),
        ];
        for (const [id, payload] of payloads.entries()) {
          yield* sql`
          INSERT INTO orchestration_v2_projection_threads
            (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
             created_at, updated_at, payload_json)
          VALUES (${`thread-${id}`}, 'project', 'title', 'codex', 'full-access', 'default',
                  '2026-11-05', '2026-11-05', ${payload})
        `;
          yield* sql`
          INSERT INTO orchestration_v2_projection_runs
            (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${`run-${id}`}, ${`thread-${id}`}, 1, 'codex', 'completed', '2026-11-05', ${payload})
        `;
        }
        const threads =
          yield* sql`SELECT * FROM orchestration_v2_projection_threads ORDER BY thread_id`;
        const runs = yield* sql`SELECT * FROM orchestration_v2_projection_runs ORDER BY run_id`;

        yield* runMigrations();
        assert.deepStrictEqual(
          yield* sql`
          SELECT thread_id, json_extract(payload_json, '$.lineage.parentThreadId') AS parent_id
          FROM orchestration_v2_projection_threads
          INDEXED BY orchestration_v2_projection_threads_subagent_result_idx
          WHERE CASE WHEN json_valid(payload_json) THEN
            json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
            AND json_extract(payload_json, '$.lineage.parentThreadId') IS NOT NULL
            AND json_extract(payload_json, '$.forkedFrom.type') = 'node'
            ELSE 0 END
        `,
          [{ thread_id: "thread-2", parent_id: "parent" }],
        );
        assert.deepStrictEqual(
          yield* sql`
          SELECT thread_id FROM orchestration_v2_projection_runs
          INDEXED BY orchestration_v2_projection_runs_delegated_delivery_idx
          WHERE CASE WHEN json_valid(payload_json)
            THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'
            ELSE 0 END
        `,
          [{ thread_id: "thread-2" }],
        );
        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 78 ORDER BY migration_id`,
          beforeHistory,
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM orchestration_v2_projection_threads ORDER BY thread_id`,
          threads,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM orchestration_v2_projection_runs ORDER BY run_id`,
          runs,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps the real upstream migration at 78 and Bot schema out of T3", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        migrationManifest.find(([id]) => id === 78),
        [78, "DropOrchestrationEventCorrelationIndex"],
      );
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'bot%'`, []);
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
      for (const name of ["bot_id", "bot_session_at", "schedule_revision", "bot_allow_changes"]) {
        assert.notInclude(
          columns.map((column) => column.name),
          name,
        );
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect.each([55, 79])("refuses to start when another migration took V2 id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: id - 1 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: id - 1 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      const name = migrationManifest.find(([migrationId]) => migrationId === id)?.[1];
      assert.include(String(exit), `${id}_${name} (recorded: FutureMainMigration)`);
      assert.deepStrictEqual(yield* history, before);
      if (id === 55) assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([54, 77])(
    "drops the unused correlation index from migration %s and keeps correlation values",
    (previousMigrationId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: previousMigrationId });
        const previousHistory = yield* history;
        yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-01-01T00:00:00.000Z',
          'command-1', NULL, 'correlation-1', 'client', '{}', '{}'
        )
      `;

        assert.deepStrictEqual(
          yield* runMigrations(),
          migrationManifest.filter(([id]) => id > previousMigrationId),
        );
        assert.deepStrictEqual((yield* history).slice(0, previousHistory.length), previousHistory);
        assert.deepStrictEqual(yield* runMigrations(), []);

        const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events' AND sql IS NOT NULL
      `;
        const indexNames = indexes.map((row) => row.name);
        assert.notInclude(indexNames, "idx_orch_events_correlation_id");
        for (const kept of [
          "idx_orch_events_stream_version",
          "idx_orch_events_stream_sequence",
          "idx_orch_events_command_id",
          "idx_orchestration_events_agent_stream_sequence",
        ]) {
          assert.include(indexNames, kept);
        }
        const events = yield* sql<{ readonly correlation_id: string | null }>`
        SELECT correlation_id FROM orchestration_events WHERE event_id = 'event-1'
      `;
        assert.deepStrictEqual(events, [{ correlation_id: "correlation-1" }]);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// The npm launcher reads the highest migration id from these file names.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      migrationManifest,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
