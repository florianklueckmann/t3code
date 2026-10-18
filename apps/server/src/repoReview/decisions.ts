import type {
  RepoReviewFindingDisposition,
  RepoReviewFindingPriority,
  RepoReviewJobResult,
  RepoReviewJobStatus,
  RepoReviewJobTrigger,
  RepoReviewPolicy,
  RepoReviewPublicationKind,
  RepoReviewPullRequestState,
} from "@t3tools/contracts";

import type {
  RepoReviewConversationEvent,
  RepoReviewPullRequestDetail,
  RepoReviewReviewThread,
} from "./RepoReviewGitHub.ts";

/**
 * Pure decisions of the repository review controller. Nothing here reads a clock, the
 * database or GitHub: the controller gathers state, calls these, and commits what they return.
 */

export interface StoredPullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: RepoReviewPullRequestState;
  readonly draft: boolean;
  readonly authorLogin: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly githubUpdatedAt: string;
  readonly lastReviewedHeadSha: string | null;
  readonly lastReviewedBaseSha: string | null;
  readonly round: number;
  readonly blocker: string | null;
}

export interface PullRequestObservation {
  readonly detail: RepoReviewPullRequestDetail;
  /** The base branch tip read from the branch itself, not the pull request's copy. */
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly events: ReadonlyArray<RepoReviewConversationEvent>;
}

export interface JobSummary {
  readonly id: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly status: RepoReviewJobStatus;
}

export interface EventReceipt {
  readonly key: string;
  readonly kind: string;
  readonly disposition: "own" | "bot" | "baseline" | "included";
}

/** How the controller recognizes its own writes and the history it inherited. */
export interface EventContext {
  readonly handledKeys: ReadonlySet<string>;
  /** The posting account. Only its comments can be ours; it may also be the author. */
  readonly account: string;
  /** First line of our public comments. */
  readonly commentPrefix: string;
  /** Events at or before this instant were handled by an earlier owner (imports). */
  readonly baselineAt: string | null;
}

export interface ReconcileDecision {
  readonly pullRequest: StoredPullRequest;
  readonly receipts: ReadonlyArray<EventReceipt>;
  readonly enqueue: RepoReviewJobTrigger | null;
  /** The in-flight job to cancel, with the reason recorded on it. */
  readonly cancelJob: { readonly id: string; readonly reason: string } | null;
}

const ACTIVE_JOB_STATUSES: ReadonlySet<RepoReviewJobStatus> = new Set([
  "queued",
  "launching",
  "running",
  "result_received",
]);

export const isActiveJobStatus = (status: RepoReviewJobStatus) => ACTIVE_JOB_STATUSES.has(status);

const CONTROLLER_MARKER = "t3-repo-review:";

/**
 * What one conversation event means to the controller. Our own writes come from the posting
 * account and carry our marker or comment prefix. Login alone is not enough: on a personal
 * repository the posting account is often the author too, and the author's replies must count.
 */
function classifyEvent(
  event: RepoReviewConversationEvent,
  context: EventContext,
): "handled" | "own" | "bot" | "baseline" | "material" {
  if (event.keys.some((key) => context.handledKeys.has(key))) return "handled";
  const prefix = context.commentPrefix.trim();
  const byAccount = event.authorLogin.toLowerCase() === context.account.toLowerCase();
  // GitHub refuses reviews of one's own pull request, so a review by the posting account is never
  // the author speaking. Its inline replies arrive separately as review comments.
  if (
    byAccount &&
    (event.kind === "review" ||
      event.body.includes(CONTROLLER_MARKER) ||
      (prefix !== "" && event.body.trimStart().startsWith(prefix)))
  ) {
    return "own";
  }
  if (event.authorIsBot) return "bot";
  if (
    context.baselineAt !== null &&
    event.createdAt !== "" &&
    event.createdAt <= context.baselineAt
  ) {
    return "baseline";
  }
  return "material";
}

