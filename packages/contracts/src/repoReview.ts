import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/**
 * Repository review controller: deterministic server code that watches one GitHub repository,
 * launches finite SHA-pinned review jobs, and owns every GitHub write. Models only review.
 */

export const RepoReviewOwnerId = TrimmedNonEmptyString.pipe(Schema.brand("RepoReviewOwnerId"));
export type RepoReviewOwnerId = typeof RepoReviewOwnerId.Type;

export const RepoReviewJobId = TrimmedNonEmptyString.pipe(Schema.brand("RepoReviewJobId"));
export type RepoReviewJobId = typeof RepoReviewJobId.Type;

export const RepoReviewGitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)).annotate({
  description: "Full 40-character lowercase commit SHA.",
});

export const RepoReviewRepositoryName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
).annotate({ description: "GitHub repository as owner/name." });

const BoundedText = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));
const BoundedInt = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

/**
 * `active` polls, launches and publishes. `pausing` finishes the jobs already launched and
 * publishes their results, then becomes `paused` on its own. `paused` does nothing until resumed.
 * `stopped` is terminal: a new owner has to be started.
 */
export const RepoReviewOwnerStatus = Schema.Literals(["active", "pausing", "paused", "stopped"]);
export type RepoReviewOwnerStatus = typeof RepoReviewOwnerStatus.Type;

export const RepoReviewMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type RepoReviewMergeMethod = typeof RepoReviewMergeMethod.Type;

export const RepoReviewPolicy = Schema.Struct({
  postFindings: Schema.Boolean,
  approve: Schema.Boolean,
  merge: Schema.Boolean,
  mergeMethod: RepoReviewMergeMethod,
  reviewDrafts: Schema.Boolean,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  maxConcurrentJobs: BoundedInt(1, 8),
  pollIntervalSeconds: BoundedInt(60, 86_400),
  jobTimeoutMinutes: BoundedInt(10, 1_440),
  /** First line of every public comment, naming the model and the account it writes for. */
  commentPrefix: BoundedText(300),
  /** Repository-specific review instructions, such as which AGENTS.md or test docs to read. */
  instructions: BoundedText(8_000),
});
export type RepoReviewPolicy = typeof RepoReviewPolicy.Type;

export const RepoReviewPolicyInput = Schema.Struct({
  postFindings: Schema.optional(Schema.Boolean),
  approve: Schema.optional(Schema.Boolean),
  merge: Schema.optional(Schema.Boolean),
  mergeMethod: Schema.optional(RepoReviewMergeMethod),
  reviewDrafts: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  maxConcurrentJobs: Schema.optional(BoundedInt(1, 8)),
  pollIntervalSeconds: Schema.optional(BoundedInt(60, 86_400)),
  jobTimeoutMinutes: Schema.optional(BoundedInt(10, 1_440)),
  commentPrefix: Schema.optional(BoundedText(300)),
  instructions: Schema.optional(BoundedText(8_000)),
});
export type RepoReviewPolicyInput = typeof RepoReviewPolicyInput.Type;

export const RepoReviewPullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type RepoReviewPullRequestState = typeof RepoReviewPullRequestState.Type;

export const RepoReviewJobTrigger = Schema.Literals([
  "new_pull_request",
  "new_head",
  "author_event",
  "base_retarget",
  "integration_change",
  "requeue",
]);
export type RepoReviewJobTrigger = typeof RepoReviewJobTrigger.Type;

/**
 * `queued` waits for capacity; `launching` has its intent recorded and is retried with the same
 * command id until the thread exists; `result_received` holds a validated result not yet applied.
 * `stale` means the result no longer matches the pull request and authorizes nothing.
 * `imported` is history carried over from an earlier owner; it never ran here.
 */
export const RepoReviewJobStatus = Schema.Literals([
  "queued",
  "launching",
  "running",
  "result_received",
  "completed",
  "stale",
  "failed",
  "cancelled",
  "imported",
]);
export type RepoReviewJobStatus = typeof RepoReviewJobStatus.Type;

export const RepoReviewFindingPriority = Schema.Literals(["P0", "P1", "P2", "P3"]);
export type RepoReviewFindingPriority = typeof RepoReviewFindingPriority.Type;

export const RepoReviewFindingDisposition = Schema.Literals(["open", "fixed", "withdrawn"]);
export type RepoReviewFindingDisposition = typeof RepoReviewFindingDisposition.Type;

export const RepoReviewPublicationKind = Schema.Literals(["finding_comment", "approval", "merge"]);
export type RepoReviewPublicationKind = typeof RepoReviewPublicationKind.Type;

/**
 * `attempting` is written before the GitHub call. A crash or an ambiguous answer leaves it
 * `uncertain`, which is settled by reading GitHub back, never by writing again blindly.
 */
