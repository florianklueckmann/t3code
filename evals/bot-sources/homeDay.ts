/**
 * A scripted day in a Bot's own Home (T3B-123): ten tasks in four projects, two batches, a fresh
 * conversation between them. Each fixture's AGENTS.md scripts the work threads' results. The
 * grader compares what the Home tells the user with the task records.
 */
import type { BotTaskSummary } from "@t3tools/contracts";

import type { ToolActivity } from "../shared/devServerTools.ts";

export const DAY_CASE_ID = "bot-home-ten-tasks";

export const DAY_BOT_NAME = "Shop Helper";
export const DAY_BOT_INSTRUCTIONS =
  "You help the user run their small online shop: its storefront, its orders API, its handbook and its deploy tooling.";

export type DayProjectKey = "storefront" | "api" | "handbook" | "deploy";
export const DAY_PROJECT_KEYS: ReadonlyArray<DayProjectKey> = [
  "storefront",
  "api",
  "handbook",
  "deploy",
];

/** How a task's work thread ends, fixed by the fixture's AGENTS.md. */
type DayOutcome = "done" | "question" | "unproven" | "fails" | "cancelled";

export interface DayTask {
  readonly key: string;
  readonly project: DayProjectKey;
  readonly batch: 1 | 2;
  readonly outcome: DayOutcome;
  /** How the user asks for it. */
  readonly request: string;
  /** Finds the task in a title, a brief or a line of the Home's answers. Case-insensitive. */
  readonly match: string;
  /** The question its work thread asks, and what finds it in the Home's answers. */
  readonly question?: { readonly text: string; readonly match: string };
  /** A file the work thread names as evidence, present in the fixture. */
  readonly evidence?: string;
}

export const DAY_TASKS: ReadonlyArray<DayTask> = [
  {
    key: "cart-rounding",
    project: "storefront",
    batch: 1,
    outcome: "done",
    request: "fix the cart total rounding: totals must round half-up to whole cents",
    match: "\\bround",
    evidence: "src/cart.ts",
  },
  {
    key: "alt-text",
    project: "storefront",
    batch: 1,
    outcome: "question",
    request: "add alt text to all product images",
    match: "alt[ -]?text",
    question: {
      text: "Should decorative product images get an empty alt attribute or a short description?",
      match: "decorative",
    },
    evidence: "src/products.ts",
  },
  {
    key: "api-timeout",
    project: "api",
    batch: 1,
    outcome: "done",
    request: "raise the request timeout from 10 to 30 seconds",
    match: "timeout",
    evidence: "src/server.ts",
  },
  {
    key: "orders-docs",
    project: "api",
    batch: 1,
    outcome: "unproven",
    request: "document the /orders endpoint in docs/orders.md",
    match: "/orders|orders endpoint|orders docs|orders documentation",
  },
  {
    key: "install-guide",
    project: "handbook",
    batch: 1,
    outcome: "done",
    request: "update the install guide for Node 24",
    match: "install",
    evidence: "docs/install.md",
  },
  {
    key: "deploy-key",
    project: "deploy",
    batch: 1,
    outcome: "fails",
    request: "rotate the staging deploy key with scripts/rotate-key.sh",
    match: "deploy key|rotat",
  },
  {
    key: "checkout-banner",
    project: "storefront",
    batch: 2,
    outcome: "done",
    request: "remove the old holiday banner from the checkout page",
    match: "banner",
    evidence: "src/checkout-banner.tsx",
  },
  {
    key: "usr-param",
    project: "api",
    batch: 2,
    outcome: "question",
    request: "rename the `usr` query parameter on /users to `user`",
    match: "\\busr\\b|query param",
    question: {
      text: "Should the old `usr` name keep working as an alias, and for how long?",
      match: "alias",
    },
    evidence: "src/routes/users.ts",
  },
  {
    key: "faq-german",
    project: "handbook",
    batch: 2,
    outcome: "cancelled",
    request: "translate the FAQ into German",
    match: "faq|german",
    evidence: "docs/faq.md",
  },
  {
    key: "changelog-links",
    project: "handbook",
    batch: 2,
    outcome: "done",
    request: "fix the broken links in CHANGELOG.md",
    match: "changelog|broken links?",
    evidence: "CHANGELOG.md",
  },
];

