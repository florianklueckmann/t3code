import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bots ADD COLUMN task_limit INTEGER NOT NULL DEFAULT 5`;
  // The server's check of a completed direct task's result, as BotTaskAcceptance JSON.
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN acceptance_json TEXT`;
  // A held alert gathered with others that need the user goes out at this time, not the digest's.
  yield* sql`ALTER TABLE bot_alerts ADD COLUMN release_at TEXT`;
  yield* sql`CREATE INDEX idx_bot_tasks_open_direct ON bot_tasks(bot_id, origin, completed_at)`;
});
