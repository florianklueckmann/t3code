import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // When early checks were turned on, null while off; work that ended before does not count.
  yield* sql`ALTER TABLE bot_home_checks ADD COLUMN early_since TEXT`;
  // The two latest early checks this Home started; the Bot-wide limit reads them across its Homes.
  yield* sql`ALTER TABLE bot_home_checks ADD COLUMN early_started_at TEXT`;
  yield* sql`ALTER TABLE bot_home_checks ADD COLUMN early_previous_at TEXT`;
  // Finished Bot work no check has reviewed yet. A row is pending while check_message_id is null,
  // claimed by that check otherwise, and deleted once the check reviewed it.
  yield* sql`CREATE TABLE bot_home_check_outcomes (
    task_id TEXT PRIMARY KEY,
    home_thread_id TEXT NOT NULL REFERENCES bot_project_contexts(home_thread_id) ON DELETE CASCADE,
    check_message_id TEXT
  )`;
  yield* sql`CREATE INDEX idx_bot_home_check_outcomes_home ON bot_home_check_outcomes(home_thread_id)`;
});
