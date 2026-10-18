import { describe, expect, it } from "vite-plus/test";
import type { RepoReviewJobResult, RepoReviewPolicy } from "@t3tools/contracts";

import {
  applyResult,
  assessLanding,
  type CanonicalFinding,
  type EventContext,
  type JobPins,
  type LandingSnapshot,
  publicationMarker,
  reconcilePullRequest,
  type StoredPullRequest,
  validateResult,
} from "./decisions.ts";
import type {
  RepoReviewConversationEvent,
  RepoReviewPullRequestDetail,
} from "./RepoReviewGitHub.ts";

const HEAD = "a".repeat(40);
const HEAD2 = "b".repeat(40);
const BASE = "c".repeat(40);
const BASE2 = "d".repeat(40);
const MERGE_BASE = "e".repeat(40);

const policy: RepoReviewPolicy = {
  postFindings: true,
  approve: true,
  merge: true,
  mergeMethod: "merge",
  reviewDrafts: false,
  modelSelection: { instanceId: "codex" as never, model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
  maxConcurrentJobs: 2,
  pollIntervalSeconds: 300,
  jobTimeoutMinutes: 60,
  commentPrefix: "Hey, this is a review bot.",
  instructions: "",
};

const detail = (
  overrides: Partial<RepoReviewPullRequestDetail> = {},
): RepoReviewPullRequestDetail => ({
  number: 7,
  url: "https://github.com/acme/widgets/pull/7",
  title: "Add widgets",
  body: "",
  state: "open",
  draft: false,
  authorLogin: "octo",
  headRef: "feature/widgets",
  headSha: HEAD,
  headRepository: "acme/widgets",
  baseRef: "main",
  githubBaseSha: BASE,
  updatedAt: "2026-10-18T10:00:00Z",
  mergeable: true,
  mergeableState: "clean",
  mergeCommitSha: null,
  mergedBy: null,
  ...overrides,
});

const event = (
  overrides: Partial<RepoReviewConversationEvent> = {},
): RepoReviewConversationEvent => ({
  keys: ["gh:IC_1", "gh:1"],
  kind: "issue_comment",
  githubId: "1",
  authorLogin: "octo",
  authorIsBot: false,
  createdAt: "2026-10-18T11:00:00Z",
  url: "https://github.com/acme/widgets/pull/7#issuecomment-1",
  body: "I fixed it.",
  reviewState: null,
  commitId: null,
  ...overrides,
});

const reviewed: StoredPullRequest = {
  number: 7,
  title: "Add widgets",
  state: "open",
  draft: false,
  authorLogin: "octo",
  headRef: "feature/widgets",
  headSha: HEAD,
  baseRef: "main",
  baseSha: BASE,
  mergeBaseSha: MERGE_BASE,
  githubUpdatedAt: "2026-10-18T10:00:00Z",
  lastReviewedHeadSha: HEAD,
  lastReviewedBaseSha: BASE,
  round: 1,
  blocker: null,
};

// The posting account is also the pull request author, as on a personal repository.
const context = (overrides: Partial<EventContext> = {}): EventContext => ({
  handledKeys: new Set(),
  account: "octo",
  commentPrefix: policy.commentPrefix,
  baselineAt: null,
  ...overrides,
});

const reconcile = (input: {
  stored?: StoredPullRequest | null;
  detail?: RepoReviewPullRequestDetail;
  baseSha?: string;
  events?: ReadonlyArray<RepoReviewConversationEvent>;
  context?: EventContext;
  activeJob?: Parameters<typeof reconcilePullRequest>[0]["activeJob"];
  latestJob?: Parameters<typeof reconcilePullRequest>[0]["latestJob"];
  reviewDrafts?: boolean;
}) =>
  reconcilePullRequest({
    stored: input.stored === undefined ? reviewed : input.stored,
    observation: {
      detail: input.detail ?? detail(),
      baseSha: input.baseSha ?? BASE,
      mergeBaseSha: MERGE_BASE,
      events: input.events ?? [],
    },
    events: input.context ?? context(),
    policy: { reviewDrafts: input.reviewDrafts ?? false },
    activeJob: input.activeJob ?? null,
    latestJob: input.latestJob ?? null,
  });

describe("reconcilePullRequest", () => {
  it("queues the first review of a new pull request", () => {
    expect(reconcile({ stored: null }).enqueue).toBe("new_pull_request");
  });

  it("does nothing for an unchanged reviewed pull request, a moving base or handled events", () => {
    expect(reconcile({}).enqueue).toBeNull();
    expect(reconcile({ baseSha: BASE2 }).enqueue).toBeNull();
    const handled = reconcile({
      events: [event()],
      context: context({ handledKeys: new Set(["gh:1"]) }),
    });
    expect(handled.enqueue).toBeNull();
    expect(handled.receipts).toEqual([]);
  });

  it("treats our marked or prefixed comments as our own even when the author is the same account", () => {
    const own = reconcile({
      events: [
        event({ body: `Finding ${publicationMarker("finding:x")}`, keys: ["gh:IC_2", "gh:2"] }),
        event({ body: `${policy.commentPrefix}\n\nAll good.`, keys: ["gh:IC_3", "gh:3"] }),
      ],
    });
    expect(own.enqueue).toBeNull();
    expect(own.receipts.map((receipt) => receipt.disposition)).toEqual(["own", "own"]);
    // The posting account replying without our marker is the author speaking.
    expect(reconcile({ events: [event()] }).enqueue).toBe("author_event");
    // Someone else quoting our marker is still someone else.
    const quoted = event({
      authorLogin: "contributor",
      body: `> ${publicationMarker("finding:x")}\n\nStill crashes with this input.`,
    });
    expect(reconcile({ events: [quoted] }).enqueue).toBe("author_event");
  });

  it("ignores bots and history from before an import baseline", () => {
    const result = reconcile({
      events: [
        event({ authorIsBot: true, authorLogin: "ci[bot]" }),
        event({ keys: ["gh:IC_9", "gh:9"], createdAt: "2026-10-01T00:00:00Z" }),
      ],
      context: context({ baselineAt: "2026-10-02T00:00:00Z" }),
    });
    expect(result.enqueue).toBeNull();
    expect(result.receipts.map((receipt) => receipt.disposition)).toEqual(["bot", "baseline"]);
  });

  it("supersedes an in-flight review when the head moves, and cancels it when the pull request closes", () => {
    const moved = reconcile({
      detail: detail({ headSha: HEAD2 }),
      activeJob: { id: "job-1", headSha: HEAD, baseRef: "main", status: "running" },
    });
    expect(moved.enqueue).toBe("new_head");
    expect(moved.cancelJob?.id).toBe("job-1");
    const closed = reconcile({
      detail: detail({ state: "merged" }),
      activeJob: { id: "job-1", headSha: HEAD, baseRef: "main", status: "queued" },
    });
    expect(closed.enqueue).toBeNull();
    expect(closed.cancelJob?.reason).toBe("Pull request merged.");
  });

  it("leaves a review in flight alone and keeps author events for after it", () => {
    const result = reconcile({
      events: [event()],
      activeJob: { id: "job-1", headSha: HEAD, baseRef: "main", status: "running" },
    });
    expect(result.enqueue).toBeNull();
    expect(result.receipts).toEqual([]);
  });

  it("does not retry a failed review at the same head on its own", () => {
    const result = reconcile({
      stored: { ...reviewed, lastReviewedHeadSha: null },
      latestJob: { id: "job-1", headSha: HEAD, baseRef: "main", status: "failed" },
    });
    expect(result.enqueue).toBeNull();
    expect(result.pullRequest.blocker).toContain("requeue");
    const replied = reconcile({
      stored: { ...reviewed, lastReviewedHeadSha: null },
      events: [event()],
      latestJob: { id: "job-1", headSha: HEAD, baseRef: "main", status: "failed" },
    });
    expect(replied.enqueue).toBe("author_event");
  });

  it("skips drafts unless drafts are reviewed, and reviews a retargeted base", () => {
    expect(reconcile({ stored: null, detail: detail({ draft: true }) }).enqueue).toBeNull();
    expect(
      reconcile({ stored: null, detail: detail({ draft: true }), reviewDrafts: true }).enqueue,
    ).toBe("new_pull_request");
    expect(reconcile({ detail: detail({ baseRef: "release" }) }).enqueue).toBe("base_retarget");
    // A review cancelled because of the retarget does not suppress the replacement.
    const cancelledByRetarget = reconcile({
      stored: { ...reviewed, lastReviewedHeadSha: null },
      detail: detail({ baseRef: "release" }),
      latestJob: { id: "job-1", headSha: HEAD, baseRef: "main", status: "cancelled" },
    });
    expect(cancelledByRetarget.enqueue).toBe("base_retarget");
  });
});

const job: JobPins = {
  id: "owner:pr-7:r2",
  repository: "acme/widgets",
  pullRequest: 7,
  headSha: HEAD,
  baseRef: "main",
  baseSha: BASE,
  mergeBaseSha: MERGE_BASE,
};

const openFinding: CanonicalFinding = {
  id: "gh:100",
  pullRequest: 7,
  priority: "P1",
  title: "Null deref in parser",
  path: "src/parse.ts",
  line: 10,
  scenario: "Empty input",
  impact: "Crash",
  body: null,
  disposition: "open",
  dedupKey: "src/parse.ts::null deref in parser",
  githubCommentId: "100",
  githubThreadId: "PRRT_1",
  url: "https://github.com/acme/widgets/pull/7#discussion_r100",
};

const result = (overrides: Partial<RepoReviewJobResult> = {}): RepoReviewJobResult => ({
  jobId: job.id as RepoReviewJobResult["jobId"],
  repository: "acme/widgets",
  pullRequest: 7,
  pins: { headSha: HEAD, baseRef: "main", baseSha: BASE, mergeBaseSha: MERGE_BASE },
  verdict: "clean",
  summary: "No findings.",
  findings: [{ canonicalId: openFinding.id, status: "fixed", evidence: "Re-ran parser test." }],
  evidence: [
    { provenance: "fresh_reviewer_check", kind: "unit", description: "vp test", outcome: "passed" },
  ],
  coverage: {
    effectiveDiffInspected: true,
    filesInspected: 3,
    reusedUnchangedPaths: [],
    notes: "",
  },
  ...overrides,
});

describe("validateResult", () => {
  it("accepts a result tied to the job that re-adjudicates every open finding", () => {
    expect(validateResult(result(), job, [openFinding])).toEqual([]);
  });

  it("rejects wrong pins, repository or job, and unadjudicated findings", () => {
    const problems = validateResult(
      result({
        jobId: "other" as RepoReviewJobResult["jobId"],
        repository: "acme/other",
        pins: { headSha: HEAD2, baseRef: "main", baseSha: BASE2, mergeBaseSha: MERGE_BASE },
        findings: [],
      }),
      job,
      [openFinding],
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        `jobId must be ${job.id}.`,
        "repository must be acme/widgets.",
        `pins.headSha must be ${HEAD}.`,
        `pins.baseSha must be ${BASE}.`,
        "Open finding gh:100 must be re-adjudicated (still_open, fixed or withdrawn).",
      ]),
    );
  });

  it("rejects an inconsistent verdict and incomplete new findings", () => {
    expect(
      validateResult(
        result({ findings: [{ canonicalId: openFinding.id, status: "still_open" }] }),
        job,
        [openFinding],
      ),
    ).toContain("A clean verdict cannot carry new or still-open findings.");
    expect(
      validateResult(
        result({
          verdict: "findings",
          findings: [
            { canonicalId: openFinding.id, status: "fixed" },
            { status: "new", title: "x" },
          ],
        }),
        job,
        [openFinding],
      ),
    ).toEqual(expect.arrayContaining(["findings[1]: a new finding needs path."]));
  });
});

