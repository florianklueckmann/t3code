import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Durable state of the repository review controller (`repoReview/`). Job and publication rows
 * double as its outbox: their intent is committed before the thread launch or GitHub write runs.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS repo_review_owners (
      owner_id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      repository_key TEXT NOT NULL,
      github_repository_id TEXT,
      project_id TEXT NOT NULL,
      account TEXT NOT NULL,
      status TEXT NOT NULL,
      status_reason TEXT,
      status_changed_at TEXT NOT NULL,
      pause_requested_at TEXT,
      policy_json TEXT NOT NULL,
      last_poll_at TEXT,
      next_poll_at TEXT,
      last_poll_error TEXT,
      import_source TEXT,
      events_baseline_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // One owner per repository until it is stopped; a paused owner still owns it.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_review_owners_single_owner
    ON repo_review_owners(host, repository_key)
    WHERE status <> 'stopped'
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS repo_review_pull_requests (
      owner_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      draft INTEGER NOT NULL,
      author_login TEXT NOT NULL,
      head_ref TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      merge_base_sha TEXT NOT NULL,
      github_updated_at TEXT NOT NULL,
      last_reviewed_head_sha TEXT,
      last_reviewed_base_sha TEXT,
      round INTEGER NOT NULL,
      blocker TEXT,
      needs_observation INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner_id, number)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS repo_review_event_receipts (
      owner_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      pull_request INTEGER,
      kind TEXT NOT NULL,
      disposition TEXT NOT NULL,
      job_id TEXT,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (owner_id, event_key)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS repo_review_jobs (
      job_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      pull_request INTEGER NOT NULL,
      round INTEGER NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      merge_base_sha TEXT NOT NULL,
      command_id TEXT NOT NULL,
      thread_id TEXT,
      run_id TEXT,
      external_task_id TEXT,
      brief TEXT,
      launch_attempts INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      launched_at TEXT,
      deadline_at TEXT,
      completed_at TEXT,
      result_json TEXT,
      result_sha256 TEXT,
      verdict TEXT,
      error TEXT,
      UNIQUE (owner_id, pull_request, round)
    )
  `;
  // At most one review in flight per pull request.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_review_jobs_single_active
    ON repo_review_jobs(owner_id, pull_request)
    WHERE status IN ('queued', 'launching', 'running', 'result_received')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_repo_review_jobs_thread
    ON repo_review_jobs(thread_id)
    WHERE thread_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS repo_review_findings (
      owner_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      pull_request INTEGER NOT NULL,
      priority TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT,
      line INTEGER,
      scenario TEXT,
      impact TEXT,
      body TEXT,
      disposition TEXT NOT NULL,
      dedup_key TEXT NOT NULL,
      github_comment_id TEXT,
      github_thread_id TEXT,
      url TEXT,
      reported_job_id TEXT,
      reported_head_sha TEXT,
      resolved_job_id TEXT,
      resolved_head_sha TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner_id, finding_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS repo_review_publications (
      publication_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      pull_request INTEGER NOT NULL,
      kind TEXT NOT NULL,
      job_id TEXT,
      finding_id TEXT,
      expected_head_sha TEXT NOT NULL,
      expected_base_sha TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      github_id TEXT,
      url TEXT,
      detail TEXT,
      attempts INTEGER NOT NULL,
      attempted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_repo_review_publications_pending
    ON repo_review_publications(owner_id, status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS repo_review_imports (
      import_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_sha256 TEXT NOT NULL UNIQUE,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL
    )
  `;
});
