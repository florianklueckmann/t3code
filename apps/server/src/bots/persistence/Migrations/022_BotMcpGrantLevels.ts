import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Null for connections without levels; Calendar (this Mac) rows hold an `McpGrantLevel`.
  yield* sql`ALTER TABLE bot_mcp_grants ADD COLUMN level TEXT`;
});
