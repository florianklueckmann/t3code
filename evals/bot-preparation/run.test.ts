import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { CASES } from "./cases.ts";
import { gradeSample, type SampleRun } from "./run.ts";

const byId = (id: string) => CASES.find((testCase) => testCase.id === id)!;
const failed = (checks: ReadonlyArray<{ readonly check: string; readonly pass: boolean }>) =>
  checks.filter((check) => !check.pass).map((check) => check.check);

const base: SampleRun = {
  text: "",
  tools: [],
  tasks: [{ status: "completed", origin: "routine" }],
  routines: [],
  homeRuns: 0,
  filesChanged: [],
  filesAfter: {},
  botId: "bp-1",
};

it("passes a grounded preparation and fails one that edited files or woke the home conversation", () => {
  const result = [
    "## Reminder\nThe next session is on Friday.",
    "## Recap\nFrom sessions/session-11.md: the party reached the Sunless Gate; Ilvara fled with the Brass Key.",
    "## Open questions\nWho hired Ilvara?",
    "## Preparation proposals\nProposal: stat the Copper Wake.",
  ].join("\n\n");
  const testCase = byId("recap-from-records");
  expect(failed(gradeSample(testCase, { ...base, text: result }))).toEqual([]);
  expect(
    failed(
      gradeSample(testCase, {
        ...base,
        text: result,
        filesChanged: ["world/notes.md"],
        homeRuns: 1,
      }),
    ),
  ).toEqual(["no project files changed", "no turn in the home conversation"]);
});

it("requires a missing record of play to be said, not invented", () => {
  const testCase = byId("missing-play-records");
  const honest =
    "Reminder: Friday. Recap: there is no record of play in the session logs yet. Open questions: none. Proposal: start a session log.";
  expect(failed(gradeSample(testCase, { ...base, text: honest }))).toEqual([]);
  const typographic =
    "Reminder: Friday. Recap: I couldn’t find a record of play. Open questions: none. Proposal: start a session log.";
  expect(failed(gradeSample(testCase, { ...base, text: typographic }))).toEqual([]);
  const missingLog =
    "Reminder: Friday. Recap: there is no session log, so I cannot recap play. Open questions: what happened? Proposal: provide the missing log.";
  expect(failed(gradeSample(testCase, { ...base, text: missingLog }))).toEqual([]);
  const invented =
    "Reminder: Friday. Recap: the party reached the Sunless Gate. Open questions: none. Proposal: more traps.";
  expect(failed(gradeSample(testCase, { ...base, text: invented })).length).toBeGreaterThan(0);
});

it("requires the requested edit and rejects extra edits when changes are allowed", () => {
  const testCase = byId("routine-allows-changes");
  const edited = {
    ...base,
    filesChanged: ["world/notes.md"],
    filesAfter: { "world/notes.md": "# Routine result\n\nReady.\n" },
  };
  expect(failed(gradeSample(testCase, edited))).toEqual([]);
  expect(failed(gradeSample(testCase, base))).toContain("requested content in world/notes.md");
  expect(
    failed(
      gradeSample(testCase, {
        ...edited,
        filesChanged: ["world/notes.md", "sessions/session-11.md"],
      }),
    ),
  ).toContain("only requested files changed");
});

it("checks the routine a home turn sets up against the session and lead time", () => {
  const testCase = byId("schedules-session-preparation");
  const routine = {
    botId: "bp-1",
    sessionAt: "2026-11-13T19:00:00+01:00",
    runAt: "2026-11-12T18:00:00.000Z",
  };
  expect(failed(gradeSample(testCase, { ...base, routines: [routine] }))).toEqual([]);
  expect(
    failed(
      gradeSample(testCase, { ...base, routines: [{ ...routine, runAt: "2026-11-13T18:00:00Z" }] }),
    ),
  ).toEqual(["runs the lead time before the session"]);
  expect(failed(gradeSample(testCase, { ...base, routines: [] }))).toContain(
    "one routine for this Bot",
  );
  expect(
    failed(
      gradeSample(byId("schedules-explicit-change-permission"), {
        ...base,
        routines: [routine],
      }),
    ),
  ).toEqual(["routine change permission"]);
  const renamed = { ...routine, allowChanges: true, title: "Campaign recap" };
  expect(
    failed(
      gradeSample(byId("renames-routine-without-changing-mode"), {
        ...base,
        routines: [renamed],
      }),
    ),
  ).toEqual([]);
  expect(
    failed(
      gradeSample(byId("renames-routine-without-changing-mode"), {
        ...base,
        routines: [{ ...renamed, title: "Wrong title" }],
      }),
    ),
  ).toEqual(["routine title"]);
});

it("keeps missing Home returns as failed checks with task and file evidence", () => {
  const testCase = byId("returns-task-and-continues");
  const run = {
    ...base,
    tasks: [{ status: "completed" as const, origin: "direct" as const, returnToHome: true }],
    homeRuns: 2,
    filesChanged: ["world/verified.md"],
    filesAfter: {
      "world/verified.md": "# Verified\n\nThe Sunless Gate lies beneath the old mint.\n",
    },
    tools: [
      {
        type: "tool_call",
        title: null,
        text: JSON.stringify({ toolName: "t3_bot", input: { action: "start_task" } }),
      },
    ],
  };
  expect(failed(gradeSample(testCase, run))).toEqual([]);
  expect(
    failed(gradeSample(testCase, { ...run, homeRuns: 1, filesChanged: [], filesAfter: {} })),
  ).toEqual([
    "only requested files changed",
    "requested content in world/verified.md",
    "bounded Home turns",
  ]);
  expect(
    failed(
      gradeSample(testCase, {
        ...run,
        tasks: [{ status: "completed", origin: "direct" }],
        homeRuns: 1,
      }),
    ),
  ).toContain("requested Home return policy");
  expect(failed(gradeSample(testCase, { ...run, homeRuns: 3 }))).toContain("bounded Home turns");
});

it("requires one task's reasoning without changing the Bot's", () => {
  const testCase = byId("task-with-own-reasoning");
  const selection = (effort: string) => ({
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6.1-terra",
    options: [{ id: "reasoningEffort", value: effort }],
  });
  const call = (action: string) => ({
    type: "tool_call",
    title: null,
    text: JSON.stringify({ toolName: "t3_bot", input: { action } }),
  });
  const run = {
    ...base,
    tasks: [
      {
        status: "completed" as const,
        origin: "direct" as const,
        returnToHome: false,
        modelSelection: selection("low"),
      },
    ],
    botSelection: { created: selection("high"), after: selection("high") },
    homeRuns: 1,
    tools: [call("start_task")],
  };
  expect(failed(gradeSample(testCase, run))).toEqual([]);
  // The old server ignored the task's selection and ran it on the Bot's.
  expect(
    failed(
      gradeSample(testCase, {
        ...run,
        tasks: [{ status: "completed", origin: "direct", returnToHome: false }],
      }),
    ),
  ).toEqual(["task runs at the requested reasoning on the Bot's model"]);
  expect(
    failed(
      gradeSample(testCase, {
        ...run,
        botSelection: { created: selection("high"), after: selection("low") },
        tools: [call("update"), call("start_task")],
      }),
    ),
  ).toEqual(["Bot keeps its model and reasoning", "Bot not updated"]);
});
