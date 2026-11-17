import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // decided_at moves with every later status change, so neither fact is recoverable from it.
  yield* sql`ALTER TABLE bot_learning_revisions ADD COLUMN activated_at TEXT`;
  yield* sql`ALTER TABLE bot_learning_revisions ADD COLUMN restored_from INTEGER`;
  // Only a revision still active kept the time it was activated; earlier ones stay unknown.
  yield* sql`
    UPDATE bot_learning_revisions SET activated_at = decided_at WHERE status = 'active'
  `;
});
