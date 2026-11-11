import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Discovery and processed progress stay separate; neither is learning or note coverage.
  yield* sql`CREATE TABLE bot_maintenance (
    home_thread_id TEXT PRIMARY KEY REFERENCES bot_project_contexts(home_thread_id) ON DELETE CASCADE,
    settings_revision INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    scan_through_sequence INTEGER,
    processed_through_sequence INTEGER,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE bot_maintenance_runs (
    run_id TEXT PRIMARY KEY,
    home_thread_id TEXT NOT NULL REFERENCES bot_maintenance(home_thread_id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT
  )`;
  yield* sql`CREATE UNIQUE INDEX idx_bot_maintenance_runs_active ON bot_maintenance_runs(home_thread_id)
    WHERE status = 'running'`;
  // One receipt per source identity, so an edited, promoted or retried source never reads as new.
  yield* sql`CREATE TABLE bot_maintenance_sources (
    home_thread_id TEXT NOT NULL REFERENCES bot_maintenance(home_thread_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    state TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (home_thread_id, kind, source_id)
  )`;
});
