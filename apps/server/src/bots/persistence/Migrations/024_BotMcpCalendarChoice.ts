import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A JSON array of calendar ids on the Calendar (this Mac) row; null uses every selected one.
  yield* sql`ALTER TABLE bot_mcp_grants ADD COLUMN calendar_ids TEXT`;
});
