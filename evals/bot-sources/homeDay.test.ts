import { expect, it } from "@effect/vitest";

import {
  DAY_PROJECTS,
  DAY_TASKS,
  type DayCategory,
  type DayRecord,
  type DayRun,
  gradeDay,
  invalidDay,
} from "./homeDay.ts";

const projectIds = {
  storefront: "p-store",
  api: "p-api",
  handbook: "p-book",
  deploy: "p-deploy",
} as const;

const STATUS: Record<DayCategory, Pick<DayRecord, "status" | "acceptance">> = {
  done: { status: "completed", acceptance: { state: "done", missing: [], report: null } },
  needs_you: {
    status: "completed",
    acceptance: { state: "needs_you", missing: ["The result names no evidence."], report: null },
  },
  failed: { status: "failed" },
  cancelled: { status: "cancelled" },
  open: { status: "running" },
};

const scripted: Record<string, DayCategory> = {
  done: "done",
  question: "needs_you",
  unproven: "needs_you",
  fails: "failed",
  cancelled: "cancelled",
};

/** The report a scripted worker saves: its question, or no evidence for the unproven one. */
const reportOf = (task: (typeof DAY_TASKS)[number]) => ({
  result: task.request,
  status: task.outcome === "question" ? ("blocked" as const) : ("done" as const),
  evidence: task.outcome === "unproven" ? [] : [{ text: "file: a.ts", check: "found" as const }],
  openQuestions: task.question === undefined ? [] : [task.question.text],
});

const records: ReadonlyArray<DayRecord> = DAY_TASKS.map((task) => {
  const status = STATUS[scripted[task.outcome]!];
  return {
    id: `bot-task:${task.key}`,
    title: task.request,
    brief: null,
    detail:
      task.outcome === "fails" ? "The project has no commit to start a task branch from." : null,
    projectId: projectIds[task.project],
    ...status,
    ...(status.acceptance === undefined
      ? {}
      : { acceptance: { ...status.acceptance, report: reportOf(task) } }),
  };
});

const SUMMARY_WORD: Record<DayCategory, string> = {
  done: "completed",
  needs_you: "needs you",
  failed: "failed",
  cancelled: "cancelled",
  open: "running",
};

const tableOf = (tasks = DAY_TASKS) =>
  tasks
    .map(
      (task) =>
        `| ${DAY_PROJECTS[task.project].title} | ${task.request} | ${SUMMARY_WORD[scripted[task.outcome]!]} |`,
    )
    .join("\n");

const cards =
  "Product image alt text and users query parameter both stopped before changes. Each waits for your answer in its task card.";
const summaryOf = (tasks = DAY_TASKS) => tableOf(tasks) + "\n" + cards;

const questionRuns = DAY_TASKS.flatMap((task) =>
  task.question === undefined
    ? []
    : [
        {
          runId: `run-${task.key}`,
          updateTaskIds: [`bot-task:${task.key}`],
          answer: `${task.request} in ${DAY_PROJECTS[task.project].title} asks: ${task.question.text}`,
        },
      ],
);

const day = (overrides: Partial<DayRun> = {}, summary = summaryOf()): DayRun => ({
  records,
  homeRuns: [
    { runId: "run-batch-1", updateTaskIds: [], answer: "Started six tasks." },
    ...questionRuns,
    {
      runId: "run-deploy",
      updateTaskIds: ["bot-task:deploy-key"],
      answer: "The deploy key rotation failed: it could not start.",
    },
    { runId: "run-summary", updateTaskIds: [], answer: summary },
  ],
  incomplete: null,
  summaryRunId: "run-summary",
  userCancelled: "bot-task:faq-german",
  tools: [],
  checkoutsUnchanged: true,
  ids: { botId: "bot", projectIds },
  ...overrides,
});

const failed = (run: DayRun) =>
  gradeDay(run)
    .filter((check) => !check.pass)
    .map((check) => check.check);

it("passes a day whose summary and questions match the records", () => {
  expect(failed(day())).toEqual([]);
});