/** Author events that may change a review verdict and were not part of any earlier brief. */
export const materialEvents = (
  events: ReadonlyArray<RepoReviewConversationEvent>,
  context: EventContext,
  options: { readonly includeInherited?: boolean } = {},
) =>
  events.filter((event) => {
    const kind = classifyEvent(event, context);
    return kind === "material" || (options.includeInherited === true && kind === "baseline");
  });

/**
 * Folds one observation of a pull request into its stored state and decides whether it needs a
 * review. Unchanged state, repeated events, our own comments and a moving base never enqueue.
 * A review that already failed at this head is not retried on its own: that would spend model
 * turns in a loop. It waits for a new head, a new author reply or an explicit requeue.
 */
export function reconcilePullRequest(input: {
  readonly stored: StoredPullRequest | null;
  readonly observation: PullRequestObservation;
  readonly events: EventContext;
  readonly policy: Pick<RepoReviewPolicy, "reviewDrafts">;
  readonly activeJob: JobSummary | null;
  readonly latestJob: JobSummary | null;
}): ReconcileDecision {
  const { stored, observation, activeJob, latestJob } = input;
  const { detail } = observation;
  const receipts: EventReceipt[] = [];
  let material = 0;
  let inherited = 0;
  for (const event of observation.events) {
    const kind = classifyEvent(event, input.events);
    if (kind === "own" || kind === "bot") {
      receipts.push({ key: event.keys[0]!, kind: event.kind, disposition: kind });
    } else if (kind === "material") {
      // Left unreceipted on purpose: the next brief includes it and records it then.
      material++;
    } else if (kind === "baseline") {
      inherited++;
    }
  }
  // Activity from before an import that the previous owner never marked handled. It may or may
  // not have been reviewed, so it starts nothing on its own. It stays unreceipted and visible
  // until a requeued review includes it.
  const inheritedNote =
    inherited === 0
      ? null
      : `${inherited} author event(s) from before the handover were never marked handled; requeue to review them.`;

  const base: StoredPullRequest = {
    number: detail.number,
    title: detail.title,
    state: detail.state,
    draft: detail.draft,
    authorLogin: detail.authorLogin,
    headRef: detail.headRef,
    headSha: detail.headSha,
    baseRef: detail.baseRef,
    baseSha: observation.baseSha,
    mergeBaseSha: observation.mergeBaseSha,
    githubUpdatedAt: detail.updatedAt,
    lastReviewedHeadSha: stored?.lastReviewedHeadSha ?? null,
    lastReviewedBaseSha: stored?.lastReviewedBaseSha ?? null,
    round: stored?.round ?? 0,
    blocker: inheritedNote,
  };

  if (detail.state !== "open") {
    return {
      pullRequest: base,
      receipts,
      enqueue: null,
      cancelJob:
        activeJob === null ? null : { id: activeJob.id, reason: `Pull request ${detail.state}.` },
    };
  }

  const retargeted =
    (stored !== null && stored.baseRef !== detail.baseRef) ||
    (latestJob !== null &&
      latestJob.headSha === detail.headSha &&
      latestJob.baseRef !== detail.baseRef);
  if (activeJob !== null) {
    if (activeJob.headSha === detail.headSha && activeJob.baseRef === detail.baseRef) {
      return { pullRequest: base, receipts, enqueue: null, cancelJob: null };
    }
    return {
      pullRequest: base,
      receipts,
      enqueue: activeJob.headSha === detail.headSha ? "base_retarget" : "new_head",
      cancelJob: { id: activeJob.id, reason: "Superseded by a newer revision." },
    };
  }

  if (detail.draft && !input.policy.reviewDrafts) {
    return {
      pullRequest: { ...base, blocker: "Draft; drafts are not reviewed." },
      receipts,
      enqueue: null,
      cancelJob: null,
    };
  }

  if (
    latestJob !== null &&
    latestJob.headSha === detail.headSha &&
    latestJob.baseRef === detail.baseRef &&
    (latestJob.status === "failed" || latestJob.status === "cancelled")
  ) {
    // A new author reply is a new reason to look. Its events are receipted when that review
    // launches, so a second failure cannot loop.
    if (material > 0)
      return { pullRequest: base, receipts, enqueue: "author_event", cancelJob: null };
    return {
      pullRequest: {
        ...base,
        blocker: `Review ${latestJob.status} at this head; requeue to retry.`,
      },
      receipts,
      enqueue: null,
      cancelJob: null,
    };
  }

  const enqueue: RepoReviewJobTrigger | null =
    base.lastReviewedHeadSha === null && latestJob === null
      ? "new_pull_request"
      : (base.lastReviewedHeadSha ?? latestJob?.headSha) !== detail.headSha
        ? "new_head"
        : retargeted
          ? "base_retarget"
          : material > 0
            ? "author_event"
            : null;
  return { pullRequest: base, receipts, enqueue, cancelJob: null };
}