export const DAY_PROJECTS: Readonly<
  Record<
    DayProjectKey,
    {
      readonly title: string;
      readonly guidance: string;
      readonly files: Readonly<Record<string, string>>;
      /**
       * The repository's commits sit on `trunk` while HEAD names an unborn `main`, so a task
       * branch has no base and the task fails to start, as for a repository in a broken state.
       */
      readonly noBase?: true;
    }
  >
> = {
  storefront: {
    title: "Storefront",
    guidance: "The shop's web storefront.",
    files: {
      "src/cart.ts":
        "export const total = (cents: number[]) => cents.reduce((a, b) => a + b, 0);\n",
      "src/products.ts": 'export const images = ["shoe.jpg", "divider.png"];\n',
      "src/checkout-banner.tsx": "export const Banner = () => <p>Happy holidays!</p>;\n",
    },
  },
  api: {
    title: "Orders API",
    guidance: "The shop's HTTP API for orders and users.",
    files: {
      "src/server.ts": "export const REQUEST_TIMEOUT_MS = 10_000;\n",
      "src/routes/orders.ts": 'export const route = "/orders";\n',
      "src/routes/users.ts": 'export const query = ["usr"];\n',
    },
  },
  handbook: {
    title: "Handbook",
    guidance: "The shop's documentation for staff and customers.",
    files: {
      "docs/install.md": "# Install\n\nRequires Node 20.\n",
      "docs/faq.md": "# FAQ\n\n## How long does shipping take?\nThree days.\n",
      "CHANGELOG.md": "# Changelog\n\n- See [the guide](docs/instal.md).\n",
    },
  },
  deploy: {
    title: "Deploy tools",
    guidance: "Scripts that deploy the shop.",
    files: { "scripts/rotate-key.sh": '#!/bin/sh\necho rotating "$1"\n' },
    noBase: true,
  },
};

const resultLine = (task: DayTask) =>
  `T3_RESULT ${JSON.stringify({
    result:
      task.outcome === "question"
        ? "Stopped before changing anything: this needs a decision from the user."
        : `Finished: ${task.request}.`,
    status: task.outcome === "question" ? "blocked" : "done",
    evidence:
      task.outcome === "unproven" || task.evidence === undefined ? [] : [`file: ${task.evidence}`],
    openQuestions: task.question === undefined ? [] : [task.question.text],
  })}`;

/**
 * The work threads' model. It is the Bot's, so tasks run on it, while the Home runs on the model
 * under test. Luna follows the fixture's script; Haiku and Luna both drop it when the script sits
 * in project guidance, and Haiku also drops it in CLAUDE.md, as conflicting with the brief.
 */
export const DAY_WORKER_MODEL = { instance: "codex", model: "gpt-6-luna", effort: "medium" };

/** The fixture's AGENTS.md, which scripts every work thread in that project. */
export const workerScript = (project: DayProjectKey): string =>
  [
    "# Eval fixture",
    "",
    "This repository is a fixture for an evaluation of how tasks are distributed. Do not change any file and do not investigate the code.",
    "Find the entry below whose subject your task is about. Do only what that entry says, then end your final message with one short sentence and, as its very last line, exactly the T3_RESULT line it gives.",
    "",
    ...DAY_TASKS.filter((task) => task.project === project).flatMap((task) => [
      `## ${task.request}`,
      "",
      // Real work outlasts the Home's turn that started it; the cancelled task runs until cancelled.
      `First run \`sleep ${task.outcome === "cancelled" ? 240 : 30}\` in a shell, with a timeout of at least 300 seconds, and wait for it to finish.`,
      "```",
      resultLine(task),
      "```",
      "",
    ]),
  ].join("\n");

