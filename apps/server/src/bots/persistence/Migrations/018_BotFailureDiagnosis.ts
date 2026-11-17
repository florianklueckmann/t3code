import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // enabled_at keeps a rule from diagnosing runs that failed before it was turned on.
  yield* sql`CREATE TABLE bot_failure_diagnosis (
    home_thread_id TEXT PRIMARY KEY REFERENCES bot_project_contexts(home_thread_id) ON DELETE CASCADE,
    settings_revision INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    brief TEXT NOT NULL,
    enabled_at TEXT,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN diagnoses_task_id TEXT`;
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN diagnoses_run_id TEXT`;
  // At most one diagnosis per failed task, whatever delivers or retries its failure.
  yield* sql`CREATE UNIQUE INDEX idx_bot_tasks_diagnoses ON bot_tasks(diagnoses_task_id)
    WHERE diagnoses_task_id IS NOT NULL`;
});
