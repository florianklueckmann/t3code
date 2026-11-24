import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per suggested lesson, so a dismissal holds for that lesson whatever it matches later.
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_learning_suggestions (
      entry_id TEXT NOT NULL PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(bot_id),
      entry_revision INTEGER NOT NULL,
      matched_entry_id TEXT NOT NULL,
      matched_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      dismissed_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_learning_suggestions_bot
    ON bot_learning_suggestions(bot_id)
  `;
});
