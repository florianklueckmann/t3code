/**
 * A direct task's work thread ends its result with a report line in a fixed shape. The server
 * checks only that the report names evidence and that what it names exists, never its content.
 */
import {
  type BotTaskAcceptance,
  type BotTaskEvidenceCheck,
  type BotTaskReport,
  BotTaskReportStatus,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const RESULT_MARKER = "T3_RESULT";

const RESULT_CHARS = 2_000;
const ITEM_CHARS = 300;
const ITEMS = 20;
const WAITING_CHARS = 400;

const ReportLine = Schema.Struct({
  result: Schema.String,
  status: BotTaskReportStatus,
  evidence: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
});
type ReportLine = typeof ReportLine.Type;
const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(ReportLine));

// Models sometimes put the report at the end of their last sentence instead of on its own line.
const reportLine = new RegExp(`^(.*?)[\\s\`]*\\b${RESULT_MARKER}\\b(.*?)[\\s\`]*$`);

const clip = (text: string, chars: number) => text.trim().slice(0, chars);
const items = (values: ReadonlyArray<string>) =>
  values
    .map((value) => clip(value, ITEM_CHARS))
    .filter((value) => value !== "")
    .slice(0, ITEMS);

/** The report that ends the result's last line, and the result without it. */
export function readResultReport(text: string): {
  readonly report: ReportLine | null;
  readonly text: string;
} {
  const lines = text.trimEnd().split("\n");
  const index = lines.length - 1;
  const [, before = "", json = ""] = reportLine.exec(lines[index] ?? "") ?? [];
  const report = decodeReport(json.trim());
  if (Option.isNone(report)) return { report: null, text };
  return {
    report: {
      result: clip(report.value.result, RESULT_CHARS),
      status: report.value.status,
      evidence: items(report.value.evidence),
      openQuestions: items(report.value.openQuestions),
    },
    text: lines.toSpliced(index, 1, before).join("\n").trim(),
  };
}

export type EvidenceItem =
  | { readonly kind: "branch" | "commit" | "file"; readonly target: string }
  | { readonly kind: "link" | "other" };

