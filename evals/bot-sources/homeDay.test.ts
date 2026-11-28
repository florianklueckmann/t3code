import { expect, it } from "@effect/vitest";

import {
  DAY_PROJECTS,
  DAY_TASKS,
  type DayCategory,
  type DayRecord,
  type DayRun,
  gradeDay,
  statusOfLine,
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
    projectId: projectIds[task.project],
    ...status,
    ...(status.acceptance === undefined
      ? {}
      : { acceptance: { ...status.acceptance, report: reportOf(task) } }),
  };
});

const SUMMARY_WORD: Record<DayCategory, string> = {
  done: "done",
  needs_you: "needs you",
  failed: "failed",
  cancelled: "cancelled",
  open: "running",
};

const summaryOf = (tasks = DAY_TASKS) =>
  tasks
    .map(
      (task) =>
        `- ${task.request} (${DAY_PROJECTS[task.project].title}): ${SUMMARY_WORD[scripted[task.outcome]!]}`,
    )
    .join("\n");

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

it("uses each task's line when an overview groups decisions and outcomes", () => {
  const overview =
    "Four need you: the usr alias, alt text, /orders review and German FAQ. The rest finished or failed.";
  expect(failed(day({}, `${overview}\n${summaryOf()}`))).toEqual([]);
  expect(failed(day({}, summaryOf().replace(": done", ". Completed.")))).toEqual([]);
  const homeRuns = day().homeRuns.map((run) =>
    run.runId === "run-batch-1"
      ? {
          ...run,
          answer:
            "Storefront alt text: done when images have text or are explicitly marked decorative.",
        }
      : run,
  );
  expect(failed(day({ homeRuns }))).toEqual([]);
});

it("fails a summary that leaves a task out", () => {
  const summary = summaryOf(DAY_TASKS.filter((task) => task.key !== "api-timeout"));
  expect(failed(day({}, summary))).toEqual(["summary gives api-timeout as done"]);
});

it("fails a summary that invents a task", () => {
  const summary = `${summaryOf()}\n- Refresh the Storefront sitemap: done`;
  expect(failed(day({}, summary))).toEqual(["summary invents no task"]);
  const running = `${summaryOf()}\n- Storefront: refresh the sitemap — in progress`;
  expect(failed(day({}, running))).toEqual(["summary invents no task"]);
  expect(failed(day({}, `${summaryOf()}\n- Storefront: refresh the sitemap — blocked`))).toEqual([
    "summary invents no task",
  ]);
  const reworded = `${summaryOf()}\n1. **Orders API rename:** answer the alias question in its card.`;
  expect(failed(day({}, reworded))).toEqual([]);
  const need = `${summaryOf()}\n1. The Orders API needs your answer about backward compatibility.`;
  expect(failed(day({}, need))).toEqual([]);
});

it("fails a summary that gives a task the wrong status, and calls the unproven one done", () => {
  const summary = summaryOf().replace(
    "document the /orders endpoint in docs/orders.md (Orders API): needs you",
    "document the /orders endpoint in docs/orders.md (Orders API): done",
  );
  expect(failed(day({}, summary))).toEqual([
    "summary gives orders-docs as needs_you",
    "orders-docs is not reported as done",
  ]);
});

it("reads a task's status from the heading of its group", () => {
  const grouped = [
    "**Done**",
    ...DAY_TASKS.filter((task) => task.outcome === "done").map((task) => `- ${task.request}`),
    "**Needs you**",
    ...DAY_TASKS.filter((task) => task.outcome === "question" || task.outcome === "unproven").map(
      (task) => `- ${task.request}`,
    ),
    "**Failed**",
    "- rotate the staging deploy key",
    "**Cancelled by you**",
    "- translate the FAQ into German",
  ].join("\n");
  expect(failed(day({}, grouped))).toEqual([]);
});

