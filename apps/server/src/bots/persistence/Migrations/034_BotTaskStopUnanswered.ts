import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The run a cancelled task's stop got no answer from; a repeated cancel force stops it.
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN stop_unanswered_run_id TEXT`;
});