// ---------------------------------------------------------------------------
// Results.
// ---------------------------------------------------------------------------

export interface CanonicalFinding {
  readonly id: string;
  readonly pullRequest: number;
  readonly priority: RepoReviewFindingPriority;
  readonly title: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly scenario: string | null;
  readonly impact: string | null;
  /** The public comment body, kept so a report cancelled by a new head can be posted later. */
  readonly body: string | null;
  readonly disposition: RepoReviewFindingDisposition;
  readonly dedupKey: string;
  readonly githubCommentId: string | null;
  readonly githubThreadId: string | null;
  readonly url: string | null;
}

export interface JobPins {
  readonly id: string;
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
}

export const findingDedupKey = (path: string | null | undefined, title: string) =>
  `${path ?? ""}::${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()}`;

/**
 * Everything wrong with a submitted result, empty when it is acceptable. A result is tied to
 * exactly one job: its repository, pull request and pins must equal what the job was launched
 * with, and it must re-adjudicate every finding that was open when the job started.
 */
export function validateResult(
  result: RepoReviewJobResult,
  job: JobPins,
  findings: ReadonlyArray<CanonicalFinding>,
): ReadonlyArray<string> {
  const problems: string[] = [];
  if (result.jobId !== job.id) problems.push(`jobId must be ${job.id}.`);
  if (result.repository.toLowerCase() !== job.repository.toLowerCase()) {
    problems.push(`repository must be ${job.repository}.`);
  }
  if (result.pullRequest !== job.pullRequest)
    problems.push(`pullRequest must be ${job.pullRequest}.`);
  const pins = result.pins;
  if (pins.headSha !== job.headSha) problems.push(`pins.headSha must be ${job.headSha}.`);
  if (pins.baseRef !== job.baseRef) problems.push(`pins.baseRef must be ${job.baseRef}.`);
  if (pins.baseSha !== job.baseSha) problems.push(`pins.baseSha must be ${job.baseSha}.`);
  if (pins.mergeBaseSha !== job.mergeBaseSha) {
    problems.push(`pins.mergeBaseSha must be ${job.mergeBaseSha}.`);
  }

  const known = new Map(findings.map((finding) => [finding.id, finding]));
  const adjudicated = new Set<string>();
  result.findings.forEach((finding, index) => {
    const at = `findings[${index}]`;
    if (finding.status === "new") {
      if (finding.canonicalId !== undefined) {
        problems.push(`${at}: a new finding has no canonicalId.`);
      }
      for (const field of [
        "priority",
        "title",
        "path",
        "line",
        "scenario",
        "impact",
        "body",
      ] as const) {
        if (finding[field] === undefined || finding[field] === "") {
          problems.push(`${at}: a new finding needs ${field}.`);
        }
      }
      if (finding.body?.includes("t3-repo-review:") === true) {
        problems.push(`${at}: body must not contain controller markers.`);
      }
      return;
    }
    if (finding.canonicalId === undefined) {
      problems.push(
        `${at}: status ${finding.status} needs the canonicalId of an existing finding.`,
      );
      return;
    }
    const existing = known.get(finding.canonicalId);
    if (existing === undefined || existing.pullRequest !== job.pullRequest) {
      problems.push(`${at}: unknown canonicalId ${finding.canonicalId} for this pull request.`);
      return;
    }
    if (adjudicated.has(existing.id)) problems.push(`${at}: ${existing.id} is listed twice.`);
    adjudicated.add(existing.id);
  });
  for (const finding of findings) {
    if (
      finding.pullRequest === job.pullRequest &&
      finding.disposition === "open" &&
      !adjudicated.has(finding.id)
    ) {
      problems.push(
        `Open finding ${finding.id} must be re-adjudicated (still_open, fixed or withdrawn).`,
      );
    }
  }

  const blocking = result.findings.filter(
    (finding) => finding.status === "new" || finding.status === "still_open",
  ).length;
  if (result.verdict === "clean" && blocking > 0) {
    problems.push("A clean verdict cannot carry new or still-open findings.");
  }
  if (result.verdict === "findings" && blocking === 0) {
    problems.push("A findings verdict needs at least one new or still-open finding.");
  }
  if (result.verdict === "blocked" && (result.blockedReason ?? "").trim() === "") {
    problems.push("A blocked verdict needs blockedReason.");
  }
  if (result.verdict !== "blocked" && !result.coverage.effectiveDiffInspected) {
    problems.push("coverage.effectiveDiffInspected must be true unless the verdict is blocked.");
  }
  return problems;
}

