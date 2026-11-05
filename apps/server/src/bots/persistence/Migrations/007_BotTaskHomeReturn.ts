import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN return_home_run_id TEXT`;
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN return_home_message_id TEXT`;
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN return_finished_at TEXT`;
  yield* sql`CREATE INDEX idx_bot_tasks_home_return ON bot_tasks(task_id)
    WHERE return_home_run_id IS NOT NULL AND return_finished_at IS NULL`;
  yield* sql`CREATE UNIQUE INDEX idx_bot_tasks_pending_home_return ON bot_tasks(home_thread_id, return_home_run_id)
    WHERE return_home_run_id IS NOT NULL AND return_finished_at IS NULL`;
});
