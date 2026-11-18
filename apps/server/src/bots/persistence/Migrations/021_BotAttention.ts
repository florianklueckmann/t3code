import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A Bot without a row uses the defaults: 3 alerts a day, quiet from 22:00 to 07:00, no remit.
  // Quiet hours are off when both times are null.
  yield* sql`CREATE TABLE bot_attention (
    bot_id TEXT PRIMARY KEY REFERENCES bots(bot_id),
    revision INTEGER NOT NULL,
    daily_limit INTEGER NOT NULL,
    quiet_start TEXT,
    quiet_end TEXT,
    remit TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  // Whether the user started the task: a direct request from their own Home message or client.
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN by_hand INTEGER NOT NULL DEFAULT 0`;
  // One row per proactive alert decision, keyed by task and run so a repeated publish decides
  // once. `day` is the environment-local date the cap counts against.
  yield* sql`CREATE TABLE bot_alerts (
    alert_key TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(bot_id),
    task_id TEXT NOT NULL,
    work_thread_id TEXT NOT NULL,
    home_thread_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    day TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    held INTEGER NOT NULL,
    digest_sent_at TEXT
  )`;
  yield* sql`CREATE INDEX idx_bot_alerts_bot_day ON bot_alerts(bot_id, day)`;
  yield* sql`CREATE INDEX idx_bot_alerts_held ON bot_alerts(bot_id) WHERE held = 1 AND digest_sent_at IS NULL`;
});
