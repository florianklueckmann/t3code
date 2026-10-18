import type { RepoReviewJobResult, RepoReviewJobTrigger } from "@t3tools/contracts";

import type { CanonicalFinding, JobPins } from "./decisions.ts";
import type { RepoReviewConversationEvent } from "./RepoReviewGitHub.ts";

const MAX_BODY_CHARS = 6_000;
const MAX_EVENT_CHARS = 1_500;
/**
 * Author events one brief carries, oldest first. The controller receipts only these; any newer
 * ones stay pending and start the next round.
 */
export const MAX_BRIEF_EVENTS = 20;

const clip = (text: string, limit: number) =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;

const TRIGGER_TEXT: Record<RepoReviewJobTrigger, string> = {
  new_pull_request: "First review of this pull request.",
  new_head: "The author pushed a new revision since the last review.",
  author_event: "The author responded since the last review at this head.",
  base_retarget: "The pull request now targets a different base branch.",
  integration_change: "The base branch moved in files this pull request changes.",
  requeue: "A maintainer requeued this review.",
};

export interface ReviewBriefInput {
  readonly job: JobPins & { readonly round: number; readonly trigger: RepoReviewJobTrigger };
  readonly host: string;
  readonly pullRequestUrl: string;
  readonly title: string;
  readonly body: string;
  readonly instructions: string;
  readonly findings: ReadonlyArray<CanonicalFinding>;
  readonly authorEvents: ReadonlyArray<RepoReviewConversationEvent>;
  readonly previous: {
    readonly headSha: string;
    readonly baseSha: string;
    readonly result: RepoReviewJobResult | null;
  } | null;
}

/**
 * The complete, self-contained prompt for one review job. Each round gets a fresh brief built from
 * durable state, never a chain of earlier prompts or a conversation's memory.
 */
export function buildReviewBrief(input: ReviewBriefInput): string {
  const { job } = input;
  const findings = input.findings.filter((finding) => finding.pullRequest === job.pullRequest);
  const findingLines =
    findings.length === 0
      ? ["None."]
      : findings.map(
          (finding) =>
            `- canonicalId \`${finding.id}\` — ${finding.disposition.toUpperCase()} [${finding.priority}] ${finding.title}` +
            `${finding.path === null ? "" : ` (${finding.path}${finding.line === null ? "" : `:${finding.line}`})`}` +
            `${finding.url === null ? "" : ` — ${finding.url}`}` +
            `${finding.scenario === null ? "" : `\n  Scenario: ${clip(finding.scenario, 600)}`}`,
        );
  const events = input.authorEvents.slice(0, MAX_BRIEF_EVENTS);
  const eventLines =
    events.length === 0
      ? ["None."]
      : events.map(
          (event) =>
            `- ${event.kind} by @${event.authorLogin} at ${event.createdAt} (${event.url}):\n  ${clip(event.body, MAX_EVENT_CHARS).replaceAll("\n", "\n  ")}`,
        );
  const previous = input.previous;
  const previousLines =
    previous === null
      ? ["No earlier review of this pull request."]
      : [
          `Last reviewed head ${previous.headSha} against base ${previous.baseSha}.`,
          previous.headSha === job.headSha
            ? "The head is unchanged since that review."
            : `Delta to inspect: \`git diff ${previous.headSha} ${job.headSha}\` (if that fails, the branch was rewritten: review the full effective diff).`,
          ...(previous.result === null
            ? []
            : [
                `Earlier verdict: ${previous.result.verdict}. Summary: ${clip(previous.result.summary, 1_500)}`,
                "Earlier evidence (reuse only for byte-identical files, never as fresh test results):",
                ...previous.result.evidence.map(
                  (evidence) =>
                    `- [${evidence.provenance}] ${evidence.kind}${evidence.outcome === undefined ? "" : ` → ${evidence.outcome}`}: ${clip(evidence.description, 300)}`,
                ),
              ]),
        ];

  return [
    `You are a finite, defect-first code review job for ${input.pullRequestUrl} (round ${job.round}). ${TRIGGER_TEXT[job.trigger]}`,
    "",
    "## Pins",
    `- Job id: \`${job.id}\``,
    `- Repository: ${input.host}/${job.repository}, pull request #${job.pullRequest}`,
    `- Head: \`${job.headSha}\``,
    `- Base: \`${job.baseRef}\` at \`${job.baseSha}\` (read from the branch, not the pull request)`,
    `- Merge-base: \`${job.mergeBaseSha}\``,
    "",
    "Your thread runs in its own isolated worktree. Check `git remote get-url origin` names this repository, then",
    `\`git fetch origin pull/${job.pullRequest}/head ${job.baseRef}\` and \`git checkout --detach ${job.headSha}\`. Verify the`,
    "head, base and merge-base above before you start and again before you submit. If they changed, stop and submit a",
    "`blocked` result naming what changed. Never touch other checkouts.",
    "",
    "## Intended behavior",
    `Title: ${input.title}`,
    clip(input.body.trim() === "" ? "(no description)" : input.body, MAX_BODY_CHARS),
    "",
    "## Canonical findings (one report per defect; reference them by canonicalId)",
    ...findingLines,
    "",
    "## Author activity since the last review",
    ...eventLines,
    "",
    "## Prior evidence and limits",
    ...previousLines,
    "",
    "## How to review",
    "Inspect the complete effective diff `git diff " +
      `${job.mergeBaseSha} ${job.headSha}` +
      "`, the call paths it affects and the relevant tests. Earlier coverage may be reused only for files whose blobs you prove identical (`git rev-parse <rev>:<path>`); list them in coverage.reusedUnchangedPaths. Report only concrete, introduced, actionable P0–P3 defects with a narrow file/line in the diff, a scenario and its impact. No style nits or speculation. Re-adjudicate every OPEN canonical finding as still_open, fixed (verified directly) or withdrawn. Do not report an open finding again as new.",
    ...(input.instructions.trim() === ""
      ? []
      : ["", "## Repository instructions", input.instructions.trim()]),
    "",
    "## Boundaries",
    "- Read-only review. No edits to repository source, docs or tests (not even temporary), no commits, pushes, rebases, conflict resolution or branch changes.",
    "- No GitHub writes of any kind: no comments, reviews, approvals, merges, labels or thread resolution. The controller publishes from your result.",
    "- No mutation of installed applications, desktops, accessibility permissions, signing identities, credentials, login items, global hotkeys or production data. Build artifacts and probes under a temporary directory are fine.",
    "- No delegation, watchers, schedules or polling loops. This job ends when you submit.",
    "",
    "## Evidence",
    "Label every piece of evidence: `fresh_reviewer_check` (you ran it now), `author_reported` (claimed by the author, not rerun) or `unrun` (relevant coverage nobody ran). Never describe unrun or author-reported checks as passing.",
    "",
    "## Submit",
    "Call the MCP tool `repo_review_submit_result` exactly once with the structured result for this job id and these exact pins. If it rejects the result, fix what it names and call it again. Then end your turn with a short summary.",
  ].join("\n");
}