const KIND_PREFIX = /^(branch|commit|file|link)\s*[:=]\s*(.+)$/i;
const URL = /^https?:\/\/\S+$/i;
// `file: src/a.ts:42`, `src/a.ts:10-20` and `src/a.ts#L42` name the file.
const LINE_SUFFIX = /(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/;

/** What one evidence item names, from the kind it starts with. */
export function classifyEvidence(text: string): EvidenceItem {
  const match = KIND_PREFIX.exec(text.trim());
  if (match === null) return URL.test(text.trim()) ? { kind: "link" } : { kind: "other" };
  const kind = match[1]!.toLowerCase() as "branch" | "commit" | "file" | "link";
  const target = match[2]!.trim().replace(/^`+|`+$/g, "");
  if (kind === "link") return { kind: "link" };
  return { kind, target: kind === "file" ? target.replace(LINE_SUFFIX, "") : target };
}

/** The outcome from the report and each evidence item's check, in the report's order. */
export function decideAcceptance(
  report: ReportLine | null,
  checks: ReadonlyArray<BotTaskEvidenceCheck>,
): BotTaskAcceptance {
  if (report === null)
    return {
      state: "needs_you",
      missing: [`The result did not end with a ${RESULT_MARKER} line in the fixed shape.`],
      report: null,
    };
  const evidence = report.evidence.map((text, index) => ({
    text,
    check: checks[index] ?? "unchecked",
  }));
  const missing = [
    ...(report.status === "done"
      ? []
      : [`The work thread reported its status as ${report.status}.`]),
    ...(evidence.length === 0 ? ["The result names no evidence."] : []),
    ...evidence
      .filter((item) => item.check === "missing")
      .map((item) => `“${item.text}” does not exist.`),
  ];
  const full: BotTaskReport = { ...report, evidence };
  return {
    state: missing.length === 0 && report.openQuestions.length === 0 ? "done" : "needs_you",
    missing,
    report: full,
  };
}

export function evidenceSummary(acceptance: BotTaskAcceptance): string {
  const evidence = acceptance.report?.evidence ?? [];
  if (!evidence.length) return "none cited";
  return evidence
    .map(
      ({ text, check }) =>
        `${text} (${check === "found" ? "exists" : check === "link" ? "link, unchecked" : check})`,
    )
    .join(", ");
}

/** One Waiting item for a result that needs the user: what is missing, then its questions. */
export function waitingText(title: string, acceptance: BotTaskAcceptance): string {
  const questions = acceptance.report?.openQuestions ?? [];
  const parts = [
    acceptance.missing.length === 0
      ? `“${title}” finished with open questions.`
      : `“${title}” is not done: ${acceptance.missing.join(" ")}`,
    questions.length === 0 ? null : `Questions: ${questions.join(" ")}`,
  ].filter((part) => part !== null);
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text.length <= WAITING_CHARS ? text : `${text.slice(0, WAITING_CHARS - 1)}…`;
}

/** How a direct task's work thread reports its result. Model-facing. */
export const resultInstructions: ReadonlyArray<string> = [
  "- The brief says what counts as done. If it does not, decide from the brief what would, and say so in the result.",
  `- End your final message with a ${RESULT_MARKER} line as its very last line, after your answer: ${RESULT_MARKER} {"result": "<what you did or found, in one or two sentences>", "status": "<done, partial or blocked>", "evidence": ["<each thing that shows the result>"], "openQuestions": ["<each question only the user can answer, one sentence each>"]}`,
  '- Write each evidence item as "branch: <name>", "commit: <sha>", "file: <path>" or "link: <url>": the branch and commit with your changes, files you wrote or read your findings from, or a link to what you made. T3 Code checks that each branch, commit and file exists. A result with no evidence, or naming one that does not exist, is shown to the user as not done.',
  '- Use "done" only when what counts as done is met. Use "partial" or "blocked" otherwise, and put what you need from the user in openQuestions. Use an empty list when there is nothing to ask.',
];

export class BotTaskEvidence extends Context.Service<
  BotTaskEvidence,
  {
    /**
     * Whether each item exists, in the work thread's worktree, or the project folder when the task
     * had none. Reads only Git refs, objects and file paths; never fetches a link.
     */
    readonly check: (input: {
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
      readonly items: ReadonlyArray<EvidenceItem>;
    }) => Effect.Effect<ReadonlyArray<BotTaskEvidenceCheck>>;
  }
>()("t3/bots/BotTaskAcceptance/BotTaskEvidence") {}

const COMMIT = /^[0-9a-f]{7,40}$/i;

export const layer = Layer.effect(
  BotTaskEvidence,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const projects = yield* ProjectService.ProjectService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
    const resolves = (cwd: string, args: ReadonlyArray<string>) =>
      git.execute({ operation: "BotTaskEvidence.check", cwd, args, allowNonZeroExit: true }).pipe(
        Effect.map((result) => result.exitCode === 0),
        Effect.orElseSucceed(() => false),
      );

    const check: BotTaskEvidence["Service"]["check"] = Effect.fn("BotTaskEvidence.check")(
      function* (input) {
        const worktree =
          input.worktreePath !== null && (yield* exists(input.worktreePath))
            ? input.worktreePath
            : null;
        const cwd =
          worktree ??
          (yield* projects.getById(input.projectId).pipe(
            Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot ?? null),
            Effect.orElseSucceed(() => null),
          ));
        return yield* Effect.forEach(input.items, (item): Effect.Effect<BotTaskEvidenceCheck> => {
          if (!("target" in item))
            return Effect.succeed(item.kind === "link" ? "link" : "unchecked");
          if (cwd === null || item.target === "" || item.target.startsWith("-"))
            return Effect.succeed("missing");
          const found =
            item.kind === "file"
              ? exists(path.resolve(cwd, item.target))
              : item.kind === "commit"
                ? COMMIT.test(item.target)
                  ? resolves(cwd, ["rev-parse", "--verify", "--quiet", `${item.target}^{commit}`])
                  : Effect.succeed(false)
                : // A branch is a local or remote-tracking ref, never HEAD, a tag or a commit.
                  Effect.forEach(
                    [`refs/heads/${item.target}`, `refs/remotes/${item.target}`],
                    (ref) => resolves(cwd, ["show-ref", "--verify", "--quiet", ref]),
                  ).pipe(Effect.map((refs) => refs.some(Boolean)));
          return found.pipe(Effect.map((ok) => (ok ? "found" : "missing")));
        });
      },
    );
    return BotTaskEvidence.of({ check });
  }),
);