export interface PlannedPublication {
  readonly id: string;
  readonly kind: RepoReviewPublicationKind;
  readonly findingId: string | null;
  readonly payload: PublicationPayload;
}

export type PublicationPayload =
  | {
      readonly kind: "finding_comment";
      readonly path: string;
      readonly line: number;
      readonly body: string;
    }
  | { readonly kind: "approval"; readonly body: string }
  | { readonly kind: "merge"; readonly method: RepoReviewPolicy["mergeMethod"] };

export const publicationMarker = (publicationId: string) =>
  `<!-- t3-repo-review:${publicationId} -->`;

const publicationIds = {
  finding: (ownerId: string, findingId: string) => `finding:${ownerId}:${findingId}`,
  approval: (ownerId: string, pullRequest: number, headSha: string) =>
    `approval:${ownerId}:${pullRequest}:${headSha}`,
  merge: (ownerId: string, pullRequest: number, headSha: string) =>
    `merge:${ownerId}:${pullRequest}:${headSha}`,
};

export interface ResultApplication {
  readonly jobStatus: "completed" | "stale" | "failed";
  readonly error: string | null;
  /** Set when the pull request now counts as reviewed at the job's head. */
  readonly reviewedHead: boolean;
  readonly newFindings: ReadonlyArray<CanonicalFinding>;
  readonly dispositionChanges: ReadonlyArray<{
    readonly id: string;
    readonly disposition: RepoReviewFindingDisposition;
  }>;
  readonly publications: ReadonlyArray<PlannedPublication>;
}

/**
 * Turns a validated result into canonical findings and planned GitHub writes. A result whose
 * head no longer matches the pull request, or for a closed one, authorizes nothing.
 * An unchanged defect keeps its one canonical report; a new finding that matches an open one by
 * path and title is folded into it rather than posted again.
 */
