import {
  type ProjectId,
  type RepoReviewFindingDisposition,
  type RepoReviewFindingPriority,
  type RepoReviewJobResult,
  type RepoReviewJobStatus,
  type RepoReviewJobTrigger,
  type RepoReviewOwnerStatus,
  type RepoReviewPolicy,
  type RepoReviewPublicationKind,
  type RepoReviewPublicationStatus,
  type ThreadId,
  RepoReviewJobResult as RepoReviewJobResultSchema,
  RepoReviewPolicy as RepoReviewPolicySchema,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import type {
  CanonicalFinding,
  EventReceipt,
  PublicationPayload,
  StoredPullRequest,
} from "./decisions.ts";

export class RepoReviewStoreError extends Schema.TaggedError<RepoReviewStoreError>()(
  "RepoReviewStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Repository review storage failed during ${this.operation}.`;
  }
}

export interface OwnerRecord {
  readonly id: string;
  readonly host: string;
  readonly repository: string;
  readonly githubRepositoryId: string | null;
  readonly projectId: ProjectId;
  readonly account: string;
  readonly status: RepoReviewOwnerStatus;
  readonly statusReason: string | null;
  readonly statusChangedAt: string;
  readonly pauseRequestedAt: string | null;
  readonly policy: RepoReviewPolicy;
  readonly lastPollAt: string | null;
  readonly nextPollAt: string | null;
  readonly lastPollError: string | null;
  readonly importSource: string | null;
  readonly eventsBaselineAt: string | null;
  readonly createdAt: string;
}

export interface PullRequestRecord extends StoredPullRequest {
  readonly needsObservation: boolean;
}

export interface JobRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly pullRequest: number;
  readonly round: number;
  readonly trigger: RepoReviewJobTrigger;
  readonly status: RepoReviewJobStatus;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly commandId: string;
  readonly threadId: ThreadId | null;
  readonly runId: string | null;
  readonly externalTaskId: string | null;
  readonly brief: string | null;
  readonly launchAttempts: number;
  readonly createdAt: string;
  readonly launchedAt: string | null;
  readonly deadlineAt: string | null;
  readonly completedAt: string | null;
  readonly result: RepoReviewJobResult | null;
  readonly resultSha256: string | null;
  readonly verdict: string | null;
  readonly error: string | null;
}

export interface PublicationRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly pullRequest: number;
  readonly kind: RepoReviewPublicationKind;
  readonly jobId: string | null;
  readonly findingId: string | null;
  readonly expectedHeadSha: string;
  readonly expectedBaseSha: string;
  readonly payload: PublicationPayload;
  readonly status: RepoReviewPublicationStatus;
  readonly githubId: string | null;
  readonly url: string | null;
  readonly detail: string | null;
  readonly attempts: number;
  readonly attemptedAt: string | null;
  readonly createdAt: string;
}

interface OwnerRow {
  readonly owner_id: string;
  readonly host: string;
  readonly repository: string;
  readonly github_repository_id: string | null;
  readonly project_id: string;
  readonly account: string;
  readonly status: string;
  readonly status_reason: string | null;
  readonly status_changed_at: string;
  readonly pause_requested_at: string | null;
  readonly policy_json: string;
  readonly last_poll_at: string | null;
  readonly next_poll_at: string | null;
  readonly last_poll_error: string | null;
  readonly import_source: string | null;
  readonly events_baseline_at: string | null;
  readonly created_at: string;
}

interface PullRequestRow {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly draft: number;
  readonly author_login: string;
  readonly head_ref: string;
  readonly head_sha: string;
  readonly base_ref: string;
  readonly base_sha: string;
  readonly merge_base_sha: string;
  readonly github_updated_at: string;
  readonly last_reviewed_head_sha: string | null;
  readonly last_reviewed_base_sha: string | null;
  readonly round: number;
  readonly blocker: string | null;
  readonly needs_observation: number;
}

interface JobRow {
  readonly job_id: string;
  readonly owner_id: string;
  readonly pull_request: number;
  readonly round: number;
  readonly trigger: string;
  readonly status: string;
  readonly head_sha: string;
  readonly base_ref: string;
  readonly base_sha: string;
  readonly merge_base_sha: string;
  readonly command_id: string;
  readonly thread_id: string | null;
  readonly run_id: string | null;
  readonly external_task_id: string | null;
  readonly brief: string | null;
  readonly launch_attempts: number;
  readonly created_at: string;
  readonly launched_at: string | null;
  readonly deadline_at: string | null;
  readonly completed_at: string | null;
  readonly result_json: string | null;
  readonly result_sha256: string | null;
  readonly verdict: string | null;
  readonly error: string | null;
}

interface FindingRow {
  readonly finding_id: string;
  readonly pull_request: number;
  readonly priority: string;
  readonly title: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly scenario: string | null;
  readonly impact: string | null;
  readonly body: string | null;
  readonly disposition: string;
  readonly dedup_key: string;
  readonly github_comment_id: string | null;
  readonly github_thread_id: string | null;
  readonly url: string | null;
}

interface PublicationRow {
  readonly publication_id: string;
  readonly owner_id: string;
  readonly pull_request: number;
  readonly kind: string;
  readonly job_id: string | null;
  readonly finding_id: string | null;
  readonly expected_head_sha: string;
  readonly expected_base_sha: string;
  readonly payload_json: string;
  readonly status: string;
  readonly github_id: string | null;
  readonly url: string | null;
  readonly detail: string | null;
  readonly attempts: number;
  readonly attempted_at: string | null;
  readonly created_at: string;
}