describe("applyResult", () => {
  const apply = (input: Partial<Parameters<typeof applyResult>[0]> = {}) =>
    applyResult({
      ownerId: "owner",
      job,
      result: result(),
      current: { state: "open", headSha: HEAD, baseRef: "main" },
      findings: [openFinding],
      policy,
      commentPrefix: policy.commentPrefix,
      ...input,
    });

  it("authorizes nothing when the head moved during the review", () => {
    const stale = apply({ current: { state: "open", headSha: HEAD2, baseRef: "main" } });
    expect(stale.jobStatus).toBe("stale");
    expect(stale.publications).toEqual([]);
    expect(stale.dispositionChanges).toEqual([]);
    const retargeted = apply({ current: { state: "open", headSha: HEAD, baseRef: "release" } });
    expect(retargeted.jobStatus).toBe("stale");
    expect(retargeted.publications).toEqual([]);
  });

  it("reopens a resolved finding the review reports as still open", () => {
    const reopened = apply({
      findings: [{ ...openFinding, disposition: "fixed" }],
      result: result({
        verdict: "findings",
        findings: [{ canonicalId: openFinding.id, status: "still_open" }],
      }),
    });
    expect(reopened.dispositionChanges).toEqual([{ id: "gh:100", disposition: "open" }]);
    expect(reopened.publications).toEqual([]);
  });

  it("plans an exact-head approval and merge for a clean result", () => {
    const clean = apply();
    expect(clean.dispositionChanges).toEqual([{ id: "gh:100", disposition: "fixed" }]);
    // A draft gets the merge intent too; landing holds it until the pull request is ready.
    expect(clean.publications.map((publication) => publication.id)).toEqual([
      `approval:owner:7:${HEAD}`,
      `merge:owner:7:${HEAD}`,
    ]);
  });

  it("posts a genuinely new finding once and folds a re-reported open one into its canonical report", () => {
    const findings = apply({
      result: result({
        verdict: "findings",
        findings: [
          { canonicalId: openFinding.id, status: "still_open" },
          {
            status: "new",
            priority: "P2",
            title: "Null deref in parser",
            path: "src/parse.ts",
            line: 12,
            scenario: "s",
            impact: "i",
            body: "b",
          },
          {
            status: "new",
            priority: "P2",
            title: "Leaks file handle",
            path: "src/io.ts",
            line: 3,
            scenario: "s",
            impact: "i",
            body: "Close it.",
          },
        ],
      }),
    });
    expect(findings.newFindings.map((finding) => finding.title)).toEqual(["Leaks file handle"]);
    expect(findings.publications).toHaveLength(1);
    const comment = findings.publications[0]!;
    expect(comment.payload.kind === "finding_comment" && comment.payload.body).toContain(
      publicationMarker(comment.id),
    );
  });

  it("fails a blocked review without reviewing the head", () => {
    const blocked = apply({
      result: result({ verdict: "blocked", blockedReason: "Could not fetch." }),
    });
    expect(blocked.jobStatus).toBe("failed");
    expect(blocked.reviewedHead).toBe(false);
  });
});