export const RepoReviewPublicationStatus = Schema.Literals([
  "planned",
  "attempting",
  "uncertain",
  "blocked",
  "confirmed",
  "failed",
  "cancelled",
]);
export type RepoReviewPublicationStatus = typeof RepoReviewPublicationStatus.Type;

// ---------------------------------------------------------------------------
// Worker result: what a review job submits through repo_review_submit_result.
// ---------------------------------------------------------------------------

export const RepoReviewResultFinding = Schema.Struct({
  /** An existing canonical finding id from the brief. Omit for a new finding. */
  canonicalId: Schema.optional(TrimmedNonEmptyString),
  status: Schema.Literals(["new", "still_open", "fixed", "withdrawn"]),
  priority: Schema.optional(RepoReviewFindingPriority),
  title: Schema.optional(BoundedText(300)),
  path: Schema.optional(BoundedText(1_000)),
  line: Schema.optional(PositiveInt),
  scenario: Schema.optional(BoundedText(4_000)),
  impact: Schema.optional(BoundedText(2_000)),
  /** Markdown body for the public comment of a new finding, without prefix or marker. */
  body: Schema.optional(BoundedText(6_000)),
  evidence: Schema.optional(BoundedText(4_000)),
});
export type RepoReviewResultFinding = typeof RepoReviewResultFinding.Type;

/** Where a piece of evidence came from. Only fresh reviewer checks were run by the reviewer. */
export const RepoReviewEvidenceProvenance = Schema.Literals([
  "fresh_reviewer_check",
  "author_reported",
  "unrun",
]);
export type RepoReviewEvidenceProvenance = typeof RepoReviewEvidenceProvenance.Type;

export const RepoReviewResultEvidence = Schema.Struct({
  provenance: RepoReviewEvidenceProvenance,
  kind: BoundedText(200),
  description: BoundedText(2_000),
  command: Schema.optional(BoundedText(1_000)),
  outcome: Schema.optional(Schema.Literals(["passed", "failed", "inconclusive", "not_run"])),
});
export type RepoReviewResultEvidence = typeof RepoReviewResultEvidence.Type;

export const RepoReviewJobResult = Schema.Struct({
  jobId: RepoReviewJobId,
  repository: RepoReviewRepositoryName,
  pullRequest: PositiveInt,
  pins: Schema.Struct({
    headSha: RepoReviewGitSha,
    baseRef: TrimmedNonEmptyString,
    baseSha: RepoReviewGitSha,
    mergeBaseSha: RepoReviewGitSha,
  }),
  verdict: Schema.Literals(["findings", "clean", "blocked"]),
  summary: BoundedText(6_000),
  findings: Schema.Array(RepoReviewResultFinding).check(Schema.isMaxLength(50)),
  evidence: Schema.Array(RepoReviewResultEvidence).check(Schema.isMaxLength(60)),
  coverage: Schema.Struct({
    effectiveDiffInspected: Schema.Boolean,
    filesInspected: NonNegativeInt,
    /** Paths whose blobs were proven identical to an earlier reviewed revision. */
    reusedUnchangedPaths: Schema.Array(BoundedText(1_000)).check(Schema.isMaxLength(2_000)),
    notes: BoundedText(4_000),
  }),
  blockedReason: Schema.optional(BoundedText(2_000)),
});
export type RepoReviewJobResult = typeof RepoReviewJobResult.Type;

export const RepoReviewSubmitResultOutput = Schema.Struct({
  jobId: RepoReviewJobId,
  duplicate: Schema.Boolean,
  jobStatus: RepoReviewJobStatus,
  message: Schema.String,
});
export type RepoReviewSubmitResultOutput = typeof RepoReviewSubmitResultOutput.Type;

// ---------------------------------------------------------------------------
// Read model.
// ---------------------------------------------------------------------------

export const RepoReviewOwner = Schema.Struct({
  id: RepoReviewOwnerId,
  host: TrimmedNonEmptyString,
  repository: RepoReviewRepositoryName,
  projectId: ProjectId,
  account: TrimmedNonEmptyString,
  status: RepoReviewOwnerStatus,
  statusReason: Schema.NullOr(Schema.String),
  statusChangedAt: IsoDateTime,
  pauseRequestedAt: Schema.NullOr(IsoDateTime),
  policy: RepoReviewPolicy,
  lastPollAt: Schema.NullOr(IsoDateTime),
  lastPollError: Schema.NullOr(Schema.String),
  importSource: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type RepoReviewOwner = typeof RepoReviewOwner.Type;

export const RepoReviewPullRequestView = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  state: RepoReviewPullRequestState,
  draft: Schema.Boolean,
  headSha: Schema.String,
  baseRef: Schema.String,
  baseSha: Schema.String,
  lastReviewedHeadSha: Schema.NullOr(Schema.String),
  round: NonNegativeInt,
  blocker: Schema.NullOr(Schema.String),
});