export function applyResult(input: {
  readonly ownerId: string;
  readonly job: JobPins;
  readonly result: RepoReviewJobResult;
  readonly current: {
    readonly state: RepoReviewPullRequestState;
    readonly headSha: string;
    readonly baseRef: string;
  };
  readonly findings: ReadonlyArray<CanonicalFinding>;
  readonly policy: RepoReviewPolicy;
  readonly commentPrefix: string;
}): ResultApplication {
  const { job, result, current, policy } = input;
  const none = { newFindings: [], dispositionChanges: [], publications: [] };
  if (
    current.state !== "open" ||
    current.headSha !== job.headSha ||
    current.baseRef !== job.baseRef
  ) {
    return {
      jobStatus: "stale",
      error:
        current.state !== "open"
          ? `Pull request ${current.state}.`
          : current.headSha !== job.headSha
            ? "Head moved during review."
            : `Retargeted to ${current.baseRef} during review.`,
      reviewedHead: false,
      ...none,
    };
  }
  if (result.verdict === "blocked") {
    return {
      jobStatus: "failed",
      error: result.blockedReason ?? "Review blocked.",
      reviewedHead: false,
      ...none,
    };
  }

  const prFindings = input.findings.filter((finding) => finding.pullRequest === job.pullRequest);
  const openByKey = new Map(
    prFindings
      .filter((finding) => finding.disposition === "open")
      .map((finding) => [finding.dedupKey, finding]),
  );
  const dispositionChanges: Array<{ id: string; disposition: RepoReviewFindingDisposition }> = [];
  const newFindings: CanonicalFinding[] = [];
  const publications: PlannedPublication[] = [];
  const stillOpen = new Set<string>();
  const planFindingComment = (finding: CanonicalFinding) => {
    if (!policy.postFindings || finding.path === null || finding.line === null) return;
    const publicationId = publicationIds.finding(input.ownerId, finding.id);
    publications.push({
      id: publicationId,
      kind: "finding_comment",
      findingId: finding.id,
      payload: {
        kind: "finding_comment",
        path: finding.path,
        line: finding.line,
        body: [
          input.commentPrefix,
          `**[${finding.priority}] ${finding.title}**`,
          finding.body ?? [finding.scenario, finding.impact].filter(Boolean).join("\n\n"),
          publicationMarker(publicationId),
        ]
          .filter((part) => part.trim() !== "")
          .join("\n\n"),
      },
    });
  };

  result.findings.forEach((finding, index) => {
    if (finding.status === "new") {
      const dedupKey = findingDedupKey(finding.path, finding.title ?? "");
      const duplicate = openByKey.get(dedupKey);
      if (duplicate !== undefined) {
        stillOpen.add(duplicate.id);
        return;
      }
      const canonical: CanonicalFinding = {
        id: `${job.id}#${index + 1}`,
        pullRequest: job.pullRequest,
        priority: finding.priority!,
        title: finding.title!,
        path: finding.path ?? null,
        line: finding.line ?? null,
        scenario: finding.scenario ?? null,
        impact: finding.impact ?? null,
        body: finding.body ?? null,
        disposition: "open",
        dedupKey,
        githubCommentId: null,
        githubThreadId: null,
        url: null,
      };
      newFindings.push(canonical);
      openByKey.set(dedupKey, canonical);
      stillOpen.add(canonical.id);
      planFindingComment(canonical);
      return;
    }
    const id = finding.canonicalId!;
    if (finding.status === "still_open") {
      stillOpen.add(id);
      const existing = prFindings.find((candidate) => candidate.id === id);
      // A defect found again after it was marked fixed or withdrawn is open again.
      if (existing !== undefined && existing.disposition !== "open") {
        dispositionChanges.push({ id, disposition: "open" });
      }
      // A report whose first publication was cancelled by a new head is posted at this head.
      if (existing !== undefined && existing.url === null && existing.githubCommentId === null) {
        planFindingComment({
          ...existing,
          path: finding.path ?? existing.path,
          line: finding.line ?? existing.line,
        });
      }
      return;
    }
    dispositionChanges.push({ id, disposition: finding.status });
  });

  const resolved = dispositionChanges
    .map((change) => prFindings.find((finding) => finding.id === change.id))
    .filter((finding): finding is CanonicalFinding => finding !== undefined);
  if (stillOpen.size === 0 && result.verdict === "clean") {
    if (policy.approve) {
      const id = publicationIds.approval(input.ownerId, job.pullRequest, job.headSha);
      const fixed = resolved
        .filter((finding) => finding.url !== null)
        .map((finding) => `- ${finding.url}`);
      publications.push({
        id,
        kind: "approval",
        findingId: null,
        payload: {
          kind: "approval",
          body: [
            input.commentPrefix,
            `Reviewed ${job.headSha} against ${job.baseRef}@${job.baseSha}. No actionable findings.`,
            fixed.length === 0 ? "" : `Verified resolved:\n${fixed.join("\n")}`,
            publicationMarker(id),
          ]
            .filter((part) => part.trim() !== "")
            .join("\n\n"),
        },
      });
    }
    // Planned for drafts too: landing holds it as blocked until the pull request is ready.
    if (policy.merge) {
      publications.push({
        id: publicationIds.merge(input.ownerId, job.pullRequest, job.headSha),
        kind: "merge",
        findingId: null,
        payload: { kind: "merge", method: policy.mergeMethod },
      });
    }
  }
  return {
    jobStatus: "completed",
    error: null,
    reviewedHead: true,
    newFindings,
    dispositionChanges,
    publications,
  };
}

