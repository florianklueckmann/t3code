import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE bot_calendar_writes (
      run_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      result_json TEXT,
      rejected INTEGER NOT NULL DEFAULT 0,
      owned_reference TEXT,
      ownership_marker TEXT,
      PRIMARY KEY (run_id, fingerprint)
    )
  `;
  yield* sql`
    CREATE INDEX bot_calendar_writes_owner
      ON bot_calendar_writes (bot_id, calendar_id, owned_reference)
      WHERE owned_reference IS NOT NULL
  `;
});
