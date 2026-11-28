import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A worktree row now lives from its creation to its removal. `path` is where it rests while
  // free; `claimed_path` is the work thread's folder while a thread holds it.
  yield* sql`ALTER TABLE bot_worktrees ADD COLUMN claimed_path TEXT`;
  // The worktree's own Git directory, which stays the same when the folder moves. Null until the
  // pool created and marked it at rest; empty for a claim from before, never taken by path.
  yield* sql`ALTER TABLE bot_worktrees ADD COLUMN git_dir TEXT`;
  // Set while the worktree holds work it could not save; it is then neither free nor reused.
  yield* sql`ALTER TABLE bot_worktrees ADD COLUMN kept_reason TEXT`;
  // HEAD when it was parked: a free worktree at another commit was used since.
  yield* sql`ALTER TABLE bot_worktrees ADD COLUMN parked_head TEXT`;
  // A claim's switch is done and its clean-up still owed: the paths, as JSON, to clean.
  yield* sql`ALTER TABLE bot_worktrees ADD COLUMN pending_clean TEXT`;
  // Claimed rows used to record where the worktree went; it rests beside it, in bot-pool-<id>.
  yield* sql`
    UPDATE bot_worktrees
    SET claimed_path = path, git_dir = '',
      path = rtrim(path, replace(replace(path, '/', ''), '\\', '')) || 'bot-pool-' || worktree_id
    WHERE claimed_by IS NOT NULL AND claimed_by <> 'removing'
  `;
  // Free ones carry no mark, so the checkout at their path could be anyone's by now. They leave
  // the pool and stay on disk, where storage cleanup lists them.
  yield* sql`DELETE FROM bot_worktrees WHERE claimed_by IS NULL OR claimed_by = 'removing'`;
});