// ---------------------------------------------------------------------------
// Landing.
// ---------------------------------------------------------------------------

export interface LandingSnapshot {
  readonly detail: RepoReviewPullRequestDetail;
  readonly baseSha: string;
  readonly events: ReadonlyArray<RepoReviewConversationEvent>;
  readonly threads: ReadonlyArray<RepoReviewReviewThread>;
  readonly allowedMergeMethods: ReadonlyArray<RepoReviewPolicy["mergeMethod"]>;
  readonly viewerLogin: string;
}

export type LandingVerdict =
  | { readonly type: "proceed" }
  /** Already done on GitHub; record it instead of writing again. */
  | { readonly type: "already_done"; readonly githubId: string; readonly url: string }
  /** The reviewed target is gone: a new revision or a closed pull request. */
  | { readonly type: "cancel"; readonly reason: string }
  /** Valid but not landable now; re-evaluated on a later poll. */
  | { readonly type: "blocked"; readonly reason: string }
  /** The base moved since the review: the integrated result needs another finite round first. */
  | { readonly type: "needs_integration_review"; readonly reason: string };

const MERGEABLE_STATES = new Set(["clean", "has_hooks"]);

/**
 * The account's approval of `headSha` if it is still its standing verdict. A later change request
 * or dismissal by the same account replaces an earlier approval, so only the latest counts.
 */
export function effectiveApproval(
  events: ReadonlyArray<RepoReviewConversationEvent>,
  account: string,
  headSha: string,
): RepoReviewConversationEvent | null {
  const latest = events.findLast(
    (event) =>
      event.kind === "review" &&
      event.authorLogin.toLowerCase() === account.toLowerCase() &&
      event.reviewState !== null &&
      event.reviewState !== "COMMENTED" &&
      event.reviewState !== "PENDING",
  );
  return latest?.reviewState === "APPROVED" && latest.commitId === headSha ? latest : null;
}

/**
 * Re-checks an approval or merge against a fresh read of GitHub immediately before the write.
 * The reviewed head and base must both still be current: disjoint file lists do not prove a
 * moved base left the behavior alone, so any base movement asks for another round. Merges also
 * need GitHub to call the pull request clean, so required checks, reviews and an outdated branch
 * are never pushed through with an admin credential.
 */
