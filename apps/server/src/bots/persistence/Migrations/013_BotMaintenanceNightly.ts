import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // When the nightly schedule last ran or was turned on; the next pass is the first 03:00 after it.
  yield* sql`ALTER TABLE bot_maintenance ADD COLUMN nightly_at TEXT`;
});
