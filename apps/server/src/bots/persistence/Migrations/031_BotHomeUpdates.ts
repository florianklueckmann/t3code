import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Per task of a Bot's own Home: the last status it was told about, so none is told twice.
  yield* sql`CREATE TABLE bot_home_updates (
    task_id TEXT PRIMARY KEY,
    update_key TEXT NOT NULL,
    sent_at TEXT NOT NULL
  )`;
});
