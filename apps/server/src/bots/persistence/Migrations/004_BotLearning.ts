import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per revision; an entry's kind and scope repeat on each and never change.
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_learning_revisions (
      entry_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bots(bot_id),
      project_id TEXT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      rationale TEXT NOT NULL,
      evidence TEXT NOT NULL,
      origin TEXT NOT NULL,
      source_json TEXT NOT NULL,
      learned_in_project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      base_revision INTEGER,
      conflicts_with_instruction INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      PRIMARY KEY (entry_id, revision)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_learning_revisions_bot
    ON bot_learning_revisions(bot_id, status)
  `;
});