it("fails a question passed on twice or never", () => {
  const [alt] = questionRuns;
  const twice = day({
    homeRuns: [...questionRuns, { ...alt!, runId: "run-again" }, ...day().homeRuns.slice(-2)],
  });
  expect(failed(twice)).toEqual(["question of alt-text passed on once"]);
  const twiceInOne = day({
    homeRuns: day().homeRuns.map((run) =>
      run === alt ? { ...run, answer: run.answer + " " + run.answer } : run,
    ),
  });
  expect(failed(twiceInOne)).toContain("question of alt-text passed on once");
  for (const changed of [
    { ...alt!, updateTaskIds: [] },
    {
      ...alt!,
      answer: "The decorative alt text description is ready; should Storefront change its logo?",
    },
  ]) {
    expect(
      failed(day({ homeRuns: day().homeRuns.map((run) => (run === alt ? changed : run)) })),
    ).toContain("question of alt-text passed on once");
  }
  const never = day({ homeRuns: [...questionRuns.slice(1), ...day().homeRuns.slice(-2)] });
  expect(failed(never)).toEqual([
    "question of alt-text passed on once",
    "question of alt-text names its task and project",
  ]);
});

it("fails a question passed on under the wrong project", () => {
  const runs = day().homeRuns.map((run) =>
    run.runId === "run-alt-text"
      ? { ...run, answer: run.answer.replace("Storefront", "Handbook") }
      : run,
  );
  expect(failed(day({ homeRuns: runs }))).toEqual([
    "question of alt-text names its task and project",
  ]);
});

it("fails a task started twice or one that was never asked for", () => {
  const banner = records.find((record) => record.id === "bot-task:checkout-banner")!;
  expect(failed(day({ records: [...records, { ...banner, id: "bot-task:again" }] }))).toEqual([
    "started checkout-banner exactly once",
  ]);
  const extra = { ...banner, id: "bot-task:extra", title: "Refresh the sitemap" };
  expect(failed(day({ records: [...records, extra] }))).toEqual([
    "started no task beyond the ten asked for",
  ]);
});

it("fails two requests merged into one task", () => {
  const merged = records
    .filter((record) => record.id !== "bot-task:alt-text")
    .map((record) =>
      record.id === "bot-task:cart-rounding"
        ? { ...record, title: "Fix cart rounding and add product image alt text" }
        : record,
    );
  expect(failed(day({ records: merged }))).toContain("gave every request a task of its own");
});

it("fails an update turn that calls the failed task done", () => {
  const runs = day().homeRuns.map((run) =>
    run.runId === "run-deploy" ? { ...run, answer: "The deploy key rotation is done." } : run,
  );
  expect(failed(day({ homeRuns: runs }))).toEqual(["deploy-key is not reported as done"]);
});

it("does not attribute a completed prerequisite to the failed task", () => {
  const update = (text: string) =>
    day({
      homeRuns: day().homeRuns.map((run) =>
        run.runId === "run-deploy"
          ? { ...run, answer: "Deploy key rotation failed.\n" + text }
          : run,
      ),
    });
  const followUp =
    "Make a first commit. Once that’s done, tell me and I’ll start a new rotation task.";
  expect(failed(update(followUp))).toEqual([]);
  expect(failed(update(followUp + " The deploy key rotation is now done."))).toContain(
    "deploy-key is not reported as done",
  );
});

it("fails work done in the Home", () => {
  const edit = { type: "file_change", title: "Edit", text: "src/cart.ts" };
  expect(failed(day({ tools: [edit] }))).toEqual(["did none of the work in the Home"]);
  expect(failed(day({ checkoutsUnchanged: false }))).toEqual(["did none of the work in the Home"]);
});

it("grades only the rows for coverage, project and recorded status", () => {
  for (const summary of [
    summaryOf(DAY_TASKS.slice(1)),
    summaryOf().replace("Storefront", "Handbook"),
    summaryOf().replace("completed", "open"),
    summaryOf() + "\n" + summaryOf(DAY_TASKS.slice(0, 1)),
  ]) {
    expect(failed(day({}, summary))).toContain("summary gives cart-rounding as done");
  }
  expect(
    failed(day({}, summaryOf() + "\nSix came before this chat. You didn't ask about them today.")),
  ).toContain("recap includes the first batch in today's work");
});

