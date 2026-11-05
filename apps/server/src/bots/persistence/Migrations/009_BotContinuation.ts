import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE bot_continuation_revisions (
    home_thread_id TEXT NOT NULL REFERENCES bot_project_contexts(home_thread_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    update_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    revision_json TEXT NOT NULL,
    PRIMARY KEY (home_thread_id, revision),
    UNIQUE (home_thread_id, update_id)
  )`;
  yield* sql`CREATE INDEX idx_bot_tasks_continuation_active ON bot_tasks(home_thread_id, status)
    WHERE cancel_requested_at IS NULL AND status IN ('accepted', 'running', 'waiting')`;
});
