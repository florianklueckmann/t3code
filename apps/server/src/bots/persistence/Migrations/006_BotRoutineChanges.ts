import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN allow_changes INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE bot_routines ADD COLUMN bot_allow_changes INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE bot_routine_intent ADD COLUMN bot_allow_changes INTEGER NOT NULL DEFAULT 0`;
});
