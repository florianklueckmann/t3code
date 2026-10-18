import type { RepoReviewFindingDisposition, RepoReviewFindingPriority } from "@t3tools/contracts";

import { type CanonicalFinding, findingDedupKey, type StoredPullRequest } from "./decisions.ts";

/**
 * Reads a watch-repo session ledger (schema 1). Those ledgers were written by a model, so field
 * sets vary between pull requests. Only records whose meaning is unambiguous are imported as
 * facts; anything else becomes a warning, and the raw ledger is kept beside the import.
 */

export interface ImportedApproval {
  readonly pullRequest: number;
  readonly headSha: string;
  readonly githubId: string;
  readonly url: string;
}

export interface ImportedMerge {
  readonly pullRequest: number;
  readonly headSha: string;
  readonly mergeCommitSha: string;
  readonly url: string;
}

export interface ImportedJob {
  readonly pullRequest: number;
  readonly round: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly externalTaskId: string | null;
  readonly threadId: string | null;
  readonly verdict: string | null;
}

export interface LedgerImportPlan {
  readonly repository: string;
  readonly account: string;
  readonly parentThreadId: string | null;
  /** Events at or before this instant were handled by the previous owner. */
  readonly eventsBaselineAt: string | null;
  readonly permissions: {
    readonly post: boolean;
    readonly approve: boolean;
    readonly merge: boolean;
  };
  readonly pullRequests: ReadonlyArray<StoredPullRequest>;
  readonly findings: ReadonlyArray<CanonicalFinding>;
  readonly approvals: ReadonlyArray<ImportedApproval>;
  readonly merges: ReadonlyArray<ImportedMerge>;
  readonly jobs: ReadonlyArray<ImportedJob>;
  readonly receipts: ReadonlyArray<{ readonly pullRequest: number; readonly key: string }>;
  readonly warnings: ReadonlyArray<string>;
  /** Reasons the import must not be applied. */
  readonly blockers: ReadonlyArray<string>;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const int = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;
const sha = (value: unknown): string | null => {
  const text = str(value);
  return text !== null && /^[0-9a-f]{40}$/.test(text) ? text : null;
};
const idText = (value: unknown): string | null =>
  typeof value === "number" && Number.isInteger(value) ? String(value) : str(value);

const PRIORITIES = new Set<RepoReviewFindingPriority>(["P0", "P1", "P2", "P3"]);
const DISPOSITIONS = new Set<RepoReviewFindingDisposition>(["open", "fixed", "withdrawn"]);

/** The numeric comment id in a GitHub discussion or issue-comment URL. */
const commentIdFromUrl = (url: string | null) =>
  url === null ? null : (/#(?:discussion_r|issuecomment-)(\d+)$/.exec(url)?.[1] ?? null);

export function planLedgerImport(raw: unknown): LedgerImportPlan {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const ledger = isObject(raw) ? raw : {};
  if (ledger.schema !== 1) blockers.push("Ledger schema is not 1.");
  const repository = str(ledger.repository) ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    blockers.push("Ledger has no owner/name repository.");
  }
  const account = str(ledger.account) ?? "";
  if (account === "") blockers.push("Ledger has no posting account.");
  // Exactly one owner: the previous one must be verifiably stopped before anything is imported.
  if (ledger.status !== "stopped") {
    blockers.push(`Previous owner status is ${String(ledger.status)}; stop it first.`);
  }
  if (isObject(ledger.discovery) && ledger.discovery.enabled !== false) {
    blockers.push("Previous owner's discovery is not disabled.");
  }
  const permissions = isObject(ledger.permissions) ? ledger.permissions : {};

  const pullRequests: StoredPullRequest[] = [];
  const findings: CanonicalFinding[] = [];
  const approvals: ImportedApproval[] = [];
  const merges: ImportedMerge[] = [];
  const jobs: ImportedJob[] = [];
  const receipts: Array<{ pullRequest: number; key: string }> = [];
  const findingIds = new Set<string>();

  const records = isObject(ledger.pullRequests) ? Object.entries(ledger.pullRequests) : [];
  for (const [key, value] of records) {
    if (!isObject(value)) {
      warnings.push(`Pull request entry ${key} is not an object; skipped.`);
      continue;
    }
    const number = int(value.number) ?? int(Number(key));
    const headSha = sha(value.headSha);
    const baseRef = str(value.baseRef);
    const baseSha = sha(value.actualBaseSha) ?? sha(value.githubBaseSha);
    if (
      number === null ||
      number <= 0 ||
      headSha === null ||
      baseRef === null ||
      baseSha === null
    ) {
      warnings.push(`Pull request ${key} lacks number, head, base ref or base SHA; skipped.`);
      continue;
    }
    const state =
      value.state === "open" || value.state === "merged" || value.state === "closed"
        ? value.state
        : null;
    if (state === null) {
      warnings.push(`Pull request ${number} has unknown state ${String(value.state)}; skipped.`);
      continue;
    }
    const revisions = Array.isArray(value.reviewedRevisions)
      ? value.reviewedRevisions.filter(isObject)
      : [];
    const lastRevision = revisions.at(-1);
    const reviewedHead = sha(value.reviewedHeadSha) ?? sha(lastRevision?.headSha);
    const reviewedBase = sha(value.reviewedBaseSha) ?? sha(lastRevision?.actualBaseSha);
    if (state === "open" && reviewedHead === null) {
      warnings.push(
        `Open pull request ${number} has no reviewed head; it will be reviewed again on resume.`,
      );
    }
    pullRequests.push({
      number,
      title: str(value.title) ?? `#${number}`,
      state,
      draft: value.draft === true,
      authorLogin: "",
      headRef: str(value.headRef) ?? "",
      headSha,
      baseRef,
      baseSha,
      mergeBaseSha: sha(value.mergeBaseSha) ?? "",
      // Empty, so the first poll after resume observes it in full.
      githubUpdatedAt: "",
      lastReviewedHeadSha: reviewedHead,
      lastReviewedBaseSha: reviewedBase,
      round: int(value.round) ?? revisions.length,
      blocker: null,
    });

    const handled = Array.isArray(value.handledAuthorEventIds) ? value.handledAuthorEventIds : [];
    for (const id of handled) {
      const text = idText(id);
      if (text !== null) receipts.push({ pullRequest: number, key: `gh:${text}` });
    }

    const prFindings = Array.isArray(value.findings) ? value.findings : [];
    prFindings.forEach((entry, index) => {
      if (!isObject(entry)) return;
      const url = str(entry.url);
      const commentId = idText(entry.commentId) ?? commentIdFromUrl(url);
      const id = str(entry.id) ?? (commentId === null ? null : `gh:${commentId}`);
      if (id === null) {
        warnings.push(`Finding ${index + 1} of #${number} has no id, comment id or URL; skipped.`);
        return;
      }
      if (findingIds.has(id)) {
        warnings.push(`Finding ${id} appears twice; kept the first.`);
        return;
      }
      findingIds.add(id);
      const rawPriority = str(entry.priority) as RepoReviewFindingPriority | null;
      const priority = rawPriority !== null && PRIORITIES.has(rawPriority) ? rawPriority : "P3";
      if (rawPriority === null || !PRIORITIES.has(rawPriority)) {
        warnings.push(`Finding ${id} has no valid priority; imported as P3.`);
      }
      const rawDisposition = str(entry.disposition) as RepoReviewFindingDisposition | null;
      // An unknown disposition stays open: it blocks landing until a review re-adjudicates it.
      const disposition =
        rawDisposition !== null && DISPOSITIONS.has(rawDisposition) ? rawDisposition : "open";
      if (rawDisposition === null || !DISPOSITIONS.has(rawDisposition)) {
        warnings.push(
          `Finding ${id} has disposition ${String(entry.disposition)}; imported as open.`,
        );
      }
      const title = str(entry.rootCause) ?? str(entry.title) ?? "Imported finding";
      const path = str(entry.path);
      findings.push({
        id,
        pullRequest: number,
        priority,
        title,
        path,
        line: int(entry.line),
        scenario: str(entry.scenario),
        impact: str(entry.impact),
        body: null,
        disposition,
        dedupKey: findingDedupKey(path, title),
        githubCommentId: commentId,
        githubThreadId: str(entry.threadId),
        url,
      });
      if (commentId !== null) receipts.push({ pullRequest: number, key: `gh:${commentId}` });
      for (const extra of [entry.confirmationUrl, entry.authorResponseUrl]) {
        const extraId = commentIdFromUrl(str(extra));
        if (extraId !== null) receipts.push({ pullRequest: number, key: `gh:${extraId}` });
      }
    });

    const approval = isObject(value.approval) ? value.approval : null;
    if (approval !== null) {
      const approvalId = idText(approval.id);
      const approvalHead = sha(approval.headSha);
      const approvalUrl = str(approval.url);
      const verified = approval.readbackVerified === true || approval.verified === true;
      if (
        approvalId !== null &&
        approvalHead !== null &&
        approvalUrl !== null &&
        verified &&
        approval.state === "APPROVED"
      ) {
        approvals.push({
          pullRequest: number,
          headSha: approvalHead,
          githubId: approvalId,
          url: approvalUrl,
        });
        receipts.push({ pullRequest: number, key: `gh:${approvalId}` });
      } else {
        warnings.push(
          `Approval on #${number} is not a verified exact-head approval; not imported.`,
        );
      }
    }

    const merge = isObject(value.merge) ? value.merge : null;
    if (merge !== null) {
      const mergeCommit = sha(merge.mergeCommit) ?? sha(merge.commitSha);
      const mergeHead = sha(merge.expectedHead) ?? sha(merge.headSha);
      if (merge.verified === true && mergeCommit !== null && mergeHead !== null) {
        merges.push({
          pullRequest: number,
          headSha: mergeHead,
          mergeCommitSha: mergeCommit,
          url: str(value.url) ?? "",
        });
      } else {
        warnings.push(`Merge of #${number} is not verified with commit and head; not imported.`);
      }
    }

    const rounds = new Map<number, ImportedJob>();
    for (const revision of revisions) {
      const round = int(revision.round);
      const head = sha(revision.headSha);
      if (round === null || head === null) continue;
      rounds.set(round, {
        pullRequest: number,
        round,
        headSha: head,
        baseRef,
        baseSha: sha(revision.actualBaseSha) ?? "",
        externalTaskId: null,
        threadId: null,
        verdict: str(revision.outcome),
      });
    }
    const history = Array.isArray(value.roundHistory) ? value.roundHistory.filter(isObject) : [];
    for (const entry of history) {
      const round = int(entry.round);
      if (round === null) continue;
      const result = isObject(entry.result) ? entry.result : {};
      const existing = rounds.get(round);
      rounds.set(round, {
        pullRequest: number,
        round,
        headSha: sha(result.headSha) ?? existing?.headSha ?? "",
        baseRef,
        baseSha: sha(result.actualBaseSha) ?? existing?.baseSha ?? "",
        externalTaskId: str(entry.taskId) ?? existing?.externalTaskId ?? null,
        threadId: existing?.threadId ?? null,
        verdict: existing?.verdict ?? str(result.status),
      });
    }
    const currentRound = int(value.round);
    if (currentRound !== null) {
      const existing = rounds.get(currentRound);
      rounds.set(currentRound, {
        pullRequest: number,
        round: currentRound,
        headSha: reviewedHead ?? existing?.headSha ?? headSha,
        baseRef,
        baseSha: reviewedBase ?? existing?.baseSha ?? baseSha,
        externalTaskId: str(value.taskId) ?? existing?.externalTaskId ?? null,
        threadId: str(value.childThreadId) ?? existing?.threadId ?? null,
        verdict: str(value.reviewStatus) ?? existing?.verdict ?? null,
      });
    }
    jobs.push(...[...rounds.values()].sort((a, b) => a.round - b.round));
  }

  const openPullRequests = pullRequests.filter((pr) => pr.state === "open").length;
  if (pullRequests.length === 0) blockers.push("Ledger has no importable pull requests.");
  if (openPullRequests > 0 && ledger.paused !== true) {
    blockers.push("Previous owner is not marked paused/resumable.");
  }

  return {
    repository,
    account,
    parentThreadId: str(ledger.parentThreadId),
    eventsBaselineAt: str(ledger.stoppedAt) ?? str(ledger.updatedAt),
    permissions: {
      post: permissions.post === true,
      approve: permissions.approve === true,
      merge: permissions.merge === true,
    },
    pullRequests,
    findings,
    approvals,
    merges,
    jobs,
    receipts,
    warnings,
    blockers,
  };
}