export function assessLanding(input: {
  readonly kind: "approval" | "merge";
  readonly expectedHeadSha: string;
  readonly expectedBaseRef: string;
  readonly expectedBaseSha: string;
  readonly policy: RepoReviewPolicy;
  readonly snapshot: LandingSnapshot;
  readonly ownFindings: ReadonlyArray<CanonicalFinding>;
}): LandingVerdict {
  const { snapshot, kind } = input;
  const { detail } = snapshot;
  const viewer = snapshot.viewerLogin.toLowerCase();
  if (kind === "merge" && detail.state === "merged") {
    // Only our own merge of the reviewed head counts as this publication succeeding.
    return detail.headSha === input.expectedHeadSha &&
      detail.mergeCommitSha !== null &&
      detail.mergedBy?.toLowerCase() === viewer
      ? { type: "already_done", githubId: detail.mergeCommitSha, url: detail.url }
      : {
          type: "cancel",
          reason: `Merged outside the controller${detail.mergedBy === null ? "" : ` by ${detail.mergedBy}`}.`,
        };
  }
  if (detail.state !== "open") return { type: "cancel", reason: `Pull request ${detail.state}.` };
  if (detail.headSha !== input.expectedHeadSha) {
    return { type: "cancel", reason: "Head changed since the review." };
  }
  if (kind === "approval") {
    const existing = effectiveApproval(snapshot.events, viewer, input.expectedHeadSha);
    if (existing !== null) {
      return { type: "already_done", githubId: existing.githubId, url: existing.url };
    }
  }
  if (input.ownFindings.some((finding) => finding.disposition === "open")) {
    return { type: "cancel", reason: "An actionable finding is open." };
  }
  if (detail.baseRef !== input.expectedBaseRef) {
    return { type: "cancel", reason: `Retargeted to ${detail.baseRef}.` };
  }
  if (snapshot.baseSha !== input.expectedBaseSha) {
    return {
      type: "needs_integration_review",
      reason: `Base ${detail.baseRef} moved from ${input.expectedBaseSha.slice(0, 7)} to ${snapshot.baseSha.slice(0, 7)} since the review.`,
    };
  }
  // Blocking reviews and threads hold approvals as well as merges.
  const latestByReviewer = new Map<string, string>();
  for (const event of snapshot.events) {
    if (event.kind !== "review" || event.reviewState === null || event.reviewState === "COMMENTED")
      continue;
    // Our own earlier change request is what a fresh approval replaces.
    if (kind === "approval" && event.authorLogin.toLowerCase() === viewer) continue;
    latestByReviewer.set(event.authorLogin.toLowerCase(), event.reviewState);
  }
  const requested = [...latestByReviewer].filter(([, state]) => state === "CHANGES_REQUESTED");
  if (requested.length > 0) {
    return {
      type: "blocked",
      reason: `Changes requested by ${requested.map(([login]) => login).join(", ")}.`,
    };
  }
  const resolvedOwn = new Set(
    input.ownFindings
      .filter((finding) => finding.disposition !== "open" && finding.githubCommentId !== null)
      .map((finding) => finding.githubCommentId!),
  );
  const unresolved = snapshot.threads.filter(
    (thread) =>
      !thread.isResolved &&
      (thread.rootCommentId === null || !resolvedOwn.has(thread.rootCommentId)),
  );
  if (unresolved.length > 0) {
    return { type: "blocked", reason: `${unresolved.length} unresolved review thread(s).` };
  }
  // A missing approval is often what makes GitHub call a pull request blocked, so mergeability
  // is a merge condition only. Drafts may be approved but are never merged.
  if (kind === "approval") return { type: "proceed" };

  if (detail.draft) return { type: "blocked", reason: "Draft pull requests are not merged." };
  if (!input.policy.merge) return { type: "cancel", reason: "Merging is not authorized." };
  if (!snapshot.allowedMergeMethods.includes(input.policy.mergeMethod)) {
    return {
      type: "blocked",
      reason: `The repository does not allow ${input.policy.mergeMethod} merges.`,
    };
  }
  if (detail.mergeable !== true || !MERGEABLE_STATES.has(detail.mergeableState)) {
    return {
      type: "blocked",
      reason: `GitHub reports the pull request as ${detail.mergeableState}.`,
    };
  }
  return { type: "proceed" };
}
