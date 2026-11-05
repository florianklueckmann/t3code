import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { seedLegacy } from "../src/bots/persistence/legacyBotTestFixture.ts";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import * as BotDatabase from "../src/bots/persistence/BotDatabase.ts";
import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrateDevDb } from "./migrate-dev-db.ts";

const withDatabase = <A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

const createFixtureSource = Effect.fn("createMigrateDevDbFixtureSource")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        ('project-kept', 'Kept', '/tmp/kept', '[]', '2026-08-01', '2026-08-01', NULL),
        ('project-deleted', 'Deleted', '/tmp/deleted', '[]', '2026-08-01', '2026-08-02', '2026-08-02')`;

      const forkPayload =
        '{"lineage":{"parentThreadId":"stopped-thread","relationshipToParent":"fork","rootThreadId":"stopped-thread"}}';
      const subagentPayload =
        '{"lineage":{"parentThreadId":"subagent-parent","relationshipToParent":"subagent","rootThreadId":"subagent-parent"},"forkedFrom":{"type":"node","nodeId":"node-1"}}';
      const threads = [
        ["stopped-thread", "project-kept", "completed", "{}", "2026-08-01"],
        ["fork-thread", "project-kept", "completed", forkPayload, "2026-08-02"],
        ["running-thread", "project-kept", "running", "{}", "2026-08-05"],
        ["settled-thread", "project-kept", "completed", '{"settledAt":"2026-08-01"}', "2026-08-05"],
        [
          "archived-thread",
          "project-kept",
          "completed",
          '{"archivedAt":"2026-08-01"}',
          "2026-08-05",
        ],
        [
          "limit-thread",
          "project-kept",
          "completed",
          '{"limitRecovery":{"autoResume":true}}',
          "2026-08-05",
        ],
        ["subagent-parent", "project-kept", "completed", "{}", "2026-08-05"],
        ["subagent-child", "project-kept", "completed", subagentPayload, "2026-08-05"],
        ["deleted-project-thread", "project-deleted", "completed", "{}", "2026-08-05"],
      ] as const;
      for (const [threadId, projectId, runStatus, payload, updatedAt] of threads) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${threadId}, ${projectId}, ${threadId}, 'codex', 'full-access', 'default', '2026-08-01', ${updatedAt}, ${payload})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', ${runStatus}, '2026-08-01', '{}')`;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES (${`event-${threadId}`}, 'thread', ${threadId}, 0, 'thread.created', '2026-08-01', 'user', '{}', '{}')`;
      }
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
        (provider_session_id, thread_id, provider, status, updated_at, payload_json)
        VALUES ('session-shared', 'running-thread', 'codex', 'stopped', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
        (provider_session_id, thread_id)
        VALUES ('session-shared', 'running-thread'), ('session-shared', 'stopped-thread')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
        (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
        VALUES ('transfer-1', 'archived-thread', 'stopped-thread', 'provider_handoff', 'completed', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO scheduled_tasks
        (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
          model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
          created_at, updated_at, last_run_status, run_count)
        VALUES ('task-1', 'Nightly', 'Run it', 1, '{}', 'project-kept', '{}', '{}',
          'full-access', 'default', 'user', 'user', '2026-08-01', '2026-08-01', 'never', 0)`;
      yield* sql`INSERT INTO scheduled_task_webhook_replay_keys
        (task_id, replay_key, delivery_id, expires_at)
        VALUES ('task-1', 'replay-1', 'delivery-1', 1900000000000)`;
      yield* sql`INSERT INTO scheduled_task_webhook_pending
        (delivery_id, task_id, coalesce_key, due_at, task_json, request_json, delivery_ids_json)
        VALUES ('delivery-1', 'task-1', 'key-1', 1900000000000, '{}', '{}', '[]')`;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
      yield* sql`INSERT INTO peer_environment_links
        (environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
        VALUES ('environment-box', 'peer-link-box', 'Box', '["https://box.example"]', 'auto',
          '2026-08-01', '2027-08-01')`;
    }),
  );
  return databasePath;
});