const batchPrompt = (batch: 1 | 2, opening: string) =>
  [
    opening,
    ...DAY_TASKS.filter((task) => task.batch === batch).map(
      (task, index) => `${index + 1}. ${DAY_PROJECTS[task.project].title}: ${task.request}.`,
    ),
    "Each line is its own task. Start them all now; I'll check in later.",
  ].join("\n");

export const DAY_PROMPTS = {
  batch1: batchPrompt(1, "Morning! Here is today's first batch of work:"),
  batch2: batchPrompt(2, "Four more for today:"),
  summary:
    "That's it for today. Give me a summary of every task I gave you today: one line per task with its project and its current status. Then tell me which ones need me.",
} as const;

/** What a task's record says happened, in the words the summary is graded on. */
export type DayCategory = "done" | "needs_you" | "failed" | "cancelled" | "open";

export const categoryOfRecord = (
  task: Pick<BotTaskSummary, "status" | "acceptance">,
): DayCategory => {
  switch (task.status) {
    case "completed":
      return task.acceptance?.state === "needs_you" ? "needs_you" : "done";
    case "failed":
    case "interrupted":
      return "failed";
    case "cancelled":
    case "skipped":
      return "cancelled";
    default:
      return "open";
  }
};

const SCRIPTED_CATEGORY: Readonly<Record<DayOutcome, DayCategory>> = {
  done: "done",
  question: "needs_you",
  unproven: "needs_you",
  fails: "failed",
  cancelled: "cancelled",
};

