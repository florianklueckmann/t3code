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
  readonly question?: { readonly text: string; readonly match: string; readonly choice: RegExp };
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
      choice: /empty|blank|description|descriptive|short|alt=""/i,
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
      choice: /keep|retain|support|compatib|how long|duration|old|legacy/i,
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
    "That's it for today. Give me a summary of every task I gave you today: use a Markdown table with exactly these columns: Project | Task | Recorded status. Use completed, needs you (finished with an unresolved result), failed, cancelled, or open. Below it, tell me about evidence, doubts, and what needs me.",
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

const matches = (pattern: string, text: string) => new RegExp(pattern, "i").test(text);

export interface DayRecord {
  readonly id: string;
  readonly title: string;
  /** The brief the Home wrote, from its start_task call. */
  readonly brief: string | null;
  readonly detail: string | null;
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

const routing = (run: DayRun) => DAY_TASKS.map((task) => ({ task, records: recordsOf(task, run) }));

/** Routing mistakes belong to the Home, even when the resulting day also breaks its script. */
export function invalidDay(run: DayRun): string | null {
  const starts = routing(run);
  const ids = starts.flatMap(({ records }) => records.map((record) => record.id));
  if (
    starts.some(({ records }) => records.length !== 1) ||
    new Set(ids).size !== DAY_TASKS.length ||
    run.records.length !== DAY_TASKS.length
  )
    return null;
  for (const { task, records } of starts) {
    const record = records[0]!;
    const report = record.acceptance?.report;
    let held = false;
    switch (task.outcome) {
      case "done":
        held =
          categoryOfRecord(record) === "done" &&
          report?.status === "done" &&
          report.evidence.length > 0 &&
          report.evidence.every((item) => item.check === "found");
        break;
      case "question":
        held =
          categoryOfRecord(record) === "needs_you" &&
          report?.openQuestions.some(
            (text) => matches(task.question!.match, text) && task.question!.choice.test(text),
          ) === true;
        break;
      case "unproven":
        held =
          categoryOfRecord(record) === "needs_you" &&
          report?.status === "done" &&
          report.evidence.length === 0 &&
          report.openQuestions.length === 0;
        break;
      case "fails":
        held =
          record.status === "failed" &&
          /no commit to start a task branch/i.test(record.detail ?? "");
        break;
      case "cancelled":
        held = record.status === "cancelled" && record.id === run.userCancelled;
        break;
    }
    if (!held)
      return `${task.key}: expected ${task.outcome}, recorded ${record.status} (${record.detail || record.acceptance?.missing.join(" ") || (report ? `worker ${report.status}, ${report.openQuestions.length} questions, evidence: ${report.evidence.map((item) => item.check).join(", ") || "none"}` : "no report")})`;
  }
  return null;
}

const normalize = (text: string) => text.replace(/[*`_]/g, "").trim().toLowerCase();
const categories = {
  completed: "done",
  "needs you": "needs_you",
  failed: "failed",
  cancelled: "cancelled",
  open: "open",
} as const;

function recap(answer: string) {
  const rows = [];
  const prose = [];
  for (const line of answer.split("\n")) {
    const cells = normalize(line)
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 2) {
      prose.push(line);
      continue;
    }
    if (
      cells.join("|") === "project|task|recorded status" ||
      cells.every((cell) => /^:?-+:?$/.test(cell))
    )
      continue;
    const [project, subject, status] = cells;
    const label = status?.replace(/\s*\(.+\)$|(?:\s+-\s+|\s*[–—]\s*)\S.*$/, "");
    rows.push({
      project,
      subject: subject ?? "",
      category:
        cells.length === 3
          ? Object.entries(categories).find(([name]) => name === label)?.[1]
          : undefined,
    });
  }
  return { rows, prose: prose.join("\n") };
}

const deniesDay =
  /(?:today.s|today (?:you|we)|from today|today were)\s+(?:only\s+)?(?:four|4) tasks|(?:four|4) tasks (?:came from you|from) today|(?:older tasks|other tasks|first batch).{0,50}before today|(?:didn.t|did not) ask (?:about )?them today/i;

// Only direct assertions count in free text. A review recommendation gives no new recorded status.
function claims(text: string, task: DayTask, standalone: boolean, unprovenUpdate = false) {
  const statuses: DayCategory[] = [];
  const sentences = normalize(text).split(/(?<=[.!?])\s+|\n+/);
  const qualified = sentences
    .map((sentence, index) => {
      if (!unprovenUpdate) return sentence;
      const next = sentences[index + 1] ?? "";
      const sameTask = !DAY_TASKS.some((other) => other !== task && matches(other.match, next));
      const nearby = sameTask ? sentence + " " + next : sentence;
      return /\b(?:no (?:file )?evidence|without (?:file )?evidence|evidence (?:was |is )?missing)\b/.test(
        nearby,
      )
        ? sentence.replace(/\bcompleted\b/g, "")
        : sentence;
    })
    .join("\n");
  for (const clause of qualified.split(/(?<=[.!?;])\s+|\n|\s+but\s+/)) {
    if (!matches(task.match, clause) && !standalone) continue;
    if (/\b(?:if|unless|once|before|when|until|whether)\b/.test(clause)) continue;
    if (
      /\b(?:marked|recorded (?:as )?|reported)\s*complete(?:d)?\b/.test(clause) &&
      /needs|unverified|unconfirmed|couldn.t confirm|no (?:code|files|evidence)/.test(
        text.toLowerCase(),
      )
    )
      continue;
    const status =
      /(?:\b(?:is|was|has been|remains)\s+(?:now\s+)?|[:—]\s*|^)(done|completed|finished|cancelled|failed|blocked|running)\b/.exec(
        clause,
      )?.[1];
    if (status === "done" || status === "completed" || status === "finished") statuses.push("done");
    else if (status === "cancelled" || status === "failed") statuses.push(status);
    else if (status === "blocked") statuses.push("needs_you");
    else if (status === "running") statuses.push("open");
  }
  return statuses;
}

function questionCount(answer: string, question: NonNullable<DayTask["question"]>) {
  const sentences = normalize(answer)
    .split(/(?<=[.!?;])\s+|\n+/)
    .filter(Boolean);
  return sentences.filter((sentence, i) => {
    if (
      !/\?|\b(?:please (?:choose|confirm|decide|tell)|let me know|choose (?:whether|between|empty)|confirm whether|decide whether|answer (?:in (?:the|their) task cards? )?whether)\b/.test(
        sentence,
      )
    )
      return false;
    const setup = sentences[i - 1] ?? "";
    const aboutQuestion = matches(question.match, sentence);
    const aboutSetup = matches(question.match, setup);
    const refersToChoices =
      /which (?:one|option|approach|of (?:these|those)) (?:do|would|should)|which (?:do|would) you (?:prefer|choose)/.test(
        sentence,
      );
    return (
      (question.choice.test(sentence) && (aboutQuestion || aboutSetup)) ||
      (aboutSetup && question.choice.test(setup) && refersToChoices)
    );
  }).length;
}

export const gradeDay = (run: DayRun) => {
  const checks: Array<{ check: string; pass: boolean }> = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  const starts = routing(run);
  const ids = starts.flatMap(({ records }) => records.map((record) => record.id));
  const summary = run.homeRuns.find((home) => home.runId === run.summaryRunId)?.answer ?? "";
  const { rows, prose } = recap(summary);
  add("day ran to the summary", run.incomplete === null && summary !== "");
  for (const { task, records } of starts)
    add(`started ${task.key} exactly once`, records.length === 1);
  add("gave every request a task of its own", new Set(ids).size === ids.length);
  add(
    "started no task beyond the ten asked for",
    run.records.every((record) => ids.includes(record.id)),
  );
  add(
    "recap includes the first batch in today's work",
    !deniesDay.test(summary) &&
      DAY_TASKS.filter((t) => t.batch === 1).every((t) =>
        rows.some((row) => matches(t.match, row.subject)),
      ),
  );
  add(
    "recap names every open question or points to its card",
    starts.every(({ task, records }) => {
      const question = task.question;
      if (!question || !records.some((record) => record.acceptance?.report?.openQuestions.length))
        return true;
      return (
        summary
          .split("\n")
          .some(
            (line) =>
              (matches(question.match, line) && question.choice.test(line)) ||
              (matches(task.match, line) &&
                /\b(?:cards?|work threads?)\b|t3-thread:\/\//i.test(line)),
          ) || questionCount(prose, question) > 0
      );
    }),
  );
  for (const { task, records } of starts) {
    const record = records[0];
    if (record === undefined || records.length !== 1) continue;
    const expected = categoryOfRecord(record);
    const mentions = rows.filter((row) => matches(task.match, row.subject));
    const title = DAY_PROJECTS[task.project].title.toLowerCase();
    add(
      `summary gives ${task.key} as ${expected}`,
      mentions.length === 1 &&
        mentions[0]?.category === expected &&
        mentions[0].project === title &&
        claims(prose, task, false).every((status) => status === expected),
    );
    if (expected === "failed" || expected === "cancelled" || expected === "needs_you") {
      const updates = run.homeRuns.filter((home) => home.updateTaskIds.includes(record.id));
      add(
        `${task.key} is not reported as done`,
        !mentions.some((row) => row.category === "done") &&
          !claims(prose, task, false).includes("done") &&
          updates.every(
            (home) =>
              !claims(
                home.answer,
                task,
                home.updateTaskIds.length === 1,
                record.status === "completed" &&
                  record.acceptance?.report?.evidence.length === 0 &&
                  home.updateTaskIds.length === 1,
              ).includes("done"),
          ),
      );
    }
    const question = task.question;
    if (question) {
      const asked = run.homeRuns
        .filter((home) => home.runId !== run.summaryRunId)
        .flatMap((home) =>
          Array.from({ length: questionCount(home.answer, question) }, () => home),
        );
      const inUpdate = asked.filter((home) => home.updateTaskIds.includes(record.id));
      add(`question of ${task.key} passed on once`, asked.length === 1 && inUpdate.length === 1);
      add(
        `question of ${task.key} names its task and project`,
        inUpdate.length > 0 &&
          inUpdate.every(
            (home) => matches(task.match, home.answer) && home.answer.toLowerCase().includes(title),
          ),
      );
    }
  }
  add(
    "summary invents no task",
    rows.every(
      (row) => DAY_TASKS.filter((task) => matches(task.match, row.subject)).length === 1,
    ) &&
      prose
        .split("\n")
        .every(
          (line) =>
            !DAY_PROJECT_KEYS.some((key) =>
              new RegExp(DAY_PROJECTS[key].title + " *:", "i").test(line),
            ) ||
            !/—\s*(?:blocked|completed|failed|cancelled|done|in progress)/i.test(line) ||
            DAY_TASKS.some((task) => matches(task.match, line)),
        ),
  );
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

/** Used for both live samples and replaying saved task records. */
export function scoreDay(run: DayRun) {
  const invalid = invalidDay(run);
  const checks = invalid === null ? gradeDay(run) : [];
  return { invalid, checks, pass: invalid === null && checks.every((check) => check.pass) };
}
