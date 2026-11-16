import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bot_routines ADD COLUMN created_by_thread_id TEXT`;
  yield* sql`ALTER TABLE bot_routine_intent ADD COLUMN created_by_thread_id TEXT`;
  yield* sql`CREATE TABLE bot_provenance_transfer (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))`;
});