const PolicyJson = Schema.fromJsonString(RepoReviewPolicySchema);
const ResultJson = Schema.fromJsonString(RepoReviewJobResultSchema);
const PayloadJson = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("finding_comment"),
      path: Schema.String,
      line: Schema.Int,
      body: Schema.String,
    }),
    Schema.Struct({ kind: Schema.Literal("approval"), body: Schema.String }),
    Schema.Struct({
      kind: Schema.Literal("merge"),
      method: Schema.Literals(["merge", "squash", "rebase"]),
    }),
  ]),
);
const decodePolicy = Schema.decodeUnknownEffect(PolicyJson);
const encodePolicy = Schema.encodeEffect(PolicyJson);
const decodeResult = Schema.decodeUnknownEffect(ResultJson);
const encodeResult = Schema.encodeEffect(ResultJson);
const decodePayload = Schema.decodeUnknownEffect(PayloadJson);
const encodePayload = Schema.encodeEffect(PayloadJson);

/** Owner states in which a pending write may still start (see `claimPublication`). */
export type PublicationGate = "active" | "active_or_pausing";

export interface NewJob {
  readonly id: string;
  readonly ownerId: string;
  readonly pullRequest: number;
  readonly round: number;
  readonly trigger: RepoReviewJobTrigger;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly commandId: string;
  readonly threadId: ThreadId;
}

