import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX idx_bot_tasks_pending_home_return`;
  yield* sql`CREATE UNIQUE INDEX idx_bot_tasks_pending_home_return ON bot_tasks(home_thread_id, return_home_message_id)
    WHERE return_home_run_id IS NOT NULL AND return_finished_at IS NULL`;
});