export const RepoReviewJobView = Schema.Struct({
  id: RepoReviewJobId,
  pullRequest: PositiveInt,
  round: PositiveInt,
  trigger: RepoReviewJobTrigger,
  status: RepoReviewJobStatus,
  headSha: Schema.String,
  baseSha: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  verdict: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});

export const RepoReviewFindingView = Schema.Struct({
  id: Schema.String,
  pullRequest: PositiveInt,
  priority: Schema.String,
  title: Schema.String,
  disposition: RepoReviewFindingDisposition,
  url: Schema.NullOr(Schema.String),
});

export const RepoReviewPublicationView = Schema.Struct({
  id: Schema.String,
  pullRequest: PositiveInt,
  kind: RepoReviewPublicationKind,
  status: RepoReviewPublicationStatus,
  expectedHeadSha: Schema.String,
  url: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
});

export const RepoReviewOwnerView = Schema.Struct({
  owner: RepoReviewOwner,
  pullRequests: Schema.Array(RepoReviewPullRequestView),
  jobs: Schema.Array(RepoReviewJobView),
  openFindings: Schema.Array(RepoReviewFindingView),
  publications: Schema.Array(RepoReviewPublicationView),
});
export type RepoReviewOwnerView = typeof RepoReviewOwnerView.Type;

export const RepoReviewStatusInput = Schema.Struct({
  ownerId: Schema.optional(RepoReviewOwnerId),
  includeStopped: Schema.optional(Schema.Boolean),
});
export type RepoReviewStatusInput = typeof RepoReviewStatusInput.Type;

export const RepoReviewStatusResult = Schema.Struct({
  owners: Schema.Array(RepoReviewOwnerView),
});
export type RepoReviewStatusResult = typeof RepoReviewStatusResult.Type;

// ---------------------------------------------------------------------------
// Control.
// ---------------------------------------------------------------------------

export const RepoReviewStartInput = Schema.Struct({
  projectId: ProjectId,
  repository: RepoReviewRepositoryName,
  host: Schema.optional(TrimmedNonEmptyString),
  policy: Schema.optional(RepoReviewPolicyInput),
  /** Start polling immediately. Defaults to false: the owner starts paused. */
  activate: Schema.optional(Schema.Boolean),
});
export type RepoReviewStartInput = typeof RepoReviewStartInput.Type;

export const RepoReviewControlAction = Schema.Literals([
  "pause",
  "pause_after_round",
  "resume",
  "stop",
  "poll_now",
  "requeue",
]);
export type RepoReviewControlAction = typeof RepoReviewControlAction.Type;

export const RepoReviewControlInput = Schema.Struct({
  ownerId: RepoReviewOwnerId,
  action: RepoReviewControlAction,
  /** Required by requeue: the pull request whose failed review is started again. */
  pullRequest: Schema.optional(PositiveInt),
  reason: Schema.optional(BoundedText(500)),
});
export type RepoReviewControlInput = typeof RepoReviewControlInput.Type;

export const RepoReviewImportInput = Schema.Struct({
  /** Absolute path of a watch-repo session ledger (schema 1). */
  ledgerPath: TrimmedNonEmptyString,
  projectId: ProjectId,
  host: Schema.optional(TrimmedNonEmptyString),
  policy: Schema.optional(RepoReviewPolicyInput),
  /** Defaults to true: validate and report without writing anything. */
  dryRun: Schema.optional(Schema.Boolean),
});
export type RepoReviewImportInput = typeof RepoReviewImportInput.Type;

export const RepoReviewImportResult = Schema.Struct({
  dryRun: Schema.Boolean,
  ownerId: Schema.NullOr(RepoReviewOwnerId),
  repository: RepoReviewRepositoryName,
  account: Schema.String,
  sourceSha256: Schema.String,
  alreadyImported: Schema.Boolean,
  pullRequests: NonNegativeInt,
  openPullRequests: Schema.Array(PositiveInt),
  findings: NonNegativeInt,
  openFindings: Schema.Array(RepoReviewFindingView),
  approvals: NonNegativeInt,
  merges: NonNegativeInt,
  jobs: NonNegativeInt,
  eventReceipts: NonNegativeInt,
  warnings: Schema.Array(Schema.String),
  /** Reasons the import cannot be applied; a dry run still reports everything else. */
  blockers: Schema.Array(Schema.String),
});
export type RepoReviewImportResult = typeof RepoReviewImportResult.Type;

export class RepoReviewFailure extends Schema.TaggedError<RepoReviewFailure>()(
  "RepoReviewFailure",
  {
    code: Schema.Literals([
      "not_found",
      "invalid_request",
      "conflict",
      "invalid_result",
      "github_unavailable",
      "storage_error",
    ]),
    message: Schema.String,
  },
) {}
