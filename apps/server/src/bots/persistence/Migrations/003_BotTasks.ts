import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_tasks (
      task_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(bot_id),
      project_id TEXT NOT NULL,
      home_thread_id TEXT NOT NULL,
      work_thread_id TEXT UNIQUE,
      origin TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      scheduled_task_id TEXT,
      occurrence_key TEXT UNIQUE,
      occurrence_due_at TEXT,
      session_at TEXT,
      runtime_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      dispatched_at TEXT,
      cancel_requested_at TEXT,
      result_run_id TEXT,
      completed_at TEXT,
      notified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_tasks_context
    ON bot_tasks(bot_id, project_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_tasks_open
    ON bot_tasks(task_id)
    WHERE completed_at IS NULL OR notified_at IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_tasks_routine
    ON bot_tasks(scheduled_task_id)
    WHERE scheduled_task_id IS NOT NULL
  `;
});