it.layer(NodeServices.layer)("migrate-dev-db", (it) => {
  it.effect.each(["legacy", "separated"] as const)(
    "refreshes both dev databases from %s data without importing runnable Bot work",
    (sourceKind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-bots-src-" });
        const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-bots-dest-" });
        const source = path.join(sourceDir, "userdata", "statev2.sqlite");
        yield* fs.makeDirectory(path.dirname(source), { recursive: true });
        yield* withDatabase(source, seedLegacy(83));
        // Add ordinary stopped history so the Bot home can survive the normal seed pruning.
        yield* withDatabase(
          source,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES ('project', 'Campaign', '/synthetic/campaign', '[]', '2026-08-01', '2026-08-01')`;
            yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES ('home', 'project', 'Home', 'codex', 'full-access', 'default', '2026-08-01', '2026-08-01', '{}')`;
            yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
          VALUES ('secret-session', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
            yield* sql`INSERT INTO bot_project_contexts
          SELECT 'missing-home', bot_id, 'discarded-project', guidance, sources_json, revision, NULL, attached_at, detached_at, updated_at
          FROM bot_project_contexts WHERE home_thread_id = 'home'`;
            yield* sql`INSERT INTO bot_learning_revisions
          SELECT 'shared-fact', revision, bot_id, NULL, 'fact', text, normalized_text, rationale, evidence,
            origin, source_json, 'discarded-project', status, base_revision, conflicts_with_instruction, created_at, decided_at
          FROM bot_learning_revisions WHERE revision = 1`;
            yield* sql`INSERT INTO bot_learning_revisions
          SELECT 'discarded-fact', revision, bot_id, 'discarded-project', 'fact', text, normalized_text, rationale, evidence,
            origin, source_json, 'discarded-project', status, base_revision, conflicts_with_instruction, created_at, decided_at
          FROM bot_learning_revisions WHERE entry_id = 'lesson' AND revision = 1`;
          }),
        );
        if (sourceKind === "separated") {
          yield* Effect.gen(function* () {
            const bots = yield* BotDatabase.BotDatabase;
            yield* bots`INSERT INTO bot_continuation_revisions (home_thread_id, revision, update_id, request_hash, revision_json) VALUES ('home', 1, 'synthetic-note', 'hash', '{}')`;
            // A source journal must never be replayed into a dev seed.
            yield* bots`INSERT INTO bot_routine_intent
            (singleton, task_id, query, parameters_json, bot_id, bot_session_at, schedule_revision, removing)
            VALUES (1, 'routine', 'DELETE FROM projection_projects', '[]', 'bot', NULL, 10, 0)`;
          }).pipe(Effect.provide(SqlitePersistence.layerFromPath(source)));
        }
        const sourceBytes = yield* fs.readFile(source);
        const sourceBots = path.join(path.dirname(source), "bots.sqlite");
        const botBytes = sourceKind === "separated" ? yield* fs.readFile(sourceBots) : undefined;
        const destination = path.join(destDir, "userdata", "statev2.sqlite");
        // Refresh must replace stale target Bot state as well as the main database.
        yield* Effect.gen(function* () {
          const bots = yield* BotDatabase.BotDatabase;
          yield* bots`INSERT INTO bots (bot_id, name, instructions, model_selection_json, learning_policy, created_at, updated_at)
          VALUES ('stale', 'Stale', '', '{}', 'automatic', 'created', 'updated')`;
        }).pipe(Effect.provide(SqlitePersistence.layerFromPath(destination)));
        for (let refresh = 0; refresh < 2; refresh++) {
          yield* runMigrateDevDb(
            { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
            { sharedHome: sourceDir },
          );
          yield* Effect.gen(function* () {
            const main = yield* SqlClient.SqlClient;
            const bots = yield* BotDatabase.BotDatabase;
            assert.deepStrictEqual(yield* bots`SELECT bot_id FROM bots`, [{ bot_id: "bot" }]);
            assert.lengthOf(yield* bots`SELECT * FROM bot_project_contexts`, 1);
            assert.lengthOf(yield* bots`SELECT * FROM bot_learning_revisions`, 6);
            assert.lengthOf(
              yield* bots`SELECT * FROM bot_learning_revisions WHERE project_id IS NULL`,
              1,
            );
            assert.deepStrictEqual(yield* bots`SELECT thread_sync FROM bot_project_contexts`, [
              { thread_sync: null },
            ]);
            for (const table of [
              "bot_continuation_revisions",
              "bot_tasks",
              "bot_routines",
              "bot_routine_intent",
            ])
              assert.lengthOf(yield* bots`SELECT * FROM ${bots(table)}`, 0);
            assert.lengthOf(yield* main`SELECT * FROM scheduled_tasks`, 0);
            assert.lengthOf(yield* main`SELECT * FROM auth_sessions`, 0);
            assert.lengthOf(yield* main`SELECT * FROM peer_environment_links`, 0);
            assert.deepStrictEqual(
              yield* main`SELECT thread_id FROM orchestration_v2_projection_threads`,
              [{ thread_id: "home" }],
            );
          }).pipe(Effect.provide(SqlitePersistence.layerFromPath(destination)));
        }
        assert.deepStrictEqual(yield* fs.readFile(source), sourceBytes);
        if (botBytes) assert.deepStrictEqual(yield* fs.readFile(sourceBots), botBytes);
      }),
  );

  it.effect("keeps stopped and settled thread families and clears pending work", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-dest-" });
      const source = yield* createFixtureSource(sourceDir);

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );

      assert.equal(result.databasePath, path.join(destDir, "userdata", "statev2.sqlite"));
      const kept = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          const events = yield* sql<{ stream_id: string }>`
            SELECT stream_id FROM orchestration_events ORDER BY stream_id`;
          const sessions = yield* sql<{ provider_session_id: string }>`
            SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions`;
          const [leftovers] = yield* sql<{
            auth: number;
            tasks: number;
            webhooks: number;
            transfers: number;
            links: number;
          }>`
            SELECT
              (SELECT COUNT(*) FROM auth_sessions) AS auth,
              (SELECT COUNT(*) FROM scheduled_tasks) AS tasks,
              (SELECT COUNT(*) FROM scheduled_task_webhook_replay_keys) +
                (SELECT COUNT(*) FROM scheduled_task_webhook_pending) AS webhooks,
              (SELECT COUNT(*) FROM orchestration_v2_projection_context_transfers) AS transfers,
              (SELECT COUNT(*) FROM peer_environment_links) AS links`;
          return { threads, events, sessions, leftovers };
        }),
      );
      assert.deepStrictEqual(
        kept.threads.map((row) => row.thread_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.events.map((row) => row.stream_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.sessions.map((row) => row.provider_session_id),
        ["session-shared"],
      );
      assert.deepStrictEqual(kept.leftovers, {
        auth: 0,
        tasks: 0,
        webhooks: 0,
        transfers: 0,
        links: 0,
      });
    }),
  );

  it.effect("never copies an archived thread, and new events append after the source's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slice-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slice-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const [sourceSequence] = yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ seq: number }>`
            SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 100 },
        { sharedHome: sourceDir },
      );

      const copied = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [archivedRows] = yield* sql<{ count: number }>`
            SELECT
              (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE thread_id = 'archived-thread')
              + (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = 'archived-thread')
              AS count`;
          const [sequence] = yield* sql<{ seq: number }>`
            SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'`;
          return { archivedRows: archivedRows?.count, sequence: sequence?.seq };
        }),
      );
      assert.equal(copied.archivedRows, 0);
      assert.equal(copied.sequence, sourceSequence?.seq);
    }),
  );

  it.effect("skips a thread family larger than the per-project limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-family-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-family-dest-" });
      const source = yield* createFixtureSource(sourceDir);

      // stopped-thread and its fork are 2 threads; settled-thread is 1.
      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 1 },
        { sharedHome: sourceDir },
      );
      const threads = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads`;
        }),
      );
      assert.deepStrictEqual(
        threads.map((row) => row.thread_id),
        ["settled-thread"],
      );
    }),
  );

  it.effect("upgrades a source from before the V2 thread tables", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-v1-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-v1-dest-" });
      const stateDir = path.join(sourceDir, "userdata");
      const source = path.join(stateDir, "statev2.sqlite");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* withDatabase(source, runMigrations({ toMigrationInclusive: 54 }));

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );
      assert.include(result.executedMigrations, "55_OrchestrationV2");
    }),
  );

  it.effect("seeds from a source that recorded another migration below V2", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-local-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-local-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE effect_sql_migrations SET name = 'SiteLocalMigration'
            WHERE migration_id = 51`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );
      const threads = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
        }),
      );
      assert.deepStrictEqual(
        threads.map((row) => row.thread_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
    }),
  );

  it.effect("refuses a source whose V2 migration history clashes with this checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-clash-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-clash-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE effect_sql_migrations SET name = 'OtherBuildMigration'
            WHERE migration_id = 60`;
        }),
      );

      const destination = yield* createFixtureSource(destDir);
      const sourceBefore = yield* fs.readFile(source);
      const destinationBefore = yield* fs.readFile(destination);

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbPhaseError");
      if (error._tag === "MigrateDevDbPhaseError") {
        assert.equal(error.phase, "migrate");
        assert.include(String(error.cause), "60_ThreadSnapshotWindowIndexes");
      }
      assert.deepStrictEqual(yield* fs.readFile(source), sourceBefore);
      assert.deepStrictEqual(yield* fs.readFile(destination), destinationBefore);
    }),
  );

  it.effect("refuses while a dev server holds the destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const stateDir = path.join(destDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        `{"version":1,"pid":${process.pid}}`,
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbServerRunningError");
      if (error._tag === "MigrateDevDbServerRunningError") {
        assert.equal(error.pid, process.pid);
      }
    }),
  );

  it.effect.each(["statev2.sqlite", "bots.sqlite"])(
    "refuses to refresh while target %s is write-locked",
    (name) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourceDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-locked-src-",
        });
        const destDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-locked-dest-",
        });
        const source = yield* createFixtureSource(sourceDir);
        const destination = path.join(destDir, "userdata", "statev2.sqlite");
        yield* Effect.void.pipe(Effect.provide(SqlitePersistence.layerFromPath(destination)));
        yield* withDatabase(
          path.join(path.dirname(destination), name),
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe("BEGIN IMMEDIATE").unprepared;
            try {
              const error = yield* runMigrateDevDb(
                { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
                { sharedHome: sourceDir },
              ).pipe(Effect.flip);
              assert.equal(error._tag, "MigrateDevDbDestinationBusyError");
            } finally {
              yield* sql.unsafe("ROLLBACK").unprepared;
            }
          }),
        );
      }),
  );

  it.effect.each([
    "statev2.sqlite.migrate-dev-db-tmp",
    "bots.sqlite",
    "bots.sqlite.migrate-dev-db-tmp",
  ])("refuses a source that resolves to destination %s", (name) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-dest-" });
      const leftoverSnapshot = path.join(destDir, "userdata", name);
      yield* fs.makeDirectory(path.dirname(leftoverSnapshot), { recursive: true });
      yield* fs.writeFileString(leftoverSnapshot, "not a real db");

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source: leftoverSnapshot, projects: 5, threadsPerProject: 10 },
        { sharedHome: sharedDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSourceIsDestinationError");
      assert.equal(yield* fs.exists(leftoverSnapshot), true);
    }),
  );

  it.effect("refuses to rebuild the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-shared-" });
      const source = yield* createFixtureSource(sourceDir);

      const error = yield* runMigrateDevDb(
        { baseDir: sourceDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSharedHomeError");
    }),
  );
});
