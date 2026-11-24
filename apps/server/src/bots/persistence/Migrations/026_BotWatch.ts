import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bot_routines ADD COLUMN bot_watch INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE bot_routine_intent ADD COLUMN bot_watch INTEGER NOT NULL DEFAULT 0`;
  // Fixed at admission like allow_changes, so editing the routine never changes an admitted run.
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN watch INTEGER NOT NULL DEFAULT 0`;
  // A watch run that ended with nothing new: no card, no unread mark, no alert.
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0`;
  // What each watch run posted, per occasion; a later run on the same occasion is checked against it.
  yield* sql`CREATE TABLE bot_watch_posts (
    task_id TEXT PRIMARY KEY,
    scheduled_task_id TEXT NOT NULL,
    occasion_key TEXT NOT NULL,
    occasion TEXT NOT NULL,
    items_json TEXT NOT NULL,
    posted_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_bot_watch_posts_routine ON bot_watch_posts(scheduled_task_id, posted_at)`;
});