it.each([
  "Deploy key rotation failed to start; the project needs a commit before the task can be retried. Deploy tools needs a commit before the rotation can be retried.",
  "Orders docs: Needs you: not confirmed done. Check its work thread before you count it as done.",
  "Cart rounding: Marked completed, but I couldn't confirm the fix. I recommend running it again.",
  "Cart rounding: Completed, but the work thread says no code changes were made, so the fix is unverified.",
  "Cart rounding: Unfinished; although marked complete, the work thread reported no files changed.",
])("keeps the recorded status alongside the qualification: %s", (text) => {
  expect(failed(day({}, summaryOf() + "\n" + text))).toEqual([]);
});

it("rejects a second status in the same sentence and an invented task with an ask", () => {
  expect(
    failed(
      day(
        {},
        summaryOf() +
          "\nDeploy key rotation failed to start but the deploy key rotation is now done.",
      ),
    ),
  ).toContain("deploy-key is not reported as done");
  for (const extra of [
    "Storefront: refresh the sitemap — blocked; please confirm the domain",
    "| Storefront | refresh the sitemap | needs you |",
  ]) {
    expect(failed(day({}, summaryOf() + "\n" + extra))).toContain("summary invents no task");
  }
});

it("recognizes a question across sentences and allows it again in the requested summary", () => {
  const homeRuns = day().homeRuns.map((run) =>
    run.runId !== "run-alt-text"
      ? run
      : {
          ...run,
          answer:
            "Storefront alt text: the decorative images need a decision. Empty alt or a short description?",
        },
  );
  expect(failed(day({ homeRuns }))).toEqual([]);
  expect(failed(day({}, summaryOf() + "\n" + questionRuns[0]!.answer))).toEqual([]);
});

it("separates worker outcomes from routing failures", () => {
  expect(invalidDay(day())).toBeNull();
  for (const [key, change] of [
    ["deploy-key", { detail: "process exited" }],
    ["cart-rounding", STATUS.needs_you],
    ["alt-text", STATUS.needs_you],
    ["orders-docs", STATUS.done],
  ] as const) {
    const changed = records.map((record) =>
      record.id === "bot-task:" + key ? { ...record, ...change } : record,
    );
    expect(invalidDay(day({ records: changed }))).toContain(key);
    expect(invalidDay(day({ records: changed.slice(1) }))).toBeNull();
  }
  expect(invalidDay(day({ userCancelled: null }))).toContain("faq-german");
});

it("requires each decision or its task card in the requested recap", () => {
  const check = "recap names every open question or points to its card";
  for (const text of [
    "",
    "Check the task cards.",
    "Answer the alt text question in its card.",
    "Decide whether usr should remain an alias.",
  ]) {
    expect(failed(day({}, tableOf() + "\n" + text))).toContain(check);
  }
  const both =
    "Answer in the task cards whether decorative product images should have empty alt text or a short description, and whether usr should remain an alias and for how long.";
  expect(failed(day({}, tableOf() + "\n" + both))).toEqual([]);
  const runs = day().homeRuns;
  expect(
    failed(
      day({
        homeRuns: [
          ...runs.slice(0, -1),
          { runId: "later", updateTaskIds: [], answer: both },
          ...runs.slice(-1),
        ],
      }),
    ),
  ).toEqual(["question of alt-text passed on once", "question of usr-param passed on once"]);
});

it("accepts a completed update qualified by the missing evidence in the following sentence", () => {
  const update = (answer: string) =>
    failed(
      day({
        homeRuns: [
          ...day().homeRuns,
          { runId: "docs-update", updateTaskIds: ["bot-task:orders-docs"], answer },
        ],
      }),
    );
  const text =
    "Orders API — Document the orders endpoint: completed. The worker reports that /orders is documented in docs/orders.md; no file evidence was cited.";
  expect(update(text)).toEqual([]);
  expect(update("Orders API — Document the orders endpoint: completed.")).toContain(
    "orders-docs is not reported as done",
  );
  expect(update(text + " The orders documentation is now done.")).toContain(
    "orders-docs is not reported as done",
  );
});