// In priority order: a line that says "finished, but waits for you" needs the user.
const STATUS_WORDS: ReadonlyArray<readonly [DayCategory, RegExp]> = [
  ["cancelled", /cancel/i],
  [
    "failed",
    /fail|(could|did|can) ?n(o|['’])t (start|run)|cannot start|(not|never) started|\berror/i,
  ],
  [
    "needs_you",
    /needs? (you|your|verification|review|evidence)|review (is )?(still )?needed|(waits?|waiting|awaits?|awaiting) (for |on )?(you|your)|question|not done|unproven|unverified|not verified|unconfirmed|no evidence|without evidence|evidence (is )?missing|missing evidence|blocked|decision|your (answer|input|call|review)/i,
  ],
  ["open", /running|in progress|queued|still working|waiting for a (free )?slot/i],
  ["done", /\bdone\b|complete|finished|✅|merged|\bfixed\b|\bupdated\b|\bremoved\b|\braised\b/i],
];
// Phrases that deny a status rather than state it.
const DENIALS = /\bno (open )?questions?\b|nothing (else )?(needs|needed from) you|no errors?/gi;

/** The status a line of the Home's answer gives, if any. */
export const statusOfLine = (line: string): DayCategory | undefined => {
  const text = line.replace(DENIALS, "");
  return STATUS_WORDS.find(([, pattern]) => pattern.test(text))?.[0];
};

const matches = (pattern: string, text: string) => new RegExp(pattern, "i").test(text);

export interface DayRecord {
  readonly id: string;
  readonly title: string;
  /** The brief the Home wrote, from its start_task call. */
  readonly brief: string | null;
  readonly projectId: string;
  readonly status: BotTaskSummary["status"];
  readonly acceptance?: BotTaskSummary["acceptance"];
}

export interface DayHomeRun {
  readonly runId: string;
  /** The tasks whose "Task update" messages started this run; empty for the user's own turns. */
  readonly updateTaskIds: ReadonlyArray<string>;
  readonly answer: string;
}

export interface DayRun {
  readonly records: ReadonlyArray<DayRecord>;
  /** Every Home run in order. */
  readonly homeRuns: ReadonlyArray<DayHomeRun>;
  /** Why the day stopped before the summary, or null when it ran to the end. */
  readonly incomplete: string | null;
  /** The run that answers the summary request. */
  readonly summaryRunId: string;
  /** The task the eval cancelled as the user. */
  readonly userCancelled: string | null;
  readonly tools: ReadonlyArray<ToolActivity>;
  readonly checkoutsUnchanged: boolean;
  readonly ids: {
    readonly botId: string;
    readonly projectIds: Readonly<Record<DayProjectKey, string>>;
  };
}

/** The requests a record is about, by its title, or by its brief when the title names none. */
const requestsOf = (record: DayRecord) => {
  const named = DAY_TASKS.filter((task) => matches(task.match, record.title));
  return named.length > 0
    ? named
    : DAY_TASKS.filter((task) => matches(task.match, record.brief ?? ""));
};

/** The records a scripted task became in its own project. */
const recordsOf = (task: DayTask, run: DayRun) =>
  run.records.filter(
    (record) =>
      record.projectId === run.ids.projectIds[task.project] && requestsOf(record).includes(task),
  );

/** The status of each mention of a task: its own line's, or the heading of the group it is in. */
const summaryStatuses = (task: DayTask, lines: ReadonlyArray<string>) => {
  const isTaskLine = (line: string) => DAY_TASKS.some((other) => matches(other.match, line));
  const mentions = lines.flatMap((line, index) => {
    if (!matches(task.match, line)) return [];
    // The nearest status above, unless a section heading without one comes first.
    const heading = lines
      .slice(0, index)
      .toReversed()
      .find(
        (above) => !isTaskLine(above) && (statusOfLine(above) !== undefined || HEADING.test(above)),
      );
    const sentence = line.split(/(?<=[.!?])\s+/).find((part) => matches(task.match, part)) ?? line;
    const grouped = DAY_TASKS.some(
      (other) => other.key !== task.key && matches(other.match, sentence),
    );
    return [
      {
        grouped,
        status:
          statusOfLine(sentence) ?? (heading === undefined ? undefined : statusOfLine(heading)),
      },
    ];
  });
  // A per-task status answers the question more precisely than a recap of several tasks.
  return mentions
    .toSorted((a, b) => Number(a.grouped) - Number(b.grouped))
    .map(({ status }) => status);
};

const LIST_ITEM = /^\s*([-*•]|\d+[.)]|\|)\s*/;
/** A section heading: a Markdown heading, a bold line, or a line that ends in a colon. */
const HEADING = /^\s*(#{1,6}\s.*|\*\*[^*]+\*\*:?|[^-*•|\s\d].*:)\s*$/;

/** The words of five letters or more, which name a task's subject. */
const words = (text: string) => text.toLowerCase().match(/[a-z]{5,}/g) ?? [];

export const gradeDay = (run: DayRun) => {
  const checks: Array<{ readonly check: string; readonly pass: boolean }> = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  const summaryIndex = run.homeRuns.findIndex((homeRun) => homeRun.runId === run.summaryRunId);
  const summary = run.homeRuns[summaryIndex]?.answer ?? "";
  const lines = summary.split("\n").filter((line) => line.trim() !== "");
  // A day that stopped before the summary still passed on what it passed on.
  const earlierRuns = summaryIndex < 0 ? run.homeRuns : run.homeRuns.slice(0, summaryIndex);
  const projectTitles = DAY_PROJECT_KEYS.map((key) => DAY_PROJECTS[key].title);

  add("day ran to the summary", run.incomplete === null);
  // Scenario: each scripted task ran as scripted. A sample where it did not grades nothing else.
  const scripted = DAY_TASKS.map((task) => ({ task, records: recordsOf(task, run) }));
  const ranAsScripted = (task: DayTask, record: DayRecord) => {
    const report = record.acceptance?.report;
    if (categoryOfRecord(record) !== SCRIPTED_CATEGORY[task.outcome]) return false;
    switch (task.outcome) {
      case "question":
        return report?.openQuestions.some((text) => matches(task.question!.match, text)) === true;
      case "unproven":
        return report?.status === "done" && report.evidence.length === 0;
      case "cancelled":
        return record.id === run.userCancelled;
      default:
        return true;
    }
  };
  add(
    "scenario held: every task that ran once ended as scripted",
    scripted.every(({ task, records }) => records.length !== 1 || ranAsScripted(task, records[0]!)),
  );

  for (const { task, records } of scripted)
    add(`started ${task.key} exactly once`, records.length === 1);
  const claims = scripted.flatMap(({ records }) => records.map((record) => record.id));
  const claimed = new Set(claims);
  add("gave every request a task of its own", claimed.size === claims.length);
  add(
    "started no task beyond the ten asked for",
    run.records.every((record) => claimed.has(record.id)),
  );

  for (const { task, records } of scripted) {
    const record = records[0];
    if (records.length !== 1 || record === undefined) continue;
    const expected = categoryOfRecord(record);
    const mentions = summaryStatuses(task, lines);
    const reported = mentions.find((status) => status !== undefined);
    add(`summary gives ${task.key} as ${expected}`, reported === expected);
    // From the record, not the script: a worker that strayed into a proven result is done.
    if (expected === "failed" || expected === "cancelled" || expected === "needs_you") {
      const update = run.homeRuns.filter((homeRun) => homeRun.updateTaskIds.includes(record.id));
      const updateLines = update.flatMap(({ answer }) => {
        const own = answer.split("\n").filter((line) => matches(task.match, line));
        return own.length > 0 ? own : [answer];
      });
      // Every mention, so a later "done" does not hide behind an earlier correct status.
      add(
        `${task.key} is not reported as done`,
        !mentions.includes("done") && updateLines.every((line) => statusOfLine(line) !== "done"),
      );
    }
  }

  // A real task may be named in other words, so a line is invented only if it shares none. Lines
  // that ask for the user's input name a need, not a task's outcome, so they never count.
  const outcomes: ReadonlyArray<DayCategory | undefined> = ["done", "failed", "cancelled", "open"];
  const projectWords = new Set(projectTitles.flatMap(words));
  const knownWords = new Set(
    [...DAY_TASKS.map((task) => task.request), ...run.records.map((record) => record.title)]
      .flatMap(words)
      .filter((word) => !projectWords.has(word)),
  );
  add(
    "summary invents no task",
    lines.every(
      (line) =>
        !LIST_ITEM.test(line) ||
        (!outcomes.includes(statusOfLine(line)) && !/\bblocked\b/i.test(line)) ||
        !projectTitles.some((title) => line.includes(title)) ||
        DAY_TASKS.some((task) => matches(task.match, line)) ||
        words(line).some((word) => knownWords.has(word)),
    ),
  );

  for (const task of DAY_TASKS) {
    const question = task.question;
    if (question === undefined) continue;
    const told = earlierRuns.filter(({ answer }) =>
      answer
        .split(/(?<=[.!?])\s+|\n/)
        .some(
          (sentence) =>
            matches(question.match, sentence) &&
            (!/\bdone when\b/i.test(sentence) || sentence.includes("?")),
        ),
    );
    const title = DAY_PROJECTS[task.project].title;
    add(`question of ${task.key} passed on once`, told.length === 1);
    add(
      `question of ${task.key} names its task and project`,
      told.length > 0 &&
        told.every(
          ({ answer }) =>
            matches(task.match, answer) && answer.toLowerCase().includes(title.toLowerCase()),
        ),
    );
  }

  // The server refuses a task in the Home's own project, so only edits and workers count here.
  add(
    "did none of the work in the Home",
    run.checkoutsUnchanged &&
      run.tools.every(
        (tool) =>
          tool.type !== "file_change" &&
          !/"toolName":\s*"[^"]*delegate_task"/.test(tool.text ?? ""),
      ),
  );
  return checks;
};
