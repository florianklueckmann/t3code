import {
  CommandId,
  type OrchestrationV2RunStatus,
  type RepoReviewControlInput,
  RepoReviewFailure,
  type RepoReviewImportInput,
  type RepoReviewImportResult,
  type RepoReviewJobResult,
  type RepoReviewJobTrigger,
  type RepoReviewOwner,
  RepoReviewOwnerId,
  type RepoReviewOwnerView,
  type RepoReviewPolicy,
  type RepoReviewPolicyInput,
  RepoReviewJobId,
  type RepoReviewStartInput,
  type RepoReviewStatusInput,
  type RepoReviewStatusResult,
  type RepoReviewSubmitResultOutput,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import {
  applyResult,
  effectiveApproval,
  assessLanding,
  type CanonicalFinding,
  type EventContext,
  isActiveJobStatus,
  type JobPins,
  materialEvents,
  type PullRequestObservation,
  publicationMarker,
  reconcilePullRequest,
  validateResult,
} from "./decisions.ts";
import { planLedgerImport } from "./ledgerImport.ts";
import * as RepoReviewGitHub from "./RepoReviewGitHub.ts";
import * as RepoReviewStore from "./RepoReviewStore.ts";
import { buildReviewBrief, MAX_BRIEF_EVENTS } from "./reviewBrief.ts";

/** Launch attempts before a job that cannot start is failed instead of retried forever. */
const MAX_LAUNCH_ATTEMPTS = 5;
/**
 * How long an ambiguous write must stay unconfirmed before it may be attempted again. GitHub
 * answers or abandons a request within seconds, so absence after this long means it never landed.
 */
const UNCERTAIN_GRACE_MS = 10 * 60_000;
/** Attempts per publication before it fails and waits for a person. */
const MAX_PUBLICATION_ATTEMPTS = 3;
const TERMINAL_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const DEFAULT_POLICY: Omit<RepoReviewPolicy, "modelSelection"> = {
  postFindings: true,
  approve: false,
  merge: false,
  mergeMethod: "merge",
  reviewDrafts: true,
  runtimeMode: "full-access",
  maxConcurrentJobs: 2,
  pollIntervalSeconds: 300,
  jobTimeoutMinutes: 180,
  commentPrefix: "",
  instructions: "",
};

const failure = (code: RepoReviewFailure["code"], message: string) =>
  new RepoReviewFailure({ code, message });

const storageFailure = (error: RepoReviewStore.RepoReviewStoreError) =>
  failure("storage_error", error.message);

const decodeLedgerJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Stable JSON so the same result always hashes the same, whatever key order a model used. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const ids = {
  job: (ownerId: string, pullRequest: number, round: number) =>
    `${ownerId}:pr-${pullRequest}:r${round}`,
  command: (jobId: string) => CommandId.make(`repo-review-job:${jobId}`),
  // Bound before the launch so a result submitted the moment the agent starts finds its job.
  thread: (jobId: string) => ThreadId.make(`thread:repo-review:${jobId}`),
  branch: (ownerId: string, pullRequest: number, round: number) =>
    `t3-review/${ownerId.slice(-8)}-pr-${pullRequest}-r${round}`,
};

const resolvePolicy = (
  base: Omit<RepoReviewPolicy, "modelSelection">,
  input: RepoReviewPolicyInput | undefined,
): RepoReviewPolicy | null => {
  if (input?.modelSelection === undefined) return null;
  const overrides = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<RepoReviewPolicy>;
  return { ...base, ...overrides, modelSelection: input.modelSelection };
};

export class RepoReviewController extends Context.Service<
  RepoReviewController,
  {
    readonly status: (
      input: RepoReviewStatusInput,
    ) => Effect.Effect<RepoReviewStatusResult, RepoReviewFailure>;
    readonly start: (
      input: RepoReviewStartInput,
    ) => Effect.Effect<RepoReviewOwner, RepoReviewFailure>;
    /** `callerThreadId` is set for agent callers; review job threads may not steer owners. */
    readonly control: (
      input: RepoReviewControlInput,
      callerThreadId: ThreadId | undefined,
    ) => Effect.Effect<RepoReviewOwner, RepoReviewFailure>;
    readonly importLedger: (
      input: RepoReviewImportInput,
    ) => Effect.Effect<RepoReviewImportResult, RepoReviewFailure>;
    /** Accepts a review job's result. Only the job's own thread may submit it. */
    readonly submitResult: (
      callerThreadId: ThreadId,
      result: RepoReviewJobResult,
    ) => Effect.Effect<RepoReviewSubmitResultOutput, RepoReviewFailure>;
    /** Refuses agents running inside a review job thread. */
    readonly assertNotReviewJob: (
      callerThreadId: ThreadId | undefined,
    ) => Effect.Effect<void, RepoReviewFailure>;
    /** One deterministic pass over every owner. The scheduler runs it; tests call it directly. */
    readonly runDueWork: Effect.Effect<void>;
  }
>()("t3/repoReview/RepoReviewController") {}

const make = Effect.gen(function* () {
  const store = yield* RepoReviewStore.RepoReviewStore;
  const github = yield* RepoReviewGitHub.RepoReviewGitHub;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentity = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const scheduler = yield* Scheduler.Scheduler;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const isoAfter = (iso: string, millis: number) =>
    DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(iso), { milliseconds: millis }));
  const millisBetween = (from: string, to: string) =>
    DateTime.toEpochMillis(DateTime.makeUnsafe(to)) -
    DateTime.toEpochMillis(DateTime.makeUnsafe(from));
  const sha256 = (text: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(() => failure("storage_error", "Could not hash the result.")),
    );

  const target = (owner: RepoReviewStore.OwnerRecord) => ({
    host: owner.host,
    repository: owner.repository,
  });

  const eventContext = (
    owner: RepoReviewStore.OwnerRecord,
    handledKeys: ReadonlySet<string>,
  ): EventContext => ({
    handledKeys,
    account: owner.account,
    commentPrefix: owner.policy.commentPrefix,
    baselineAt: owner.eventsBaselineAt,
  });

  const jobPins = (
    owner: RepoReviewStore.OwnerRecord,
    job: RepoReviewStore.JobRecord,
  ): JobPins => ({
    id: job.id,
    repository: owner.repository,
    pullRequest: job.pullRequest,
    headSha: job.headSha,
    baseRef: job.baseRef,
    baseSha: job.baseSha,
    mergeBaseSha: job.mergeBaseSha,
  });

  const interruptJobThread = (
    owner: RepoReviewStore.OwnerRecord,
    job: RepoReviewStore.JobRecord,
    reason: string,
  ) =>
    job.threadId === null || job.launchedAt === null
      ? Effect.void
      : threads
          .interruptThread({
            projectId: owner.projectId,
            commandId: CommandId.make(`repo-review-interrupt:${job.id}`),
            threadId: job.threadId,
            reason,
          })
          .pipe(
            Effect.asVoid,
            Effect.catch((cause) =>
              Effect.logWarning("Could not interrupt repository review job", {
                jobId: job.id,
                cause,
              }),
            ),
          );

  const pauseForSafety = (owner: RepoReviewStore.OwnerRecord, reason: string) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* store.setOwnerStatus({
        id: owner.id,
        status: "paused",
        reason,
        pauseRequestedAt: now,
        now,
        from: ["active", "pausing"],
      });
      yield* Effect.logWarning("Repository review owner paused", { ownerId: owner.id, reason });
    });

  /** Every write first proves it would go out under the owner's posting account. */
  const postingAccountMatches = (owner: RepoReviewStore.OwnerRecord) =>
    Effect.gen(function* () {
      const viewer = yield* github.getViewerLogin(owner.host);
      if (viewer.toLowerCase() === owner.account.toLowerCase()) return true;
      yield* pauseForSafety(owner, `GitHub credential is ${viewer}, not ${owner.account}.`);
      return false;
    });

  // -------------------------------------------------------------------------
  // Polling: GitHub → durable state. No model is involved.
  // -------------------------------------------------------------------------

  const observe = (owner: RepoReviewStore.OwnerRecord, number: number) =>
    Effect.gen(function* () {
      const detail = yield* github.getPullRequest({ ...target(owner), number });
      if (detail.state !== "open") {
        return {
          detail,
          baseSha: detail.githubBaseSha,
          mergeBaseSha: "",
          events: [],
        } satisfies PullRequestObservation;
      }
      // The base tip is read from the branch itself: the pull request's copy can lag.
      const baseSha = yield* github.getBranchSha({ ...target(owner), branch: detail.baseRef });
      const [mergeBaseSha, events] = yield* Effect.all(
        [
          github.getMergeBase({ ...target(owner), base: baseSha, head: detail.headSha }),
          github.listConversation({ ...target(owner), number }),
        ],
        { concurrency: 2 },
      );
      return { detail, baseSha, mergeBaseSha, events } satisfies PullRequestObservation;
    });

  const pollOwner = (owner: RepoReviewStore.OwnerRecord) =>
    Effect.gen(function* () {
      const startedAt = yield* nowIso;
      const nextPollAt = isoAfter(startedAt, owner.policy.pollIntervalSeconds * 1000);
      const viewer = yield* github.getViewerLogin(owner.host);
      if (viewer.toLowerCase() !== owner.account.toLowerCase()) {
        return yield* pauseForSafety(
          owner,
          `GitHub credential is ${viewer}, not ${owner.account}.`,
        );
      }
      const repo = yield* github.getRepository(target(owner));
      if (
        repo.fullName.toLowerCase() !== owner.repository.toLowerCase() ||
        (owner.githubRepositoryId !== null && repo.id !== owner.githubRepositoryId)
      ) {
        return yield* pauseForSafety(owner, `Repository identity changed to ${repo.fullName}.`);
      }
      if (repo.archived) return yield* pauseForSafety(owner, "Repository is archived.");
      const canWrite = ["admin", "maintain", "write"].includes(repo.viewerPermission);
      if ((owner.policy.merge || owner.policy.approve) && !canWrite) {
        return yield* pauseForSafety(owner, `Write access was revoked (${repo.viewerPermission}).`);
      }
      if (repo.viewerPermission === "none") {
        return yield* pauseForSafety(owner, "Read access was revoked.");
      }

      const open = yield* github.listOpenPullRequests(target(owner));
      const stored = yield* store.listPullRequests(owner.id);
      const storedByNumber = new Map(stored.map((pr) => [pr.number, pr]));
      const openNumbers = new Set(open.map((pr) => pr.number));
      const candidates = [
        ...open
          .filter((item) => {
            const known = storedByNumber.get(item.number);
            return (
              known === undefined ||
              known.needsObservation ||
              known.state !== "open" ||
              known.githubUpdatedAt !== item.updatedAt ||
              known.headSha !== item.headSha
            );
          })
          .map((item) => item.number),
        ...stored
          .filter((pr) => pr.state === "open" && !openNumbers.has(pr.number))
          .map((pr) => pr.number),
      ];

      // Each pull request is read in full or not at all; one failing read does not hold the rest.
      const observations: PullRequestObservation[] = [];
      const readFailures: number[] = [];
      for (const number of candidates) {
        const observed = yield* Effect.result(observe(owner, number));
        if (observed._tag === "Success") observations.push(observed.success);
        else readFailures.push(number);
      }

      const handled = yield* store.handledEventKeys(owner.id);
      const jobs = yield* store.listJobs({ ownerId: owner.id });
      const cancelled: RepoReviewStore.JobRecord[] = [];
      const now = yield* nowIso;
      yield* store.transaction(
        Effect.gen(function* () {
          for (const observation of observations) {
            const number = observation.detail.number;
            const prJobs = jobs.filter(
              (job) => job.pullRequest === number && job.status !== "imported",
            );
            const active = prJobs.find((job) => isActiveJobStatus(job.status)) ?? null;
            const decision = reconcilePullRequest({
              stored: storedByNumber.get(number) ?? null,
              observation,
              events: eventContext(owner, handled),
              policy: owner.policy,
              activeJob: active,
              latestJob: prJobs[0] ?? null,
            });
            yield* store.upsertPullRequest(owner.id, decision.pullRequest, now);
            yield* store.insertReceipts({
              ownerId: owner.id,
              pullRequest: number,
              jobId: null,
              receipts: decision.receipts,
              now,
            });
            if (decision.cancelJob !== null) {
              const cancelledNow = yield* store.transitionJob({
                jobId: decision.cancelJob.id,
                from: ["queued", "launching", "running", "result_received"],
                to: "cancelled",
                error: decision.cancelJob.reason,
                now,
              });
              const job = prJobs.find((candidate) => candidate.id === decision.cancelJob!.id);
              if (cancelledNow && job !== undefined) cancelled.push(job);
            }
            if (decision.enqueue !== null) {
              yield* enqueueJob(owner, decision.pullRequest, decision.enqueue, now);
            }
          }
          yield* store.recordPoll({
            id: owner.id,
            now,
            nextPollAt,
            error:
              readFailures.length === 0
                ? null
                : `Could not read pull request(s) ${readFailures.join(", ")}.`,
            githubRepositoryId: repo.id,
          });
        }),
      );
      yield* Effect.forEach(cancelled, (job) => interruptJobThread(owner, job, "Superseded."), {
        discard: true,
      });
    }).pipe(
      Effect.catchTags({
        RepoReviewGitHubError: (error) =>
          // Fail closed: no state changes, try again at the next interval.
          Effect.gen(function* () {
            const now = yield* nowIso;
            yield* store.recordPoll({
              id: owner.id,
              now,
              nextPollAt: isoAfter(now, owner.policy.pollIntervalSeconds * 1000),
              error: error.message,
            });
          }),
      }),
    );

  const enqueueJob = (
    owner: RepoReviewStore.OwnerRecord,
    pr: {
      readonly number: number;
      readonly round: number;
      readonly headSha: string;
      readonly baseRef: string;
      readonly baseSha: string;
      readonly mergeBaseSha: string;
    },
    trigger: RepoReviewJobTrigger,
    now: string,
  ) => {
    const round = pr.round + 1;
    const id = ids.job(owner.id, pr.number, round);
    return store.insertJob(
      {
        id,
        ownerId: owner.id,
        pullRequest: pr.number,
        round,
        trigger,
        headSha: pr.headSha,
        baseRef: pr.baseRef,
        baseSha: pr.baseSha,
        mergeBaseSha: pr.mergeBaseSha,
        commandId: ids.command(id),
        threadId: ids.thread(id),
      },
      now,
    );
  };

  // -------------------------------------------------------------------------
  // Jobs: launch with a durable intent, then watch the run.
  // -------------------------------------------------------------------------

  const buildBrief = (owner: RepoReviewStore.OwnerRecord, job: RepoReviewStore.JobRecord) =>
    Effect.gen(function* () {
      const detail = yield* github.getPullRequest({ ...target(owner), number: job.pullRequest });
      const events = yield* github.listConversation({ ...target(owner), number: job.pullRequest });
      const handled = yield* store.handledEventKeys(owner.id);
      const findings = yield* store.listFindings({
        ownerId: owner.id,
        pullRequest: job.pullRequest,
      });
      const history = yield* store.listJobs({ ownerId: owner.id, pullRequest: job.pullRequest });
      const previous = history.find(
        (candidate) =>
          candidate.id !== job.id &&
          (candidate.status === "completed" || candidate.status === "imported"),
      );
      // Oldest first, and only as many as the brief shows: those are the ones it receipts.
      // A requeue is how a person asks for activity inherited from an import to be reviewed.
      const authorEvents = materialEvents(events, eventContext(owner, handled), {
        includeInherited: job.trigger === "requeue",
      })
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, MAX_BRIEF_EVENTS);
      const brief = buildReviewBrief({
        job: { ...jobPins(owner, job), round: job.round, trigger: job.trigger },
        host: owner.host,
        pullRequestUrl: detail.url,
        title: detail.title,
        body: detail.body,
        instructions: owner.policy.instructions,
        findings,
        authorEvents,
        previous:
          previous === undefined
            ? null
            : { headSha: previous.headSha, baseSha: previous.baseSha, result: previous.result },
      });
      return { detail, brief, authorEvents };
    });

  const launch = (
    owner: RepoReviewStore.OwnerRecord,
    job: RepoReviewStore.JobRecord,
    headRef: string | null,
  ) =>
    Effect.gen(function* () {
      const threadId = job.threadId ?? ids.thread(job.id);
      const launched = yield* Effect.exit(
        threadLaunch.launch({
          commandId: CommandId.make(job.commandId),
          threadId,
          projectId: owner.projectId,
          title: `Review #${job.pullRequest} r${job.round} · ${job.headSha.slice(0, 7)}`,
          modelSelection: owner.policy.modelSelection,
          runtimeMode: owner.policy.runtimeMode,
          interactionMode: "default",
          // Same-repository heads start the worktree at the head branch; forks start at the base
          // and the brief has the job fetch the pull request ref. Either way it pins the SHA.
          workspaceStrategy: {
            type: "worktree",
            baseRef: headRef ?? job.baseRef,
            branch: ids.branch(owner.id, job.pullRequest, job.round),
            startFromOrigin: true,
          },
          initialMessage: { text: job.brief ?? "", attachments: [] },
          createdBy: "system",
          creationSource: "server",
        }),
      );
      if (launched._tag === "Success") {
        // The controller creates the thread, so the brief's run is its first. A replayed launch
        // must not adopt a run someone started later in the same thread.
        const run = launched.value.projection.runs[0];
        yield* store.markRunning({ jobId: job.id, runId: run?.id ?? null });
        return;
      }
      const attempts = yield* store.recordLaunchAttempt({
        jobId: job.id,
        error: "Thread launch failed.",
      });
      yield* Effect.logWarning("Repository review launch failed", {
        jobId: job.id,
        attempts,
        cause: launched.cause,
      });
      if (attempts >= MAX_LAUNCH_ATTEMPTS) {
        const now = yield* nowIso;
        yield* store.transitionJob({
          jobId: job.id,
          from: ["launching"],
          to: "failed",
          error: `Thread launch failed ${attempts} times.`,
          now,
        });
      }
    });

  const startQueuedJob = (owner: RepoReviewStore.OwnerRecord, job: RepoReviewStore.JobRecord) =>
    Effect.gen(function* () {
      const built = yield* Effect.result(buildBrief(owner, job));
      if (built._tag === "Failure") return; // GitHub unreadable: stay queued, fail closed.
      const { detail, brief, authorEvents } = built.success;
      const now = yield* nowIso;
      if (
        detail.state !== "open" ||
        detail.headSha !== job.headSha ||
        detail.baseRef !== job.baseRef
      ) {
        yield* store.transitionJob({
          jobId: job.id,
          from: ["queued"],
          to: "cancelled",
          error: "The pull request changed before the review started.",
          now,
        });
        return;
      }
      const claimed = yield* store.transaction(
        Effect.gen(function* () {
          const ok = yield* store.claimLaunch({
            jobId: job.id,
            brief,
            now,
            deadlineAt: isoAfter(now, owner.policy.jobTimeoutMinutes * 60_000),
          });
          if (ok) {
            yield* store.insertReceipts({
              ownerId: owner.id,
              pullRequest: job.pullRequest,
              jobId: job.id,
              receipts: authorEvents.map((event) => ({
                key: event.keys[0]!,
                kind: event.kind,
                disposition: "included",
              })),
              now,
            });
          }
          return ok;
        }),
      );
      if (!claimed) return;
      const launching = yield* store.getJob(job.id);
      if (launching === null) return;
      const sameRepository =
        detail.headRepository?.toLowerCase() === owner.repository.toLowerCase();
      yield* launch(owner, launching, sameRepository ? detail.headRef : null);
    });

  const checkRunningJob = (owner: RepoReviewStore.OwnerRecord, job: RepoReviewStore.JobRecord) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const threadId = job.threadId;
      if (threadId === null) return;
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (shell === undefined) return; // Unreadable right now; look again next tick.
      const failJob = (error: string) =>
        store.transitionJob({ jobId: job.id, from: ["running"], to: "failed", error, now });
      if (shell === null || shell.deletedAt !== null) {
        yield* failJob("The review thread was deleted before it submitted a result.");
        return;
      }
      const records = yield* threads
        .getThreadRecords(threadId, ["runs"])
        .pipe(Effect.orElseSucceed(() => null));
      const run =
        records?.runs.find((candidate) => candidate.id === job.runId) ?? records?.runs[0] ?? null;
      if (run !== null && TERMINAL_RUN_STATUSES.has(run.status)) {
        yield* failJob(`The review run ended (${run.status}) without submitting a result.`);
        return;
      }
      if (job.deadlineAt !== null && now > job.deadlineAt) {
        if (yield* failJob("The review timed out.")) {
          yield* interruptJobThread(owner, job, "Repository review timed out.");
        }
      }
    });

  const advanceJobs = (owner: RepoReviewStore.OwnerRecord) =>
    Effect.gen(function* () {
      const jobs = yield* store.listJobs({
        ownerId: owner.id,
        statuses: ["queued", "launching", "running"],
      });
      for (const job of jobs.filter((candidate) => candidate.status === "running")) {
        yield* checkRunningJob(owner, job);
      }
      if (owner.status === "paused") return;
      // A recorded launch intent is completed even while pausing: it belongs to the admitted round.
      for (const job of jobs.filter((candidate) => candidate.status === "launching")) {
        const detail = yield* Effect.result(
          github.getPullRequest({ ...target(owner), number: job.pullRequest }),
        );
        const headRef =
          detail._tag === "Success" &&
          detail.success.headRepository?.toLowerCase() === owner.repository.toLowerCase()
            ? detail.success.headRef
            : null;
        yield* launch(owner, job, headRef);
      }
      if (owner.status !== "active") return;
      const busy = jobs.filter(
        (job) => job.status === "launching" || job.status === "running",
      ).length;
      const queued = jobs
        .filter((job) => job.status === "queued")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const job of queued.slice(0, Math.max(0, owner.policy.maxConcurrentJobs - busy))) {
        yield* startQueuedJob(owner, job);
      }
    });

  // -------------------------------------------------------------------------
  // Results: validated on submission, applied against a fresh read of GitHub.
  // -------------------------------------------------------------------------

  const submitResult: RepoReviewController["Service"]["submitResult"] = (callerThreadId, result) =>
    Effect.gen(function* () {
      const job = yield* store.getJobByThread(callerThreadId).pipe(Effect.mapError(storageFailure));
      if (job === null) {
        return yield* failure("not_found", "This thread is not a repository review job.");
      }
      const reply = (
        duplicate: boolean,
        jobStatus: RepoReviewStore.JobRecord["status"],
        message: string,
      ) =>
        ({
          jobId: RepoReviewJobId.make(job.id),
          duplicate,
          jobStatus,
          message,
        }) satisfies RepoReviewSubmitResultOutput;
      const resultSha256 = yield* sha256(canonicalJson(result));
      if (job.resultSha256 !== null) {
        if (job.resultSha256 === resultSha256) {
          return reply(true, job.status, "This result was already accepted.");
        }
        return yield* failure("conflict", "A different result was already accepted for this job.");
      }
      // `launching` too: the agent can start before the launch acknowledgement is recorded.
      if (job.status !== "running" && job.status !== "launching") {
        return yield* failure(
          "conflict",
          `This job is ${job.status} and no longer accepts results.`,
        );
      }
      const owner = yield* store.getOwner(job.ownerId).pipe(Effect.mapError(storageFailure));
      if (owner === null || owner.status === "stopped") {
        return yield* failure("conflict", "The repository review owner is stopped.");
      }
      // A later message in this thread starts another run; only the job's own run may answer.
      const records = yield* threads
        .getThreadRecords(callerThreadId, ["runs"])
        .pipe(Effect.mapError(() => failure("storage_error", "Could not read the review thread.")));
      const jobRunId = job.runId ?? records.runs[0]?.id;
      const latest = records.runs.at(-1);
      if (jobRunId === undefined || latest === undefined || latest.id !== jobRunId) {
        return yield* failure("conflict", "Only the review job's own run can submit its result.");
      }
      const findings = yield* store
        .listFindings({ ownerId: owner.id, pullRequest: job.pullRequest })
        .pipe(Effect.mapError(storageFailure));
      const problems = validateResult(result, jobPins(owner, job), findings);
      if (problems.length > 0) {
        return yield* failure("invalid_result", `Result rejected:\n- ${problems.join("\n- ")}`);
      }
      const accepted = yield* store
        .acceptResult({ jobId: job.id, result, resultSha256 })
        .pipe(Effect.mapError(storageFailure));
      if (!accepted) {
        const current = yield* store.getJob(job.id).pipe(Effect.mapError(storageFailure));
        if (current?.resultSha256 === resultSha256) {
          return reply(true, current.status, "This result was already accepted.");
        }
        return yield* failure("conflict", "The job changed while the result was submitted.");
      }
      return reply(
        false,
        "result_received",
        "Result accepted. The controller publishes from it; end your turn.",
      );
    });

  const processResult = (owner: RepoReviewStore.OwnerRecord, job: RepoReviewStore.JobRecord) =>
    Effect.gen(function* () {
      if (job.result === null) return;
      const current = yield* Effect.result(
        github.getPullRequest({ ...target(owner), number: job.pullRequest }),
      );
      if (current._tag === "Failure") return; // Apply once GitHub can confirm the head.
      const findings = yield* store.listFindings({
        ownerId: owner.id,
        pullRequest: job.pullRequest,
      });
      const application = applyResult({
        ownerId: owner.id,
        job: jobPins(owner, job),
        result: job.result,
        current: current.success,
        findings,
        policy: owner.policy,
        commentPrefix: owner.policy.commentPrefix,
      });
      const now = yield* nowIso;
      yield* store.transaction(
        Effect.gen(function* () {
          const moved = yield* store.transitionJob({
            jobId: job.id,
            from: ["result_received"],
            to: application.jobStatus,
            error: application.error,
            now,
          });
          if (!moved) return;
          // This round decides the pull request's landing; earlier rounds' intents end here.
          yield* store.cancelPublicationsForOwner({
            ownerId: owner.id,
            statuses: ["planned", "blocked"],
            detail: `Superseded by review round ${job.round}.`,
            now,
            supersededLandings: { pullRequest: job.pullRequest, jobId: job.id },
          });
          for (const finding of application.newFindings) {
            yield* store.insertFinding({
              ownerId: owner.id,
              finding,
              source: "review",
              reportedJobId: job.id,
              reportedHeadSha: job.headSha,
              now,
            });
          }
          for (const change of application.dispositionChanges) {
            yield* store.setFindingDisposition({
              ownerId: owner.id,
              findingId: change.id,
              disposition: change.disposition,
              jobId: job.id,
              headSha: job.headSha,
              now,
            });
          }
          for (const publication of application.publications) {
            yield* store.planPublication({
              id: publication.id,
              ownerId: owner.id,
              pullRequest: job.pullRequest,
              kind: publication.kind,
              jobId: job.id,
              findingId: publication.findingId,
              expectedHeadSha: job.headSha,
              expectedBaseSha: job.baseSha,
              payload: publication.payload,
              now,
            });
          }
          if (application.reviewedHead) {
            yield* store.markReviewed({
              ownerId: owner.id,
              number: job.pullRequest,
              headSha: job.headSha,
              baseSha: job.baseSha,
              now,
            });
          }
        }),
      );
    });

  // -------------------------------------------------------------------------
  // Publication: the only GitHub writer.
  // -------------------------------------------------------------------------

  const findOwnWrite = (
    owner: RepoReviewStore.OwnerRecord,
    publication: RepoReviewStore.PublicationRecord,
  ) =>
    Effect.gen(function* () {
      const events = yield* github.listConversation({
        ...target(owner),
        number: publication.pullRequest,
      });
      const viewer = owner.account.toLowerCase();
      const marker = publicationMarker(publication.id);
      return (
        events.find(
          (event) => event.authorLogin.toLowerCase() === viewer && event.body.includes(marker),
        ) ??
        (publication.kind === "approval"
          ? effectiveApproval(events, owner.account, publication.expectedHeadSha)
          : null)
      );
    });

  const confirm = (
    owner: RepoReviewStore.OwnerRecord,
    publication: RepoReviewStore.PublicationRecord,
    written: { readonly githubId: string; readonly url: string },
    detail: string | null,
  ) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* store.transaction(
        Effect.gen(function* () {
          yield* store.settlePublication({
            id: publication.id,
            from: ["attempting", "uncertain", "planned", "blocked"],
            to: "confirmed",
            githubId: written.githubId,
            url: written.url,
            detail,
            now,
          });
          if (publication.findingId !== null) {
            yield* store.attachFindingComment({
              ownerId: owner.id,
              findingId: publication.findingId,
              githubCommentId: written.githubId,
              url: written.url,
              now,
            });
          }
          // Our own write is not an author event.
          yield* store.insertReceipts({
            ownerId: owner.id,
            pullRequest: publication.pullRequest,
            jobId: publication.jobId,
            receipts: [
              { key: `gh:${written.githubId}`, kind: publication.kind, disposition: "own" },
            ],
            now,
          });
        }),
      );
    });

  const settle = (
    publication: RepoReviewStore.PublicationRecord,
    to: "cancelled" | "blocked" | "failed" | "planned" | "uncertain",
    detail: string,
    from: ReadonlyArray<RepoReviewStore.PublicationRecord["status"]> = ["attempting"],
  ) =>
    nowIso.pipe(
      Effect.flatMap((now) =>
        store.settlePublication({ id: publication.id, from, to, detail, now }),
      ),
    );

  /** An ambiguous write is only ever resolved by reading GitHub back. */
  const reconcileUncertain = (
    owner: RepoReviewStore.OwnerRecord,
    publication: RepoReviewStore.PublicationRecord,
  ) =>
    Effect.gen(function* () {
      if (publication.kind === "merge") {
        const detail = yield* github.getPullRequest({
          ...target(owner),
          number: publication.pullRequest,
        });
        if (detail.state === "merged") {
          if (
            detail.headSha === publication.expectedHeadSha &&
            detail.mergedBy?.toLowerCase() === owner.account.toLowerCase()
          ) {
            return yield* confirm(
              owner,
              publication,
              { githubId: detail.mergeCommitSha ?? "", url: detail.url },
              "Confirmed by read-back.",
            );
          }
          return yield* settle(publication, "cancelled", "Merged outside the controller.", [
            "uncertain",
          ]);
        }
        if (detail.state === "closed")
          return yield* settle(publication, "cancelled", "Pull request closed.", ["uncertain"]);
      } else {
        const found = yield* findOwnWrite(owner, publication);
        if (found !== null) {
          return yield* confirm(
            owner,
            publication,
            { githubId: found.githubId, url: found.url },
            "Confirmed by read-back.",
          );
        }
      }
      const now = yield* nowIso;
      if (
        publication.attemptedAt !== null &&
        millisBetween(publication.attemptedAt, now) < UNCERTAIN_GRACE_MS
      ) {
        return;
      }
      yield* publication.attempts >= MAX_PUBLICATION_ATTEMPTS
        ? settle(
            publication,
            "failed",
            "Write outcome stayed unconfirmed; check GitHub and requeue.",
            ["uncertain"],
          )
        : settle(publication, "planned", "Not found on GitHub after the grace period; retrying.", [
            "uncertain",
          ]);
    });

  const writeFinding = (
    owner: RepoReviewStore.OwnerRecord,
    publication: RepoReviewStore.PublicationRecord,
  ) =>
    Effect.gen(function* () {
      if (publication.payload.kind !== "finding_comment") return;
      const payload = publication.payload;
      // A later review may have fixed or withdrawn the finding while this report waited.
      const finding = (yield* store.listFindings({
        ownerId: owner.id,
        pullRequest: publication.pullRequest,
      })).find((candidate) => candidate.id === publication.findingId);
      if (finding === undefined || finding.disposition !== "open") {
        return yield* settle(publication, "cancelled", "The finding is no longer open.", [
          "planned",
          "blocked",
        ]);
      }
      if (!(yield* postingAccountMatches(owner))) return;
      const detail = yield* github.getPullRequest({
        ...target(owner),
        number: publication.pullRequest,
      });
      if (detail.state !== "open")
        return yield* settle(publication, "cancelled", `Pull request ${detail.state}.`, [
          "planned",
          "blocked",
        ]);
      if (detail.headSha !== publication.expectedHeadSha) {
        return yield* settle(
          publication,
          "cancelled",
          "Head changed; the next review re-adjudicates it.",
          ["planned", "blocked"],
        );
      }
      const existing = yield* findOwnWrite(owner, publication);
      if (existing !== null) {
        return yield* confirm(
          owner,
          publication,
          { githubId: existing.githubId, url: existing.url },
          "Already on GitHub.",
        );
      }
      const now = yield* nowIso;
      if (!(yield* store.claimPublication({ id: publication.id, gate: writeGate(owner), now })))
        return;
      const inline = yield* Effect.result(
        github.createReviewComment({
          ...target(owner),
          number: publication.pullRequest,
          commitId: publication.expectedHeadSha,
          path: payload.path,
          line: payload.line,
          body: payload.body,
        }),
      );
      if (inline._tag === "Success")
        return yield* confirm(owner, publication, inline.success, null);
      if (inline.failure.outcome !== "rejected")
        return yield* settleWriteError(publication, inline.failure);
      // GitHub rejects inline comments on lines outside the diff; the defect still gets reported.
      const fallback = yield* Effect.result(
        github.createIssueComment({
          ...target(owner),
          number: publication.pullRequest,
          body: `${payload.body}\n\n(${payload.path}:${payload.line} at ${publication.expectedHeadSha})`,
        }),
      );
      if (fallback._tag === "Success")
        return yield* confirm(
          owner,
          publication,
          fallback.success,
          "Posted as a conversation comment.",
        );
      return yield* settleWriteError(publication, fallback.failure);
    });

  const settleWriteError = (
    publication: RepoReviewStore.PublicationRecord,
    error: RepoReviewGitHub.RepoReviewGitHubError,
  ) => {
    switch (error.outcome) {
      case "unavailable":
        return settle(
          publication,
          "uncertain",
          "No definite answer from GitHub; confirming by read-back.",
        );
      case "rate_limited":
      case "unauthorized":
        // Refused before anything was written.
        return settle(publication, "planned", error.message);
      case "not_found":
      case "rejected":
        return settle(
          publication,
          publication.kind === "merge" ? "blocked" : "failed",
          error.message,
        );
    }
  };

  const writeLanding = (
    owner: RepoReviewStore.OwnerRecord,
    publication: RepoReviewStore.PublicationRecord,
    pending: ReadonlyArray<RepoReviewStore.PublicationRecord>,
  ) =>
    Effect.gen(function* () {
      const kind = publication.kind === "merge" ? "merge" : "approval";
      // Only the newest finished round may land. A round in flight (an author reply, an
      // integration review) holds the write; a newer finished round supersedes it.
      const prJobs = yield* store.listJobs({
        ownerId: owner.id,
        pullRequest: publication.pullRequest,
      });
      if (prJobs.some((candidate) => isActiveJobStatus(candidate.status))) return;
      const latest = prJobs.find((candidate) => candidate.status !== "imported");
      if (latest === undefined || latest.id !== publication.jobId) {
        return yield* settle(
          publication,
          "cancelled",
          `Superseded by review round ${latest?.round ?? "?"}.`,
          ["planned", "blocked"],
        );
      }
      if (kind === "merge" && owner.policy.approve) {
        const approval = pending.find(
          (candidate) =>
            candidate.kind === "approval" &&
            candidate.pullRequest === publication.pullRequest &&
            candidate.expectedHeadSha === publication.expectedHeadSha,
        );
        // The approval lands first; a merge never overtakes its own approval.
        if (approval?.status === "failed" || approval?.status === "cancelled") {
          return yield* settle(
            publication,
            "cancelled",
            `The approval did not land (${approval.status}).`,
            ["planned", "blocked"],
          );
        }
        if (approval !== undefined && approval.status !== "confirmed") return;
      }
      if (!(yield* postingAccountMatches(owner))) return;
      const detail = yield* github.getPullRequest({
        ...target(owner),
        number: publication.pullRequest,
      });
      const repo = yield* github.getRepository(target(owner));
      const baseSha =
        detail.state === "open"
          ? yield* github.getBranchSha({ ...target(owner), branch: detail.baseRef })
          : detail.githubBaseSha;
      const events = yield* github.listConversation({
        ...target(owner),
        number: publication.pullRequest,
      });
      // An author event no review has seen (it arrived during the review, or did not fit its
      // brief) holds the landing. The finished job marked the pull request for observation, so
      // the next poll starts the round that reviews it.
      const unseen = materialEvents(
        events,
        eventContext(owner, yield* store.handledEventKeys(owner.id)),
      );
      if (unseen.length > 0) {
        yield* store.requestPoll(owner.id, yield* nowIso);
        return yield* settle(
          publication,
          "blocked",
          `${unseen.length} author event(s) not yet reviewed.`,
          ["planned", "blocked"],
        );
      }
      const threadsOnPr =
        detail.state === "open"
          ? yield* github.listReviewThreads({ ...target(owner), number: publication.pullRequest })
          : [];
      const findings = yield* store.listFindings({
        ownerId: owner.id,
        pullRequest: publication.pullRequest,
      });
      const verdict = assessLanding({
        kind,
        expectedHeadSha: publication.expectedHeadSha,
        expectedBaseRef: latest.baseRef,
        expectedBaseSha: publication.expectedBaseSha,
        policy: owner.policy,
        snapshot: {
          detail,
          baseSha,
          events,
          threads: threadsOnPr,
          allowedMergeMethods: repo.allowedMergeMethods,
          viewerLogin: owner.account,
        },
        ownFindings: findings,
      });
      const from = ["planned", "blocked"] as const;
      switch (verdict.type) {
        case "already_done":
          return yield* confirm(
            owner,
            publication,
            { githubId: verdict.githubId, url: verdict.url },
            "Already on GitHub.",
          );
        case "cancel":
          return yield* settle(publication, "cancelled", verdict.reason, from);
        case "blocked":
          return yield* settle(publication, "blocked", verdict.reason, from);
        case "needs_integration_review": {
          const now = yield* nowIso;
          const stored = (yield* store.listPullRequests(owner.id)).find(
            (pr) => pr.number === publication.pullRequest,
          );
          const active = yield* store.listJobs({
            ownerId: owner.id,
            pullRequest: publication.pullRequest,
            statuses: ["queued", "launching", "running", "result_received"],
          });
          const mergeBaseSha = yield* github.getMergeBase({
            ...target(owner),
            base: baseSha,
            head: detail.headSha,
          });
          yield* store.transaction(
            Effect.gen(function* () {
              yield* store.settlePublication({
                id: publication.id,
                from,
                to: "blocked",
                detail: `${verdict.reason} Integration review queued.`,
                now,
              });
              if (stored !== undefined && active.length === 0 && owner.status === "active") {
                yield* enqueueJob(
                  owner,
                  {
                    ...stored,
                    headSha: detail.headSha,
                    baseRef: detail.baseRef,
                    baseSha,
                    mergeBaseSha,
                  },
                  "integration_change",
                  now,
                );
              }
            }),
          );
          return;
        }
        case "proceed":
          break;
      }
      const now = yield* nowIso;
      if (!(yield* store.claimPublication({ id: publication.id, gate: writeGate(owner), now }))) {
        // Was blocked: move it back to planned first so the claim gate applies uniformly.
        if (publication.status === "blocked") {
          yield* store.settlePublication({
            id: publication.id,
            from: ["blocked"],
            to: "planned",
            detail: null,
            now,
          });
          if (!(yield* store.claimPublication({ id: publication.id, gate: writeGate(owner), now })))
            return;
        } else return;
      }
      if (publication.payload.kind === "approval") {
        const written = yield* Effect.result(
          github.approve({
            ...target(owner),
            number: publication.pullRequest,
            commitId: publication.expectedHeadSha,
            body: publication.payload.body,
          }),
        );
        return yield* written._tag === "Success"
          ? confirm(owner, publication, written.success, null)
          : settleWriteError(publication, written.failure);
      }
      if (publication.payload.kind === "merge") {
        const merged = yield* Effect.result(
          github.merge({
            ...target(owner),
            number: publication.pullRequest,
            sha: publication.expectedHeadSha,
            method: publication.payload.method,
          }),
        );
        return yield* merged._tag === "Success"
          ? confirm(
              owner,
              publication,
              { githubId: merged.success.mergeCommitSha, url: detail.url },
              null,
            )
          : settleWriteError(publication, merged.failure);
      }
    });

  const writeGate = (owner: RepoReviewStore.OwnerRecord): RepoReviewStore.PublicationGate =>
    owner.status === "pausing" ? "active_or_pausing" : "active";

  /**
   * Writes still `attempting` when a pass starts were abandoned: passes never overlap, and each
   * settles its own writes. A crash or a failed settlement leaves them, and whether they landed is
   * unknown, so they are confirmed by read-back, never written again blindly.
   */
  const releaseAbandonedWrites = (ownerId: string, detail: string) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const attempting = yield* store.listPublications({ ownerId, statuses: ["attempting"] });
      for (const publication of attempting) {
        yield* store.settlePublication({
          id: publication.id,
          from: ["attempting"],
          to: "uncertain",
          detail,
          now,
        });
      }
    });

  const publish = (owner: RepoReviewStore.OwnerRecord, includeBlocked: boolean) =>
    Effect.gen(function* () {
      yield* releaseAbandonedWrites(
        owner.id,
        "The write was not settled; confirming by read-back.",
      );
      const all = yield* store.listPublications({
        ownerId: owner.id,
        statuses: ["planned", "uncertain", "blocked", "confirmed"],
      });
      for (const publication of all.filter((candidate) => candidate.status === "uncertain")) {
        yield* reconcileUncertain(owner, publication).pipe(
          Effect.catchTags({ RepoReviewGitHubError: () => Effect.void }),
        );
      }
      if (owner.status !== "active" && owner.status !== "pausing") return;
      const order = { finding_comment: 0, approval: 1, merge: 2 } as const;
      const writable = all
        .filter(
          (candidate) =>
            candidate.status === "planned" || (includeBlocked && candidate.status === "blocked"),
        )
        .sort((a, b) => order[a.kind] - order[b.kind]);
      for (const publication of writable) {
        const allowed =
          publication.kind === "finding_comment"
            ? owner.policy.postFindings
            : publication.kind === "approval"
              ? owner.policy.approve
              : owner.policy.merge;
        if (!allowed) {
          yield* settle(publication, "cancelled", "No longer authorized by the owner's policy.", [
            "planned",
            "blocked",
          ]);
          continue;
        }
        // Read the latest statuses so a merge sees an approval confirmed earlier in this pass.
        const latest = yield* store.listPublications({
          ownerId: owner.id,
          pullRequest: publication.pullRequest,
        });
        yield* (
          publication.kind === "finding_comment"
            ? writeFinding(owner, publication)
            : writeLanding(owner, publication, latest)
        ).pipe(
          Effect.catchTags({
            RepoReviewGitHubError: (error) =>
              Effect.logWarning("Repository review publication deferred", {
                publicationId: publication.id,
                outcome: error.outcome,
              }),
          }),
        );
      }
    });

  const finishPausing = (owner: RepoReviewStore.OwnerRecord) =>
    Effect.gen(function* () {
      if (owner.status !== "pausing") return;
      const unfinished = yield* store.listJobs({
        ownerId: owner.id,
        statuses: ["queued", "launching", "running", "result_received"],
      });
      // Queued reviews were not admitted to this round; landings they hold wait with them.
      const inFlight = unfinished.filter((job) => job.status !== "queued");
      const queuedPullRequests = new Set(
        unfinished.filter((job) => job.status === "queued").map((job) => job.pullRequest),
      );
      const publications = yield* store.listPublications({
        ownerId: owner.id,
        statuses: ["planned", "attempting", "uncertain", "blocked", "failed"],
      });
      // A merge waiting on an approval that cannot land this round does not hold the pause.
      const waitingOnApproval = (merge: RepoReviewStore.PublicationRecord) =>
        merge.kind === "merge" &&
        merge.status === "planned" &&
        publications.some(
          (approval) =>
            approval.kind === "approval" &&
            approval.pullRequest === merge.pullRequest &&
            approval.expectedHeadSha === merge.expectedHeadSha &&
            (approval.status === "blocked" || approval.status === "failed"),
        );
      // An admitted write whose outcome is still unknown is part of the round until it settles.
      const pending = publications.filter(
        (publication) =>
          (publication.status === "planned" ||
            publication.status === "attempting" ||
            publication.status === "uncertain") &&
          !waitingOnApproval(publication) &&
          !(
            publication.kind !== "finding_comment" &&
            queuedPullRequests.has(publication.pullRequest)
          ),
      );
      if (inFlight.length > 0 || pending.length > 0) return;
      const now = yield* nowIso;
      yield* store.setOwnerStatus({
        id: owner.id,
        status: "paused",
        reason: "Paused after the admitted review round finished.",
        pauseRequestedAt: owner.pauseRequestedAt,
        now,
        from: ["pausing"],
      });
    });

  const runOwner = (owner: RepoReviewStore.OwnerRecord) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const pollDue =
        owner.status === "active" && (owner.nextPollAt === null || owner.nextPollAt <= now);
      if (pollDue) yield* pollOwner(owner);
      // Re-read: the poll may have paused the owner for safety.
      const current = (yield* store.getOwner(owner.id)) ?? owner;
      yield* advanceJobs(current);
      const received = yield* store.listJobs({ ownerId: owner.id, statuses: ["result_received"] });
      for (const job of received) yield* processResult(current, job);
      yield* publish(current, pollDue);
      yield* finishPausing((yield* store.getOwner(owner.id)) ?? current);
    });

  const runDueWork: RepoReviewController["Service"]["runDueWork"] = Effect.gen(function* () {
    const owners = yield* store.listOwners({ includeStopped: false });
    for (const owner of owners) {
      yield* runOwner(owner).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Repository review owner pass failed", { ownerId: owner.id, cause }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Repository review pass failed", { cause })),
  );

  // -------------------------------------------------------------------------
  // Control surface.
  // -------------------------------------------------------------------------

  const toOwnerView = (owner: RepoReviewStore.OwnerRecord): RepoReviewOwner => ({
    id: RepoReviewOwnerId.make(owner.id),
    host: owner.host,
    repository: owner.repository,
    projectId: owner.projectId,
    account: owner.account,
    status: owner.status,
    statusReason: owner.statusReason,
    statusChangedAt: owner.statusChangedAt,
    pauseRequestedAt: owner.pauseRequestedAt,
    policy: owner.policy,
    lastPollAt: owner.lastPollAt,
    lastPollError: owner.lastPollError,
    importSource: owner.importSource,
    createdAt: owner.createdAt,
  });

  const findingView = (finding: CanonicalFinding) => ({
    id: finding.id,
    pullRequest: finding.pullRequest,
    priority: finding.priority,
    title: finding.title,
    disposition: finding.disposition,
    url: finding.url,
  });

  const ownerView = (owner: RepoReviewStore.OwnerRecord) =>
    Effect.gen(function* () {
      const pullRequests = yield* store.listPullRequests(owner.id);
      const jobs = yield* store.listJobs({ ownerId: owner.id, limit: 50 });
      const findings = yield* store.listFindings({ ownerId: owner.id });
      const publications = yield* store.listPublications({ ownerId: owner.id, limit: 50 });
      return {
        owner: toOwnerView(owner),
        pullRequests: pullRequests
          .filter((pr) => pr.state === "open")
          .map((pr) => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            draft: pr.draft,
            headSha: pr.headSha,
            baseRef: pr.baseRef,
            baseSha: pr.baseSha,
            lastReviewedHeadSha: pr.lastReviewedHeadSha,
            round: pr.round,
            blocker: pr.blocker,
          })),
        jobs: jobs.map((job) => ({
          id: RepoReviewJobId.make(job.id),
          pullRequest: job.pullRequest,
          round: Math.max(1, job.round),
          trigger: job.trigger,
          status: job.status,
          headSha: job.headSha,
          baseSha: job.baseSha,
          threadId: job.threadId,
          verdict: job.verdict,
          error: job.error,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
        })),
        openFindings: findings.filter((finding) => finding.disposition === "open").map(findingView),
        publications: publications.map((publication) => ({
          id: publication.id,
          pullRequest: publication.pullRequest,
          kind: publication.kind,
          status: publication.status,
          expectedHeadSha: publication.expectedHeadSha,
          url: publication.url,
          detail: publication.detail,
        })),
      } satisfies RepoReviewOwnerView;
    });

  const status: RepoReviewController["Service"]["status"] = (input) =>
    Effect.gen(function* () {
      const owners =
        input.ownerId === undefined
          ? yield* store.listOwners({ includeStopped: input.includeStopped === true })
          : [yield* store.getOwner(input.ownerId)].filter((owner) => owner !== null);
      if (input.ownerId !== undefined && owners.length === 0) {
        return yield* failure("not_found", `No repository review owner ${input.ownerId}.`);
      }
      return { owners: yield* Effect.forEach(owners, ownerView) };
    }).pipe(
      Effect.catchTags({ RepoReviewStoreError: (error) => Effect.fail(storageFailure(error)) }),
    );

  const verifyCheckout = (
    projectId: RepoReviewStartInput["projectId"],
    host: string,
    repository: string,
  ) =>
    Effect.gen(function* () {
      const project = yield* projects
        .getById(projectId)
        .pipe(Effect.mapError(() => failure("storage_error", "Could not read the project.")));
      if (Option.isNone(project))
        return yield* failure("not_found", `Project ${projectId} was not found.`);
      const identity = yield* repositoryIdentity.resolve(project.value.workspaceRoot, {
        refresh: true,
      });
      if (
        identity === null ||
        identity.canonicalKey.toLowerCase() !== `${host}/${repository}`.toLowerCase()
      ) {
        return yield* failure(
          "invalid_request",
          `Project ${projectId} is not a checkout of ${host}/${repository}.`,
        );
      }
    });

  const insertOwnerOrConflict = (
    owner: Parameters<RepoReviewStore.RepoReviewStore["Service"]["insertOwner"]>[0],
  ) =>
    store.insertOwner(owner).pipe(
      Effect.catchTags({
        SqlError: () =>
          Effect.fail(
            failure(
              "conflict",
              `${owner.host}/${owner.repository} already has an owner that is not stopped.`,
            ),
          ),
        RepoReviewStoreError: (error) => Effect.fail(storageFailure(error)),
      }),
    );

  const start: RepoReviewController["Service"]["start"] = (input) =>
    Effect.gen(function* () {
      const host = (input.host ?? "github.com").toLowerCase();
      const policy = resolvePolicy(DEFAULT_POLICY, input.policy);
      if (policy === null)
        return yield* failure("invalid_request", "policy.modelSelection is required.");
      const existing = yield* store
        .findOwnerForRepository(host, input.repository)
        .pipe(Effect.mapError(storageFailure));
      if (existing !== null) {
        return yield* failure(
          "conflict",
          `${host}/${input.repository} is already owned by ${existing.id} (${existing.status}).`,
        );
      }
      yield* verifyCheckout(input.projectId, host, input.repository);
      const githubFailure = (error: RepoReviewGitHub.RepoReviewGitHubError) =>
        failure("github_unavailable", error.message);
      const account = yield* github.getViewerLogin(host).pipe(Effect.mapError(githubFailure));
      const repo = yield* github
        .getRepository({ host, repository: input.repository })
        .pipe(Effect.mapError(githubFailure));
      const now = yield* nowIso;
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() => failure("storage_error", "Could not create an owner id.")),
      );
      const id = `repo-review:${uuid}`;
      const activate = input.activate === true;
      yield* insertOwnerOrConflict({
        id,
        host,
        repository: repo.fullName,
        githubRepositoryId: repo.id,
        projectId: input.projectId,
        account,
        status: activate ? "active" : "paused",
        statusReason: activate ? null : "Created paused; resume to start polling.",
        statusChangedAt: now,
        pauseRequestedAt: null,
        policy,
        nextPollAt: now,
        importSource: null,
        eventsBaselineAt: null,
        createdAt: now,
        now,
      });
      const owner = yield* store.getOwner(id).pipe(Effect.mapError(storageFailure));
      return toOwnerView(owner!);
    });

  const assertNotReviewJob: RepoReviewController["Service"]["assertNotReviewJob"] = (
    callerThreadId,
  ) =>
    callerThreadId === undefined
      ? Effect.void
      : store.getJobByThread(callerThreadId).pipe(
          Effect.mapError(storageFailure),
          Effect.flatMap((job) =>
            job === null
              ? Effect.void
              : Effect.fail(
                  failure(
                    "invalid_request",
                    "Review jobs cannot control repository review owners.",
                  ),
                ),
          ),
        );

  const control: RepoReviewController["Service"]["control"] = (input, callerThreadId) =>
    Effect.gen(function* () {
      yield* assertNotReviewJob(callerThreadId);
      const owner = yield* store.getOwner(input.ownerId).pipe(Effect.mapError(storageFailure));
      if (owner === null)
        return yield* failure("not_found", `No repository review owner ${input.ownerId}.`);
      const now = yield* nowIso;
      const reason = input.reason ?? null;
      const change = (
        status: RepoReviewOwner["status"],
        from: ReadonlyArray<RepoReviewOwner["status"]>,
        statusReason: string | null,
        pauseRequestedAt: string | null,
      ) =>
        store
          .setOwnerStatus({
            id: owner.id,
            status,
            reason: statusReason,
            pauseRequestedAt,
            now,
            from,
          })
          .pipe(
            Effect.mapError(storageFailure),
            Effect.flatMap((changed) =>
              changed
                ? Effect.void
                : Effect.fail(
                    failure("conflict", `Owner is ${owner.status}; cannot ${input.action}.`),
                  ),
            ),
          );
      switch (input.action) {
        case "pause":
          yield* change("paused", ["active", "pausing"], reason ?? "Paused.", now);
          break;
        case "pause_after_round":
          yield* change(
            "pausing",
            ["active"],
            reason ?? "Pausing after the admitted review round.",
            now,
          );
          break;
        case "resume":
          yield* change("active", ["paused", "pausing"], null, null);
          break;
        case "stop": {
          const running = yield* store
            .listJobs({ ownerId: owner.id, statuses: ["running", "launching"] })
            .pipe(Effect.mapError(storageFailure));
          yield* store
            .transaction(
              Effect.gen(function* () {
                const changed = yield* store.setOwnerStatus({
                  id: owner.id,
                  status: "stopped",
                  reason: reason ?? "Stopped.",
                  pauseRequestedAt: owner.pauseRequestedAt,
                  now,
                  from: ["active", "pausing", "paused"],
                });
                if (!changed) return yield* failure("conflict", "Owner is already stopped.");
                const active = yield* store.listJobs({
                  ownerId: owner.id,
                  statuses: ["queued", "launching", "running", "result_received"],
                });
                for (const job of active) {
                  yield* store.transitionJob({
                    jobId: job.id,
                    from: ["queued", "launching", "running", "result_received"],
                    to: "cancelled",
                    error: "Owner stopped.",
                    now,
                  });
                }
                yield* store.cancelPublicationsForOwner({
                  ownerId: owner.id,
                  statuses: ["planned", "blocked", "uncertain"],
                  detail: "Owner stopped before this write was confirmed.",
                  now,
                });
              }),
            )
            .pipe(
              Effect.catchTags({
                RepoReviewStoreError: (error) => Effect.fail(storageFailure(error)),
              }),
            );
          yield* Effect.forEach(
            running,
            (job) => interruptJobThread(owner, job, "Repository review stopped."),
            {
              discard: true,
            },
          );
          break;
        }
        case "poll_now":
          if (owner.status === "stopped") return yield* failure("conflict", "Owner is stopped.");
          yield* store.requestPoll(owner.id, now).pipe(Effect.mapError(storageFailure));
          break;
        case "requeue": {
          if (owner.status === "stopped") return yield* failure("conflict", "Owner is stopped.");
          if (input.pullRequest === undefined)
            return yield* failure("invalid_request", "requeue needs pullRequest.");
          const pr = (yield* store
            .listPullRequests(owner.id)
            .pipe(Effect.mapError(storageFailure))).find(
            (candidate) => candidate.number === input.pullRequest,
          );
          if (pr === undefined || pr.state !== "open") {
            return yield* failure(
              "invalid_request",
              `Pull request #${input.pullRequest} is not an open tracked pull request.`,
            );
          }
          yield* enqueueJob(owner, pr, "requeue", now).pipe(
            Effect.mapError(() =>
              failure("conflict", `Pull request #${pr.number} already has a review in flight.`),
            ),
          );
          break;
        }
      }
      const updated = yield* store.getOwner(owner.id).pipe(Effect.mapError(storageFailure));
      return toOwnerView(updated!);
    });

  // -------------------------------------------------------------------------
  // Import of a watch-repo ledger. Never touches GitHub.
  // -------------------------------------------------------------------------

  const importLedger: RepoReviewController["Service"]["importLedger"] = (input) =>
    Effect.gen(function* () {
      const host = (input.host ?? "github.com").toLowerCase();
      const dryRun = input.dryRun !== false;
      const rawText = yield* fileSystem
        .readFileString(input.ledgerPath)
        .pipe(Effect.mapError(() => failure("invalid_request", "Could not read the ledger file.")));
      const parsed = yield* decodeLedgerJson(rawText).pipe(
        Effect.mapError(() => failure("invalid_request", "The ledger is not valid JSON.")),
      );
      const plan = planLedgerImport(parsed);
      const sourceSha256 = yield* sha256(rawText);
      const blockers = [...plan.blockers];
      const previous = yield* store.findImport(sourceSha256).pipe(Effect.mapError(storageFailure));
      if (previous === null && plan.repository !== "") {
        const existing = yield* store
          .findOwnerForRepository(host, plan.repository)
          .pipe(Effect.mapError(storageFailure));
        if (existing !== null)
          blockers.push(
            `${host}/${plan.repository} already has owner ${existing.id} (${existing.status}).`,
          );
      }
      const checkout = yield* Effect.result(verifyCheckout(input.projectId, host, plan.repository));
      if (checkout._tag === "Failure") blockers.push(checkout.failure.message);
      const policy = resolvePolicy(
        {
          ...DEFAULT_POLICY,
          postFindings: plan.permissions.post,
          approve: plan.permissions.approve,
          merge: plan.permissions.merge,
        },
        input.policy,
      );
      if (policy === null && !dryRun)
        blockers.push("policy.modelSelection is required to apply an import.");

      const summary = {
        repository: plan.repository === "" ? "unknown/unknown" : plan.repository,
        account: plan.account,
        sourceSha256,
        pullRequests: plan.pullRequests.length,
        openPullRequests: plan.pullRequests
          .filter((pr) => pr.state === "open")
          .map((pr) => pr.number),
        findings: plan.findings.length,
        openFindings: plan.findings
          .filter((finding) => finding.disposition === "open")
          .map(findingView),
        approvals: plan.approvals.length,
        merges: plan.merges.length,
        jobs: plan.jobs.length,
        eventReceipts: plan.receipts.length,
        warnings: plan.warnings,
      };
      if (previous !== null) {
        return {
          ...summary,
          dryRun,
          ownerId: RepoReviewOwnerId.make(previous.ownerId),
          alreadyImported: true,
          blockers: [],
        };
      }
      if (dryRun || blockers.length > 0 || policy === null) {
        if (!dryRun)
          return yield* failure("conflict", `Import blocked:\n- ${blockers.join("\n- ")}`);
        return { ...summary, dryRun, ownerId: null, alreadyImported: false, blockers };
      }

      const now = yield* nowIso;
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() => failure("storage_error", "Could not create an owner id.")),
      );
      const ownerId = `repo-review:${uuid}`;
      yield* store
        .transaction(
          Effect.gen(function* () {
            yield* store.insertOwner({
              id: ownerId,
              host,
              repository: plan.repository,
              githubRepositoryId: null,
              projectId: input.projectId,
              account: plan.account,
              // Imported monitoring always starts paused; activating it is a separate decision.
              status: "paused",
              statusReason: `Imported from ${plan.parentThreadId ?? "a watch-repo ledger"}; resume to activate.`,
              statusChangedAt: now,
              pauseRequestedAt: now,
              policy,
              nextPollAt: now,
              importSource: input.ledgerPath,
              eventsBaselineAt: plan.eventsBaselineAt,
              createdAt: now,
              now,
            });
            for (const pr of plan.pullRequests) yield* store.upsertPullRequest(ownerId, pr, now);
            for (const finding of plan.findings) {
              yield* store.insertFinding({
                ownerId,
                finding,
                source: "import",
                reportedJobId: null,
                reportedHeadSha: null,
                now,
              });
            }
            for (const approval of plan.approvals) {
              yield* store.insertConfirmedPublication({
                id: `approval:${ownerId}:${approval.pullRequest}:${approval.headSha}`,
                ownerId,
                pullRequest: approval.pullRequest,
                kind: "approval",
                expectedHeadSha: approval.headSha,
                payload: { kind: "approval", body: "" },
                githubId: approval.githubId,
                url: approval.url,
                detail: "Imported.",
                now,
              });
            }
            for (const merge of plan.merges) {
              yield* store.insertConfirmedPublication({
                id: `merge:${ownerId}:${merge.pullRequest}:${merge.headSha}`,
                ownerId,
                pullRequest: merge.pullRequest,
                kind: "merge",
                expectedHeadSha: merge.headSha,
                payload: { kind: "merge", method: policy.mergeMethod },
                githubId: merge.mergeCommitSha,
                url: merge.url,
                detail: "Imported.",
                now,
              });
            }
            for (const job of plan.jobs) {
              yield* store.insertImportedJob({
                id: `${ids.job(ownerId, job.pullRequest, job.round)}:imported`,
                ownerId,
                pullRequest: job.pullRequest,
                round: job.round,
                headSha: job.headSha,
                baseRef: job.baseRef,
                baseSha: job.baseSha,
                externalTaskId: job.externalTaskId,
                threadId: job.threadId,
                verdict: job.verdict,
                createdAt: now,
              });
            }
            for (const receipt of plan.receipts) {
              yield* store.insertReceipts({
                ownerId,
                pullRequest: receipt.pullRequest,
                jobId: null,
                receipts: [{ key: receipt.key, kind: "import", disposition: "baseline" }],
                now,
              });
            }
            yield* store.insertImport({
              id: `import:${sourceSha256.slice(0, 16)}`,
              ownerId,
              sourcePath: input.ledgerPath,
              sourceSha256,
              rawJson: rawText,
              now,
            });
          }),
        )
        .pipe(
          Effect.catchTags({ RepoReviewStoreError: (error) => Effect.fail(storageFailure(error)) }),
        );
      return {
        ...summary,
        dryRun,
        ownerId: RepoReviewOwnerId.make(ownerId),
        alreadyImported: false,
        blockers: [],
      };
    });

  // Visible as uncertain from startup on, before the first pass runs.
  yield* Effect.gen(function* () {
    const owners = yield* store.listOwners({ includeStopped: false });
    for (const owner of owners) {
      yield* releaseAbandonedWrites(owner.id, "Interrupted by a restart; confirming by read-back.");
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not recover repository review writes", { cause }),
    ),
  );

  yield* scheduler.register("repo-review", runDueWork);

  return RepoReviewController.of({
    status,
    start,
    control,
    importLedger,
    submitResult,
    assertNotReviewJob,
    runDueWork,
  });
});

export const layer = Layer.effect(RepoReviewController, make);