describe("assessLanding", () => {
  const snapshot = (overrides: Partial<LandingSnapshot> = {}): LandingSnapshot => ({
    detail: detail(),
    baseSha: BASE,
    events: [],
    threads: [],
    allowedMergeMethods: ["merge"],
    viewerLogin: "reviewer",
    ...overrides,
  });
  const assess = (
    kind: "approval" | "merge",
    overrides: Partial<LandingSnapshot> = {},
    findings: CanonicalFinding[] = [],
  ) =>
    assessLanding({
      kind,
      expectedHeadSha: HEAD,
      expectedBaseRef: "main",
      expectedBaseSha: BASE,
      policy,
      snapshot: snapshot(overrides),
      ownFindings: findings,
    });

  it("proceeds only on the exact reviewed head and base", () => {
    expect(assess("merge")).toEqual({ type: "proceed" });
    expect(assess("merge", { detail: detail({ headSha: HEAD2 }) }).type).toBe("cancel");
    expect(assess("approval", { baseSha: BASE2 }).type).toBe("needs_integration_review");
    expect(assess("merge", { detail: detail({ baseRef: "release" }) }).type).toBe("cancel");
  });

  it("records an equivalent exact-head approval instead of approving again", () => {
    const existing = event({
      kind: "review",
      authorLogin: "reviewer",
      reviewState: "APPROVED",
      commitId: HEAD,
      githubId: "55",
      url: "https://github.com/acme/widgets/pull/7#pullrequestreview-55",
    });
    expect(assess("approval", { events: [existing] })).toMatchObject({
      type: "already_done",
      githubId: "55",
    });
    // An approval of an older head is not equivalent.
    expect(assess("approval", { events: [{ ...existing, commitId: HEAD2 }] }).type).toBe("proceed");
  });

  it("holds approvals for requested changes and unresolved threads, but not for GitHub's merge state or drafts", () => {
    const changes = event({
      kind: "review",
      authorLogin: "maintainer",
      reviewState: "CHANGES_REQUESTED",
    });
    expect(assess("approval", { events: [changes] }).type).toBe("blocked");
    expect(
      assess("approval", { threads: [{ id: "T", isResolved: false, rootCommentId: "9" }] }).type,
    ).toBe("blocked");
    expect(
      assess("approval", { detail: detail({ mergeableState: "blocked", draft: true }) }).type,
    ).toBe("proceed");
  });

  it("holds merges for requested changes, unresolved threads, GitHub blockers, drafts and disallowed methods", () => {
    const changes = event({
      kind: "review",
      authorLogin: "maintainer",
      reviewState: "CHANGES_REQUESTED",
    });
    expect(assess("merge", { events: [changes] }).type).toBe("blocked");
    // A later approval by the same reviewer supersedes their requested changes.
    expect(
      assess("merge", { events: [changes, { ...changes, reviewState: "APPROVED" }] }).type,
    ).toBe("proceed");
    expect(
      assess("merge", { threads: [{ id: "T", isResolved: false, rootCommentId: "999" }] }).type,
    ).toBe("blocked");
    expect(
      assess("merge", { threads: [{ id: "T", isResolved: false, rootCommentId: "100" }] }, [
        { ...openFinding, disposition: "fixed" },
      ]).type,
    ).toBe("proceed");
    expect(assess("merge", { detail: detail({ mergeableState: "blocked" }) }).type).toBe("blocked");
    expect(assess("merge", { detail: detail({ mergeableState: "behind" }) }).type).toBe("blocked");
    expect(assess("merge", { detail: detail({ draft: true }) }).type).toBe("blocked");
    expect(assess("merge", { allowedMergeMethods: ["squash"] }).type).toBe("blocked");
    expect(assess("merge", {}, [openFinding]).type).toBe("cancel");
  });

  it("counts only our own merge of the reviewed head as done", () => {
    const merged = detail({
      state: "merged",
      mergeCommitSha: "f".repeat(40),
      mergedBy: "reviewer",
    });
    expect(assess("merge", { detail: merged }).type).toBe("already_done");
    expect(assess("merge", { detail: { ...merged, mergedBy: "someone" } }).type).toBe("cancel");
  });
});
