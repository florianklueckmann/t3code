import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A check is owed once the first time_of_day after done_through has passed; owed is never stored.
  yield* sql`CREATE TABLE bot_home_checks (
    home_thread_id TEXT PRIMARY KEY REFERENCES bot_project_contexts(home_thread_id) ON DELETE CASCADE,
    settings_revision INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    time_of_day TEXT NOT NULL,
    done_through TEXT NOT NULL,
    check_message_id TEXT,
    last_outcome_json TEXT,
    updated_at TEXT NOT NULL
  )`;
});
