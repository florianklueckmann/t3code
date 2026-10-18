import { describe, expect, it } from "vite-plus/test";

import { planLedgerImport } from "./ledgerImport.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const ledger = (pullRequest: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  schema: 1,
  repository: "acme/widgets",
  account: "reviewer",
  status: "stopped",
  paused: true,
  stoppedAt: "2026-10-18T16:30:45Z",
  discovery: { enabled: false },
  pullRequests: {
    "7": {
      number: 7,
      state: "open",
      headSha: HEAD,
      baseRef: "main",
      actualBaseSha: BASE,
      ...pullRequest,
    },
  },
  ...overrides,
});

describe("planLedgerImport", () => {
  it("derives canonical ids from explicit ids, comment ids or comment URLs", () => {
    const plan = planLedgerImport(
      ledger({
        findings: [
          {
            id: "pr7-r1-null",
            priority: "P1",
            rootCause: "Null",
            disposition: "fixed",
            commentId: 1,
          },
          { priority: "P2", rootCause: "Leak", disposition: "open", commentId: 2 },
          {
            rootCause: "Docs",
            disposition: "fixed",
            url: "https://github.com/acme/widgets/pull/7#issuecomment-3",
          },
        ],
      }),
    );
    expect(plan.findings.map((finding) => [finding.id, finding.githubCommentId])).toEqual([
      ["pr7-r1-null", "1"],
      ["gh:2", "2"],
      ["gh:3", "3"],
    ]);
    expect(plan.warnings).toContain("Finding gh:3 has no valid priority; imported as P3.");
    expect(plan.receipts.map((receipt) => receipt.key)).toEqual(["gh:1", "gh:2", "gh:3"]);
  });

  it("keeps an unknown disposition open so it still blocks landing", () => {
    const plan = planLedgerImport(
      ledger({
        findings: [{ priority: "P2", rootCause: "Race", disposition: "maybe", commentId: 9 }],
      }),
    );
    expect(plan.findings[0]!.disposition).toBe("open");
  });

  it("imports only verified exact-head approvals and merges", () => {
    const verified = planLedgerImport(
      ledger({
        state: "merged",
        approval: { id: 5, state: "APPROVED", headSha: HEAD, url: "https://x/5", verified: true },
        merge: { verified: true, commitSha: "c".repeat(40), headSha: HEAD },
      }),
    );
    expect(verified.approvals).toHaveLength(1);
    expect(verified.merges).toHaveLength(1);
    const unverified = planLedgerImport(
      ledger({
        state: "merged",
        approval: { id: 5, state: "APPROVED", headSha: HEAD, url: "https://x/5" },
        merge: { mergeCommit: "c".repeat(40) },
      }),
    );
    expect(unverified.approvals).toEqual([]);
    expect(unverified.merges).toEqual([]);
    expect(unverified.warnings).toEqual([
      "Approval on #7 is not a verified exact-head approval; not imported.",
      "Merge of #7 is not verified with commit and head; not imported.",
    ]);
  });

  it("keeps task ids as external history for every round it can place", () => {
    const plan = planLedgerImport(
      ledger({
        round: 2,
        reviewedHeadSha: HEAD,
        taskId: "task-2",
        childThreadId: "thread-2",
        roundHistory: [{ round: 1, taskId: "task-1", result: { headSha: "d".repeat(40) } }],
      }),
    );
    expect(plan.jobs.map((job) => [job.round, job.externalTaskId, job.threadId])).toEqual([
      [1, "task-1", null],
      [2, "task-2", "thread-2"],
    ]);
  });

  it("blocks an import while the previous owner may still act", () => {
    expect(planLedgerImport(ledger({}, { status: "watching" })).blockers).toContain(
      "Previous owner status is watching; stop it first.",
    );
    expect(planLedgerImport(ledger({}, { paused: false })).blockers).toContain(
      "Previous owner is not marked paused/resumable.",
    );
    expect(planLedgerImport({ schema: 2 }).blockers).toEqual(
      expect.arrayContaining([
        "Ledger schema is not 1.",
        "Ledger has no importable pull requests.",
      ]),
    );
  });
});
