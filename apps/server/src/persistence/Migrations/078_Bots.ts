import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bots (
      bot_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      instructions TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      learning_policy TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_project_contexts (
      home_thread_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(bot_id),
      project_id TEXT NOT NULL,
      guidance TEXT NOT NULL,
      sources_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      thread_sync TEXT,
      attached_at TEXT NOT NULL,
      detached_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (bot_id, project_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_project_contexts_project
    ON bot_project_contexts(project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_project_contexts_thread_sync
    ON bot_project_contexts(home_thread_id)
    WHERE thread_sync IS NOT NULL
  `;
});
