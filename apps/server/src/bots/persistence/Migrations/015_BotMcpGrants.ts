import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Connection ids live in the settings catalog, which a foreign key cannot reach.
  yield* sql`CREATE TABLE bot_mcp_grants (
    bot_id TEXT NOT NULL REFERENCES bots(bot_id),
    connection_id TEXT NOT NULL,
    PRIMARY KEY (bot_id, connection_id)
  )`;
  yield* sql`ALTER TABLE bots ADD COLUMN mcp_grant_revision INTEGER NOT NULL DEFAULT 0`;
});