export class RepoReviewStore extends Context.Service<
  RepoReviewStore,
  {
    /** Runs `effect` in one transaction; any SQL failure, inside or around it, is a store error. */
    readonly transaction: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, Exclude<E, SqlError.SqlError> | RepoReviewStoreError, R>;

    readonly insertOwner: (
      owner: Omit<OwnerRecord, "lastPollAt" | "lastPollError"> & { readonly now: string },
    ) => Effect.Effect<void, RepoReviewStoreError | SqlError.SqlError>;
    readonly getOwner: (id: string) => Effect.Effect<OwnerRecord | null, RepoReviewStoreError>;
    readonly findOwnerForRepository: (
      host: string,
      repository: string,
    ) => Effect.Effect<OwnerRecord | null, RepoReviewStoreError>;
    readonly listOwners: (input: {
      readonly includeStopped: boolean;
    }) => Effect.Effect<ReadonlyArray<OwnerRecord>, RepoReviewStoreError>;
    readonly setOwnerStatus: (input: {
      readonly id: string;
      readonly status: RepoReviewOwnerStatus;
      readonly reason: string | null;
      readonly pauseRequestedAt: string | null;
      readonly now: string;
      /** Only change an owner currently in one of these states. */
      readonly from: ReadonlyArray<RepoReviewOwnerStatus>;
    }) => Effect.Effect<boolean, RepoReviewStoreError>;
    readonly recordPoll: (input: {
      readonly id: string;
      readonly now: string;
      readonly nextPollAt: string;
      readonly error: string | null;
      readonly githubRepositoryId?: string;
    }) => Effect.Effect<void, RepoReviewStoreError>;
    readonly requestPoll: (id: string, at: string) => Effect.Effect<void, RepoReviewStoreError>;

    readonly listPullRequests: (
      ownerId: string,
    ) => Effect.Effect<ReadonlyArray<PullRequestRecord>, RepoReviewStoreError>;
    /** Review progress (last reviewed pins, round) is only set on insert; later writes keep it. */
    readonly upsertPullRequest: (
      ownerId: string,
      pullRequest: StoredPullRequest,
      now: string,
    ) => Effect.Effect<void, RepoReviewStoreError>;
    readonly markReviewed: (input: {
      readonly ownerId: string;
      readonly number: number;
      readonly headSha: string;
      readonly baseSha: string;
      readonly now: string;
    }) => Effect.Effect<void, RepoReviewStoreError>;
    readonly setBlocker: (
      ownerId: string,
      number: number,
      blocker: string | null,
    ) => Effect.Effect<void, RepoReviewStoreError>;

    readonly handledEventKeys: (
      ownerId: string,
    ) => Effect.Effect<ReadonlySet<string>, RepoReviewStoreError>;
    readonly insertReceipts: (input: {
      readonly ownerId: string;
      readonly pullRequest: number | null;
      readonly jobId: string | null;
      readonly receipts: ReadonlyArray<EventReceipt>;
      readonly now: string;
    }) => Effect.Effect<void, RepoReviewStoreError>;

    readonly insertJob: (job: NewJob, now: string) => Effect.Effect<void, RepoReviewStoreError>;
    readonly getJob: (id: string) => Effect.Effect<JobRecord | null, RepoReviewStoreError>;
    readonly getJobByThread: (
      threadId: string,
    ) => Effect.Effect<JobRecord | null, RepoReviewStoreError>;
    readonly listJobs: (input: {
      readonly ownerId: string;
      readonly statuses?: ReadonlyArray<RepoReviewJobStatus>;
      readonly pullRequest?: number;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<JobRecord>, RepoReviewStoreError>;
    /** queued → launching, only while the owner is active. Persists the brief retries reuse. */
    readonly claimLaunch: (input: {
      readonly jobId: string;
      readonly brief: string;
      readonly now: string;
      readonly deadlineAt: string;
    }) => Effect.Effect<boolean, RepoReviewStoreError>;
    readonly recordLaunchAttempt: (input: {
      readonly jobId: string;
      readonly error: string;
    }) => Effect.Effect<number, RepoReviewStoreError>;
    readonly markRunning: (input: {
      readonly jobId: string;
      readonly runId: string | null;
    }) => Effect.Effect<boolean, RepoReviewStoreError>;
    readonly acceptResult: (input: {
      readonly jobId: string;
      readonly result: RepoReviewJobResult;
      readonly resultSha256: string;
    }) => Effect.Effect<boolean, RepoReviewStoreError>;
    /** Moves a job between states; false when it was no longer in one of `from`. */
    readonly transitionJob: (input: {
      readonly jobId: string;
      readonly from: ReadonlyArray<RepoReviewJobStatus>;
      readonly to: RepoReviewJobStatus;
      readonly error: string | null;
      readonly now: string;
    }) => Effect.Effect<boolean, RepoReviewStoreError>;

    readonly listFindings: (input: {
      readonly ownerId: string;
      readonly pullRequest?: number;
    }) => Effect.Effect<ReadonlyArray<CanonicalFinding>, RepoReviewStoreError>;
    readonly insertFinding: (input: {
      readonly ownerId: string;
      readonly finding: CanonicalFinding;
      readonly source: "review" | "import";
      readonly reportedJobId: string | null;
      readonly reportedHeadSha: string | null;
      readonly now: string;
    }) => Effect.Effect<void, RepoReviewStoreError>;
    readonly setFindingDisposition: (input: {
      readonly ownerId: string;
      readonly findingId: string;
      readonly disposition: RepoReviewFindingDisposition;
      readonly jobId: string;
      readonly headSha: string;
      readonly now: string;
    }) => Effect.Effect<void, RepoReviewStoreError>;
    readonly attachFindingComment: (input: {
      readonly ownerId: string;
      readonly findingId: string;
      readonly githubCommentId: string;
      readonly url: string;
      readonly now: string;
    }) => Effect.Effect<void, RepoReviewStoreError>;

    /**
     * Plans a write. A confirmed or in-flight write is kept. An unconfirmed one keeps settling but
     * is adopted by the newer review; anything else is planned again with its pins.
     */
    readonly planPublication: (input: {
      readonly id: string;
      readonly ownerId: string;
      readonly pullRequest: number;
      readonly kind: RepoReviewPublicationKind;
      readonly jobId: string | null;
      readonly findingId: string | null;
      readonly expectedHeadSha: string;
      readonly expectedBaseSha: string;
      readonly payload: PublicationPayload;
      readonly now: string;
    }) => Effect.Effect<void, RepoReviewStoreError>;
    readonly insertConfirmedPublication: (input: {
      readonly id: string;
      readonly ownerId: string;
      readonly pullRequest: number;
      readonly kind: RepoReviewPublicationKind;
      readonly expectedHeadSha: string;
      readonly payload: PublicationPayload;
      readonly githubId: string;
      readonly url: string | null;
      readonly detail: string;
      readonly now: string;
    }) => Effect.Effect<void, RepoReviewStoreError>;
    readonly listPublications: (input: {
      readonly ownerId: string;
      readonly statuses?: ReadonlyArray<RepoReviewPublicationStatus>;
      readonly pullRequest?: number;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<PublicationRecord>, RepoReviewStoreError>;
    /**
     * planned → attempting in one statement that also checks the owner may still write. Once a
     * pause commits, no new write can start.
     */
    readonly claimPublication: (input: {
      readonly id: string;
      readonly gate: PublicationGate;
      readonly now: string;
    }) => Effect.Effect<boolean, RepoReviewStoreError>;
    readonly settlePublication: (input: {
      readonly id: string;
      readonly from: ReadonlyArray<RepoReviewPublicationStatus>;
      readonly to: RepoReviewPublicationStatus;
      readonly githubId?: string | null;
      readonly url?: string | null;
      readonly detail: string | null;
      readonly now: string;
    }) => Effect.Effect<boolean, RepoReviewStoreError>;
    readonly cancelPublicationsForOwner: (input: {
      readonly ownerId: string;
      readonly statuses: ReadonlyArray<RepoReviewPublicationStatus>;
      readonly detail: string;
      readonly now: string;
      /** Narrows to one pull request's approvals and merges planned by other jobs. */
      readonly supersededLandings?: { readonly pullRequest: number; readonly jobId: string };
    }) => Effect.Effect<void, RepoReviewStoreError>;

    readonly findImport: (
      sourceSha256: string,
    ) => Effect.Effect<{ readonly ownerId: string } | null, RepoReviewStoreError>;
    readonly insertImport: (input: {
      readonly id: string;
      readonly ownerId: string;
      readonly sourcePath: string;
      readonly sourceSha256: string;
      readonly rawJson: string;
      readonly now: string;
    }) => Effect.Effect<void, RepoReviewStoreError>;
    readonly insertImportedJob: (input: {
      readonly id: string;
      readonly ownerId: string;
      readonly pullRequest: number;
      readonly round: number;
      readonly headSha: string;
      readonly baseRef: string;
      readonly baseSha: string;
      readonly externalTaskId: string | null;
      readonly threadId: string | null;
      readonly verdict: string | null;
      readonly createdAt: string;
    }) => Effect.Effect<void, RepoReviewStoreError>;
  }
>()("t3/repoReview/RepoReviewStore") {}

const ACTIVE_JOB = ["queued", "launching", "running", "result_received"] as const;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fail = (operation: string) => (cause: unknown) =>
    new RepoReviewStoreError({ operation, cause });

  const toOwner = (row: OwnerRow) =>
    decodePolicy(row.policy_json).pipe(
      Effect.mapError(fail("decode-owner")),
      Effect.map((policy): OwnerRecord => ({
        id: row.owner_id,
        host: row.host,
        repository: row.repository,
        githubRepositoryId: row.github_repository_id,
        projectId: row.project_id as ProjectId,
        account: row.account,
        status: row.status as RepoReviewOwnerStatus,
        statusReason: row.status_reason,
        statusChangedAt: row.status_changed_at,
        pauseRequestedAt: row.pause_requested_at,
        policy,
        lastPollAt: row.last_poll_at,
        nextPollAt: row.next_poll_at,
        lastPollError: row.last_poll_error,
        importSource: row.import_source,
        eventsBaselineAt: row.events_baseline_at,
        createdAt: row.created_at,
      })),
    );

  const toPullRequest = (row: PullRequestRow): PullRequestRecord => ({
    number: row.number,
    title: row.title,
    state: row.state as PullRequestRecord["state"],
    draft: row.draft === 1,
    authorLogin: row.author_login,
    headRef: row.head_ref,
    headSha: row.head_sha,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    mergeBaseSha: row.merge_base_sha,
    githubUpdatedAt: row.github_updated_at,
    lastReviewedHeadSha: row.last_reviewed_head_sha,
    lastReviewedBaseSha: row.last_reviewed_base_sha,
    round: row.round,
    blocker: row.blocker,
    needsObservation: row.needs_observation === 1,
  });

  const toJob = (row: JobRow) =>
    Effect.gen(function* () {
      const result =
        row.result_json === null
          ? null
          : yield* decodeResult(row.result_json).pipe(Effect.mapError(fail("decode-job")));
      return {
        id: row.job_id,
        ownerId: row.owner_id,
        pullRequest: row.pull_request,
        round: row.round,
        trigger: row.trigger as RepoReviewJobTrigger,
        status: row.status as RepoReviewJobStatus,
        headSha: row.head_sha,
        baseRef: row.base_ref,
        baseSha: row.base_sha,
        mergeBaseSha: row.merge_base_sha,
        commandId: row.command_id,
        threadId: row.thread_id as ThreadId | null,
        runId: row.run_id,
        externalTaskId: row.external_task_id,
        brief: row.brief,
        launchAttempts: row.launch_attempts,
        createdAt: row.created_at,
        launchedAt: row.launched_at,
        deadlineAt: row.deadline_at,
        completedAt: row.completed_at,
        result,
        resultSha256: row.result_sha256,
        verdict: row.verdict,
        error: row.error,
      } satisfies JobRecord;
    });

  const toFinding = (row: FindingRow): CanonicalFinding => ({
    id: row.finding_id,
    pullRequest: row.pull_request,
    priority: row.priority as RepoReviewFindingPriority,
    title: row.title,
    path: row.path,
    line: row.line,
    scenario: row.scenario,
    impact: row.impact,
    body: row.body,
    disposition: row.disposition as RepoReviewFindingDisposition,
    dedupKey: row.dedup_key,
    githubCommentId: row.github_comment_id,
    githubThreadId: row.github_thread_id,
    url: row.url,
  });

  const toPublication = (row: PublicationRow) =>
    decodePayload(row.payload_json).pipe(
      Effect.mapError(fail("decode-publication")),
      Effect.map((payload): PublicationRecord => ({
        id: row.publication_id,
        ownerId: row.owner_id,
        pullRequest: row.pull_request,
        kind: row.kind as RepoReviewPublicationKind,
        jobId: row.job_id,
        findingId: row.finding_id,
        expectedHeadSha: row.expected_head_sha,
        expectedBaseSha: row.expected_base_sha,
        payload,
        status: row.status as RepoReviewPublicationStatus,
        githubId: row.github_id,
        url: row.url,
        detail: row.detail,
        attempts: row.attempts,
        attemptedAt: row.attempted_at,
        createdAt: row.created_at,
      })),
    );

  const transaction: RepoReviewStore["Service"]["transaction"] = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error): Exclude<E, SqlError.SqlError> | RepoReviewStoreError =>
          SqlError.isSqlError(error)
            ? fail("transaction")(error)
            : (error as Exclude<E, SqlError.SqlError>),
        ),
      );

  const insertOwner: RepoReviewStore["Service"]["insertOwner"] = (owner) =>
    Effect.gen(function* () {
      const policyJson = yield* encodePolicy(owner.policy).pipe(
        Effect.mapError(fail("encode-owner")),
      );
      yield* sql`INSERT INTO repo_review_owners ${sql.insert({
        owner_id: owner.id,
        host: owner.host,
        repository: owner.repository,
        repository_key: owner.repository.toLowerCase(),
        github_repository_id: owner.githubRepositoryId,
        project_id: owner.projectId,
        account: owner.account,
        status: owner.status,
        status_reason: owner.statusReason,
        status_changed_at: owner.statusChangedAt,
        pause_requested_at: owner.pauseRequestedAt,
        policy_json: policyJson,
        last_poll_at: null,
        next_poll_at: owner.nextPollAt,
        last_poll_error: null,
        import_source: owner.importSource,
        events_baseline_at: owner.eventsBaselineAt,
        created_at: owner.createdAt,
        updated_at: owner.now,
      })}`;
    });

  const selectOwners = (
    rows: Effect.Effect<ReadonlyArray<OwnerRow>, SqlError.SqlError>,
    operation: string,
  ) =>
    rows.pipe(
      Effect.mapError(fail(operation)),
      Effect.flatMap((found) => Effect.forEach(found, toOwner)),
    );

  const getOwner: RepoReviewStore["Service"]["getOwner"] = (id) =>
    selectOwners(
      sql<OwnerRow>`SELECT * FROM repo_review_owners WHERE owner_id = ${id}`,
      "get-owner",
    ).pipe(Effect.map((owners) => owners[0] ?? null));

  const findOwnerForRepository: RepoReviewStore["Service"]["findOwnerForRepository"] = (
    host,
    repository,
  ) =>
    selectOwners(
      sql<OwnerRow>`
        SELECT * FROM repo_review_owners
        WHERE host = ${host} AND repository_key = ${repository.toLowerCase()} AND status <> 'stopped'
      `,
      "find-owner",
    ).pipe(Effect.map((owners) => owners[0] ?? null));

  const listOwners: RepoReviewStore["Service"]["listOwners"] = ({ includeStopped }) =>
    selectOwners(
      includeStopped
        ? sql<OwnerRow>`SELECT * FROM repo_review_owners ORDER BY created_at`
        : sql<OwnerRow>`SELECT * FROM repo_review_owners WHERE status <> 'stopped' ORDER BY created_at`,
      "list-owners",
    );

  const setOwnerStatus: RepoReviewStore["Service"]["setOwnerStatus"] = (input) =>
    sql<{ readonly owner_id: string }>`
      UPDATE repo_review_owners
      SET status = ${input.status},
          status_reason = ${input.reason},
          pause_requested_at = ${input.pauseRequestedAt},
          status_changed_at = ${input.now},
          next_poll_at = CASE WHEN ${input.status} = 'active' THEN ${input.now} ELSE next_poll_at END,
          updated_at = ${input.now}
      WHERE owner_id = ${input.id} AND status IN ${sql.in(input.from)}
      RETURNING owner_id
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(fail("set-owner-status")),
    );

  const recordPoll: RepoReviewStore["Service"]["recordPoll"] = (input) =>
    sql`
      UPDATE repo_review_owners
      SET last_poll_at = ${input.now},
          next_poll_at = ${input.nextPollAt},
          last_poll_error = ${input.error},
          github_repository_id = COALESCE(${input.githubRepositoryId ?? null}, github_repository_id),
          updated_at = ${input.now}
      WHERE owner_id = ${input.id}
    `.pipe(Effect.asVoid, Effect.mapError(fail("record-poll")));

  const requestPoll: RepoReviewStore["Service"]["requestPoll"] = (id, at) =>
    sql`UPDATE repo_review_owners SET next_poll_at = ${at} WHERE owner_id = ${id}`.pipe(
      Effect.asVoid,
      Effect.mapError(fail("request-poll")),
    );

  const listPullRequests: RepoReviewStore["Service"]["listPullRequests"] = (ownerId) =>
    sql<PullRequestRow>`
      SELECT * FROM repo_review_pull_requests WHERE owner_id = ${ownerId} ORDER BY number
    `.pipe(
      Effect.map((rows) => rows.map(toPullRequest)),
      Effect.mapError(fail("list-pull-requests")),
    );

  const upsertPullRequest: RepoReviewStore["Service"]["upsertPullRequest"] = (ownerId, pr, now) =>
    sql`
      INSERT INTO repo_review_pull_requests ${sql.insert({
        owner_id: ownerId,
        number: pr.number,
        title: pr.title,
        state: pr.state,
        draft: pr.draft ? 1 : 0,
        author_login: pr.authorLogin,
        head_ref: pr.headRef,
        head_sha: pr.headSha,
        base_ref: pr.baseRef,
        base_sha: pr.baseSha,
        merge_base_sha: pr.mergeBaseSha,
        github_updated_at: pr.githubUpdatedAt,
        last_reviewed_head_sha: pr.lastReviewedHeadSha,
        last_reviewed_base_sha: pr.lastReviewedBaseSha,
        round: pr.round,
        blocker: pr.blocker,
        needs_observation: 0,
        updated_at: now,
      })}
      ON CONFLICT (owner_id, number) DO UPDATE SET
        title = excluded.title,
        state = excluded.state,
        draft = excluded.draft,
        author_login = excluded.author_login,
        head_ref = excluded.head_ref,
        head_sha = excluded.head_sha,
        base_ref = excluded.base_ref,
        base_sha = excluded.base_sha,
        merge_base_sha = excluded.merge_base_sha,
        github_updated_at = excluded.github_updated_at,
        blocker = excluded.blocker,
        needs_observation = 0,
        updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, Effect.mapError(fail("upsert-pull-request")));

  const markReviewed: RepoReviewStore["Service"]["markReviewed"] = (input) =>
    sql`
      UPDATE repo_review_pull_requests
      SET last_reviewed_head_sha = ${input.headSha},
          last_reviewed_base_sha = ${input.baseSha},
          updated_at = ${input.now}
      WHERE owner_id = ${input.ownerId} AND number = ${input.number}
    `.pipe(Effect.asVoid, Effect.mapError(fail("mark-reviewed")));

  const setBlocker: RepoReviewStore["Service"]["setBlocker"] = (ownerId, number, blocker) =>
    sql`
      UPDATE repo_review_pull_requests SET blocker = ${blocker}
      WHERE owner_id = ${ownerId} AND number = ${number}
    `.pipe(Effect.asVoid, Effect.mapError(fail("set-blocker")));

  const handledEventKeys: RepoReviewStore["Service"]["handledEventKeys"] = (ownerId) =>
    sql<{ readonly event_key: string }>`
      SELECT event_key FROM repo_review_event_receipts WHERE owner_id = ${ownerId}
    `.pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.event_key))),
      Effect.mapError(fail("handled-event-keys")),
    );

  const insertReceipts: RepoReviewStore["Service"]["insertReceipts"] = (input) =>
    Effect.forEach(
      input.receipts,
      (receipt) => sql`
        INSERT INTO repo_review_event_receipts ${sql.insert({
          owner_id: input.ownerId,
          event_key: receipt.key,
          pull_request: input.pullRequest,
          kind: receipt.kind,
          disposition: receipt.disposition,
          job_id: input.jobId,
          observed_at: input.now,
        })}
        ON CONFLICT (owner_id, event_key) DO NOTHING
      `,
      { discard: true },
    ).pipe(Effect.mapError(fail("insert-receipts")));

  const insertJob: RepoReviewStore["Service"]["insertJob"] = (job, now) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO repo_review_jobs ${sql.insert({
        job_id: job.id,
        owner_id: job.ownerId,
        pull_request: job.pullRequest,
        round: job.round,
        trigger: job.trigger,
        status: "queued",
        head_sha: job.headSha,
        base_ref: job.baseRef,
        base_sha: job.baseSha,
        merge_base_sha: job.mergeBaseSha,
        command_id: job.commandId,
        thread_id: job.threadId,
        run_id: null,
        external_task_id: null,
        brief: null,
        launch_attempts: 0,
        created_at: now,
        launched_at: null,
        deadline_at: null,
        completed_at: null,
        result_json: null,
        result_sha256: null,
        verdict: null,
        error: null,
      })}`;
      yield* sql`
        UPDATE repo_review_pull_requests SET round = ${job.round}
        WHERE owner_id = ${job.ownerId} AND number = ${job.pullRequest}
      `;
      // The job and the round it advances commit together, nested or not.
    }).pipe(sql.withTransaction, Effect.mapError(fail("insert-job")));

  const selectJobs = (
    rows: Effect.Effect<ReadonlyArray<JobRow>, SqlError.SqlError>,
    operation: string,
  ) =>
    rows.pipe(
      Effect.mapError(fail(operation)),
      Effect.flatMap((found) => Effect.forEach(found, toJob)),
    );

  const getJob: RepoReviewStore["Service"]["getJob"] = (id) =>
    selectJobs(sql<JobRow>`SELECT * FROM repo_review_jobs WHERE job_id = ${id}`, "get-job").pipe(
      Effect.map((jobs) => jobs[0] ?? null),
    );

  const getJobByThread: RepoReviewStore["Service"]["getJobByThread"] = (threadId) =>
    selectJobs(
      sql<JobRow>`
        SELECT * FROM repo_review_jobs
        WHERE thread_id = ${threadId} AND status <> 'imported'
        ORDER BY created_at DESC LIMIT 1
      `,
      "get-job-by-thread",
    ).pipe(Effect.map((jobs) => jobs[0] ?? null));

  const listJobs: RepoReviewStore["Service"]["listJobs"] = (input) =>
    selectJobs(
      sql<JobRow>`
        SELECT * FROM repo_review_jobs
        WHERE owner_id = ${input.ownerId}
          ${input.statuses === undefined ? sql`` : sql`AND status IN ${sql.in(input.statuses)}`}
          ${input.pullRequest === undefined ? sql`` : sql`AND pull_request = ${input.pullRequest}`}
        ORDER BY created_at DESC, round DESC
        ${input.limit === undefined ? sql`` : sql`LIMIT ${input.limit}`}
      `,
      "list-jobs",
    );

  const claimLaunch: RepoReviewStore["Service"]["claimLaunch"] = (input) =>
    sql<{ readonly job_id: string }>`
      UPDATE repo_review_jobs
      SET status = 'launching', brief = ${input.brief}, launched_at = ${input.now},
          deadline_at = ${input.deadlineAt}
      WHERE job_id = ${input.jobId} AND status = 'queued'
        AND EXISTS (
          SELECT 1 FROM repo_review_owners o
          WHERE o.owner_id = repo_review_jobs.owner_id AND o.status = 'active'
        )
      RETURNING job_id
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(fail("claim-launch")),
    );

  const recordLaunchAttempt: RepoReviewStore["Service"]["recordLaunchAttempt"] = (input) =>
    sql<{ readonly launch_attempts: number }>`
      UPDATE repo_review_jobs
      SET launch_attempts = launch_attempts + 1, error = ${input.error}
      WHERE job_id = ${input.jobId}
      RETURNING launch_attempts
    `.pipe(
      Effect.map((rows) => rows[0]?.launch_attempts ?? 0),
      Effect.mapError(fail("record-launch-attempt")),
    );

  const markRunning: RepoReviewStore["Service"]["markRunning"] = (input) =>
    sql<{ readonly job_id: string }>`
      UPDATE repo_review_jobs
      SET status = 'running', run_id = COALESCE(${input.runId}, run_id), error = NULL
      WHERE job_id = ${input.jobId} AND status = 'launching'
      RETURNING job_id
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(fail("mark-running")),
    );

  const acceptResult: RepoReviewStore["Service"]["acceptResult"] = (input) =>
    Effect.gen(function* () {
      const resultJson = yield* encodeResult(input.result).pipe(
        Effect.mapError(fail("encode-result")),
      );
      const rows = yield* sql<{ readonly job_id: string }>`
        UPDATE repo_review_jobs
        SET status = 'result_received', result_json = ${resultJson},
            result_sha256 = ${input.resultSha256}, verdict = ${input.result.verdict}
        WHERE job_id = ${input.jobId} AND status IN ('launching', 'running')
          AND result_sha256 IS NULL
        RETURNING job_id
      `.pipe(Effect.mapError(fail("accept-result")));
      return rows.length > 0;
    });

  const transitionJob: RepoReviewStore["Service"]["transitionJob"] = (input) => {
    const terminal = !(ACTIVE_JOB as ReadonlyArray<string>).includes(input.to);
    return Effect.gen(function* () {
      const rows = yield* sql<{ readonly owner_id: string; readonly pull_request: number }>`
        UPDATE repo_review_jobs
        SET status = ${input.to},
            error = COALESCE(${input.error}, error),
            completed_at = CASE WHEN ${terminal ? 1 : 0} = 1 THEN ${input.now} ELSE completed_at END
        WHERE job_id = ${input.jobId} AND status IN ${sql.in(input.from)}
        RETURNING owner_id, pull_request
      `;
      const row = rows[0];
      if (row === undefined) return false;
      if (terminal) {
        // The next poll looks at this pull request again even if GitHub reports no change,
        // so author events that arrived during the review are not stranded.
        yield* sql`
          UPDATE repo_review_pull_requests SET needs_observation = 1
          WHERE owner_id = ${row.owner_id} AND number = ${row.pull_request}
        `;
      }
      return true;
    }).pipe(Effect.mapError(fail("transition-job")));
  };

  const listFindings: RepoReviewStore["Service"]["listFindings"] = (input) =>
    sql<FindingRow>`
      SELECT * FROM repo_review_findings
      WHERE owner_id = ${input.ownerId}
        ${input.pullRequest === undefined ? sql`` : sql`AND pull_request = ${input.pullRequest}`}
      ORDER BY pull_request, created_at, finding_id
    `.pipe(
      Effect.map((rows) => rows.map(toFinding)),
      Effect.mapError(fail("list-findings")),
    );

  const insertFinding: RepoReviewStore["Service"]["insertFinding"] = (input) =>
    sql`
      INSERT INTO repo_review_findings ${sql.insert({
        owner_id: input.ownerId,
        finding_id: input.finding.id,
        pull_request: input.finding.pullRequest,
        priority: input.finding.priority,
        title: input.finding.title,
        path: input.finding.path,
        line: input.finding.line,
        scenario: input.finding.scenario,
        impact: input.finding.impact,
        body: input.finding.body,
        disposition: input.finding.disposition,
        dedup_key: input.finding.dedupKey,
        github_comment_id: input.finding.githubCommentId,
        github_thread_id: input.finding.githubThreadId,
        url: input.finding.url,
        reported_job_id: input.reportedJobId,
        reported_head_sha: input.reportedHeadSha,
        resolved_job_id: null,
        resolved_head_sha: null,
        source: input.source,
        created_at: input.now,
        updated_at: input.now,
      })}
      ON CONFLICT (owner_id, finding_id) DO NOTHING
    `.pipe(Effect.asVoid, Effect.mapError(fail("insert-finding")));

  const setFindingDisposition: RepoReviewStore["Service"]["setFindingDisposition"] = (input) =>
    sql`
      UPDATE repo_review_findings
      SET disposition = ${input.disposition}, resolved_job_id = ${input.jobId},
          resolved_head_sha = ${input.headSha}, updated_at = ${input.now}
      WHERE owner_id = ${input.ownerId} AND finding_id = ${input.findingId}
    `.pipe(Effect.asVoid, Effect.mapError(fail("set-finding-disposition")));

  const attachFindingComment: RepoReviewStore["Service"]["attachFindingComment"] = (input) =>
    sql`
      UPDATE repo_review_findings
      SET github_comment_id = ${input.githubCommentId}, url = ${input.url}, updated_at = ${input.now}
      WHERE owner_id = ${input.ownerId} AND finding_id = ${input.findingId}
    `.pipe(Effect.asVoid, Effect.mapError(fail("attach-finding-comment")));

  const payloadJson = (payload: PublicationPayload) =>
    encodePayload(payload).pipe(Effect.mapError(fail("encode-publication")));

  const planPublication: RepoReviewStore["Service"]["planPublication"] = (input) =>
    Effect.flatMap(payloadJson(input.payload), (payload_json) =>
      sql`
      INSERT INTO repo_review_publications ${sql.insert({
        publication_id: input.id,
        owner_id: input.ownerId,
        pull_request: input.pullRequest,
        kind: input.kind,
        job_id: input.jobId,
        finding_id: input.findingId,
        expected_head_sha: input.expectedHeadSha,
        expected_base_sha: input.expectedBaseSha,
        payload_json,
        status: "planned",
        github_id: null,
        url: null,
        detail: null,
        attempts: 0,
        attempted_at: null,
        created_at: input.now,
        updated_at: input.now,
      })}
      ON CONFLICT (publication_id) DO UPDATE SET
        job_id = excluded.job_id,
        expected_head_sha = excluded.expected_head_sha,
        expected_base_sha = excluded.expected_base_sha,
        payload_json = excluded.payload_json,
        -- An unconfirmed write keeps settling by read-back; the newer round adopts it, since
        -- the same id means the same write at the same head.
        status = CASE WHEN repo_review_publications.status = 'uncertain'
          THEN 'uncertain' ELSE 'planned' END,
        detail = CASE WHEN repo_review_publications.status = 'uncertain'
          THEN repo_review_publications.detail ELSE NULL END,
        updated_at = excluded.updated_at
      WHERE repo_review_publications.status
        IN ('planned', 'uncertain', 'cancelled', 'failed', 'blocked')
    `.pipe(Effect.asVoid, Effect.mapError(fail("plan-publication"))),
    );

  const insertConfirmedPublication: RepoReviewStore["Service"]["insertConfirmedPublication"] = (
    input,
  ) =>
    Effect.flatMap(payloadJson(input.payload), (payload_json) =>
      sql`
      INSERT INTO repo_review_publications ${sql.insert({
        publication_id: input.id,
        owner_id: input.ownerId,
        pull_request: input.pullRequest,
        kind: input.kind,
        job_id: null,
        finding_id: null,
        expected_head_sha: input.expectedHeadSha,
        expected_base_sha: "",
        payload_json,
        status: "confirmed",
        github_id: input.githubId,
        url: input.url,
        detail: input.detail,
        attempts: 0,
        attempted_at: null,
        created_at: input.now,
        updated_at: input.now,
      })}
      ON CONFLICT (publication_id) DO NOTHING
    `.pipe(Effect.asVoid, Effect.mapError(fail("insert-confirmed-publication"))),
    );

  const listPublications: RepoReviewStore["Service"]["listPublications"] = (input) =>
    sql<PublicationRow>`
      SELECT * FROM repo_review_publications
      WHERE owner_id = ${input.ownerId}
        ${input.statuses === undefined ? sql`` : sql`AND status IN ${sql.in(input.statuses)}`}
        ${input.pullRequest === undefined ? sql`` : sql`AND pull_request = ${input.pullRequest}`}
      ORDER BY created_at DESC, publication_id
      ${input.limit === undefined ? sql`` : sql`LIMIT ${input.limit}`}
    `.pipe(
      Effect.mapError(fail("list-publications")),
      Effect.flatMap((rows) => Effect.forEach(rows, toPublication)),
    );

  const claimPublication: RepoReviewStore["Service"]["claimPublication"] = (input) => {
    const statuses = input.gate === "active" ? ["active"] : ["active", "pausing"];
    return sql<{ readonly publication_id: string }>`
      UPDATE repo_review_publications
      SET status = 'attempting', attempts = attempts + 1, attempted_at = ${input.now},
          updated_at = ${input.now}
      WHERE publication_id = ${input.id} AND status = 'planned'
        AND EXISTS (
          SELECT 1 FROM repo_review_owners o
          WHERE o.owner_id = repo_review_publications.owner_id AND o.status IN ${sql.in(statuses)}
        )
      RETURNING publication_id
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(fail("claim-publication")),
    );
  };

  const settlePublication: RepoReviewStore["Service"]["settlePublication"] = (input) =>
    sql<{ readonly publication_id: string }>`
      UPDATE repo_review_publications
      SET status = ${input.to},
          github_id = COALESCE(${input.githubId ?? null}, github_id),
          url = COALESCE(${input.url ?? null}, url),
          detail = ${input.detail},
          updated_at = ${input.now}
      WHERE publication_id = ${input.id} AND status IN ${sql.in(input.from)}
      RETURNING publication_id
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(fail("settle-publication")),
    );

  const cancelPublicationsForOwner: RepoReviewStore["Service"]["cancelPublicationsForOwner"] = (
    input,
  ) =>
    sql`
      UPDATE repo_review_publications
      SET status = 'cancelled', detail = ${input.detail}, updated_at = ${input.now}
      WHERE owner_id = ${input.ownerId} AND status IN ${sql.in(input.statuses)}
        ${
          input.supersededLandings === undefined
            ? sql``
            : sql`AND pull_request = ${input.supersededLandings.pullRequest}
                AND kind IN ('approval', 'merge')
                AND (job_id IS NULL OR job_id <> ${input.supersededLandings.jobId})`
        }
    `.pipe(Effect.asVoid, Effect.mapError(fail("cancel-publications")));

  const findImport: RepoReviewStore["Service"]["findImport"] = (sourceSha256) =>
    sql<{ readonly owner_id: string }>`
      SELECT owner_id FROM repo_review_imports WHERE source_sha256 = ${sourceSha256}
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : { ownerId: rows[0].owner_id })),
      Effect.mapError(fail("find-import")),
    );

  const insertImport: RepoReviewStore["Service"]["insertImport"] = (input) =>
    sql`INSERT INTO repo_review_imports ${sql.insert({
      import_id: input.id,
      owner_id: input.ownerId,
      source_path: input.sourcePath,
      source_sha256: input.sourceSha256,
      raw_json: input.rawJson,
      imported_at: input.now,
    })}`.pipe(Effect.asVoid, Effect.mapError(fail("insert-import")));

  const insertImportedJob: RepoReviewStore["Service"]["insertImportedJob"] = (input) =>
    sql`
      INSERT INTO repo_review_jobs ${sql.insert({
        job_id: input.id,
        owner_id: input.ownerId,
        pull_request: input.pullRequest,
        round: input.round,
        trigger: "new_head",
        status: "imported",
        head_sha: input.headSha,
        base_ref: input.baseRef,
        base_sha: input.baseSha,
        merge_base_sha: "",
        command_id: input.id,
        thread_id: input.threadId,
        run_id: null,
        external_task_id: input.externalTaskId,
        brief: null,
        launch_attempts: 0,
        created_at: input.createdAt,
        launched_at: null,
        deadline_at: null,
        completed_at: input.createdAt,
        result_json: null,
        result_sha256: null,
        verdict: input.verdict,
        error: null,
      })}
      ON CONFLICT DO NOTHING
    `.pipe(Effect.asVoid, Effect.mapError(fail("insert-imported-job")));

  return RepoReviewStore.of({
    transaction,
    insertOwner,
    getOwner,
    findOwnerForRepository,
    listOwners,
    setOwnerStatus,
    recordPoll,
    requestPoll,
    listPullRequests,
    upsertPullRequest,
    markReviewed,
    setBlocker,
    handledEventKeys,
    insertReceipts,
    insertJob,
    getJob,
    getJobByThread,
    listJobs,
    claimLaunch,
    recordLaunchAttempt,
    markRunning,
    acceptResult,
    transitionJob,
    listFindings,
    insertFinding,
    setFindingDisposition,
    attachFindingComment,
    planPublication,
    insertConfirmedPublication,
    listPublications,
    claimPublication,
    settlePublication,
    cancelPublicationsForOwner,
    findImport,
    insertImport,
    insertImportedJob,
  });
});

export const layer = Layer.effect(RepoReviewStore, make);