it("fails a question passed on twice or never", () => {
  const [alt] = questionRuns;
  const twice = day({
    homeRuns: [...questionRuns, { ...alt!, runId: "run-again" }, ...day().homeRuns.slice(-2)],
  });
  expect(failed(twice)).toEqual(["question of alt-text passed on once"]);
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

it("credits a done report when the record is done, whatever the script said", () => {
  const proven = records.map((record) =>
    record.id === "bot-task:orders-docs" ? { ...record, ...STATUS.done } : record,
  );
  const summary = summaryOf().replace(
    "document the /orders endpoint in docs/orders.md (Orders API): needs you",
    "document the /orders endpoint in docs/orders.md (Orders API): done",
  );
  expect(failed(day({ records: proven }, summary))).toEqual([
    "scenario held: every task that ran once ended as scripted",
  ]);
});

it("fails work done in the Home", () => {
  const edit = { type: "file_change", title: "Edit", text: "src/cart.ts" };
  expect(failed(day({ tools: [edit] }))).toEqual(["did none of the work in the Home"]);
  expect(failed(day({ checkoutsUnchanged: false }))).toEqual(["did none of the work in the Home"]);
});

it("fails the scenario when a task did not end as scripted", () => {
  const held = "scenario held: every task that ran once ended as scripted";
  const changed = records.map((record) =>
    record.id === "bot-task:deploy-key" ? { ...record, ...STATUS.done } : record,
  );
  expect(failed(day({ records: changed }))).toContain(held);
  const unreported = records.map((record) =>
    record.id === "bot-task:alt-text" ? { ...record, ...STATUS.needs_you } : record,
  );
  expect(failed(day({ records: unreported }))).toContain(held);
  expect(failed(day({ userCancelled: null }))).toContain(held);
});

it("fails a not-done task that a later line or group of the summary calls done", () => {
  const summary = `${summaryOf()}\n- rotate the staging deploy key: done after all`;
  expect(failed(day({}, summary))).toEqual(["deploy-key is not reported as done"]);
  const grouped = `${summaryOf()}\n**Done**\n- rotate the staging deploy key`;
  expect(failed(day({}, grouped))).toEqual(["deploy-key is not reported as done"]);
  const nextSteps = `${summaryOf()}\n**Done**\n- fix the broken links in CHANGELOG.md\n**Next steps**\n- add alt text: decide on decorative images`;
  expect(failed(day({}, nextSteps))).toEqual([]);
});

it("fails a day that stopped before the summary, and still credits its questions", () => {
  expect(failed(day({ incomplete: "evening did not settle" }))).toEqual(["day ran to the summary"]);
  const runs = day().homeRuns.filter((homeRun) => homeRun.runId !== "run-summary");
  const stopped = failed(day({ incomplete: "evening did not settle", homeRuns: runs }));
  expect(stopped).not.toContain("question of alt-text passed on once");
  expect(stopped).not.toContain("question of usr-param passed on once");
});

it("reads a line's status with denials and the not-done cases first", () => {
  expect(statusOfLine("Cart rounding — done, no open questions")).toBe("done");
  expect(statusOfLine("Orders docs: finished, but it names no evidence")).toBe("needs_you");
  expect(statusOfLine("Orders docs: needs evidence before it can be marked done")).toBe(
    "needs_you",
  );
  expect(statusOfLine("Document `/orders`: **marked complete, but needs verification**")).toBe(
    "needs_you",
  );
  expect(statusOfLine("Document `/orders`: **Done; result awaits your review**")).toBe("needs_you");
  expect(statusOfLine("Document `/orders`: reported complete; review is still needed.")).toBe(
    "needs_you",
  );
  expect(statusOfLine("Rotate staging deploy key: **couldn’t start**")).toBe("failed");
  expect(statusOfLine("Rotate staging deploy key: **not started**; it needs a commit")).toBe(
    "failed",
  );
  expect(statusOfLine("FAQ translation: cancelled by you")).toBe("cancelled");
  expect(statusOfLine("Deploy key: couldn't start")).toBe("failed");
  expect(statusOfLine("Storefront")).toBeUndefined();
});
