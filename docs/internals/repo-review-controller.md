# Repository review controller

[`repoReview/`](../../apps/server/src/repoReview/) replaces a long-lived model conversation that
reconciled pull requests, review results, findings, approvals and merges. Deterministic server code
owns that state; models only run finite review jobs. Threads show the work, they are not the record.

## Why it has its own tables

The v2 orchestrator's event log and [outbox](../../apps/server/src/orchestration-v2/EffectOutbox.ts)
are keyed by thread, and a repository owner is not a thread. Like scheduled tasks, the controller is
a direct-SQL service (migration 061). Its job and publication rows are its outbox: the intent
(`launching`, `attempting`) commits before the thread launch or GitHub write runs, so a crash leaves a
row that says exactly what may have happened.

## Invariants that are easy to break

- **Launches are retried, never duplicated.** A job's command id and thread id are derived from the
  job id and bound before the launch. `ThreadLaunchService` replays an accepted command from its
  receipt, so re-launching a `launching` job after a crash or an ambiguous answer reuses the thread.
- **Ambiguous writes are settled by reading GitHub.** A timeout or 5xx makes a publication
  `uncertain`. It is confirmed only by finding our own write (the `t3-repo-review:<publication>`
  marker, or an exact-head approval by the posting account). It is retried only after it stayed
  absent for ten minutes, and fails after three attempts.
- **Own comments are recognized by marker or prefix, not login.** On personal repositories the
  reviewing account is often the author; their replies must still count as author events.
- **Results bind to one job.** Only the job's thread and run may submit, and the result must carry
  the job's exact repository, pull request and pins. A result whose head moved before it was
  applied is `stale` and authorizes nothing.
- **Any base movement before landing means another round.** Disjoint file lists do not prove the
  base left the pull request's behavior alone. The merge call is guarded by the reviewed head SHA;
  GitHub's `mergeable_state` must be `clean` or `has_hooks`, so an admin credential never pushes
  through required checks or reviews.
- **Pause is enforced in the claim.** Launch and write claims check the owner's status in the same
  statement, so nothing new starts once a pause commits. `pause_after_round` admits only jobs
  already launched; queued jobs wait.
- **Failed reviews are not retried on their own.** That would spend model turns in a loop; a new
  head, a new author event or `requeue` starts the next round.

One owner per repository is enforced per environment by a partial unique index. Nothing prevents
two environments, or an old `watch-repo` owner, from monitoring the same repository; the import
refuses a ledger whose owner is not stopped.
