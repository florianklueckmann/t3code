import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN branch TEXT`;
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN base_branch TEXT`;
  // 'root': a writing task in a folder without Git. 'held': the work thread has a pooled
  // worktree. 'released': its worktree went back to the pool; a follow-up takes one again.
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN worktree_state TEXT`;
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN unfinished_work INTEGER NOT NULL DEFAULT 0`;
  // Lockfiles the work thread's worktree was last set up from; it goes with the worktree.
  yield* sql`ALTER TABLE bot_tasks ADD COLUMN setup_signature TEXT`;
  // Free worktrees only; one in use belongs to its task's work thread.
  yield* sql`CREATE TABLE bot_worktrees (
    worktree_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    claimed_by TEXT,
    setup_signature TEXT NOT NULL,
    parked_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_bot_worktrees_project ON bot_worktrees(project_id, parked_at)`;
  yield* sql`CREATE INDEX idx_bot_tasks_worktree ON bot_tasks(project_id, worktree_state)`;
});
