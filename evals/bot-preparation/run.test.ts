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
    sessionAt: "2027-11-12T19:00:00+01:00",
    runAt: "2027-11-11T18:00:00.000Z",
  };
  expect(failed(gradeSample(testCase, { ...base, routines: [routine] }))).toEqual([]);
  expect(
    failed(
      gradeSample(testCase, { ...base, routines: [{ ...routine, runAt: "2027-11-12T18:00:00Z" }] }),
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
  const reminder = {
    botId: "bp-1",
    sessionAt: undefined,
    runAt: "2027-11-19T08:00:00.000Z",
    title: "Descale oven",
    prompt: "Remind the user to descale the oven.",
  };
  const once = byId("reminder-set-once");
  const set = { ...base, routinesBeforeLastTurn: [reminder] };
  expect(failed(gradeSample(once, { ...set, routines: [reminder] }))).toEqual([]);
  expect(
    failed(gradeSample(once, { ...set, routines: [reminder, { ...reminder, title: "Again" }] })),
  ).toEqual(["one routine for this Bot", "exactly one routine for the reminder"]);
  expect(
    failed(
      gradeSample(once, {
        ...set,
        routines: [reminder, { ...reminder, runAt: "2027-11-16T17:00:00.000Z" }],
      }),
    ),
  ).toEqual(["one routine for this Bot"]);
  const lentils = { ...reminder, title: "Buy lentils", prompt: "Remind me to buy red lentils." };
  expect(failed(gradeSample(once, { ...base, routines: [lentils] }))).toEqual([
    "reminder set before the last turn",
    "exactly one routine for the reminder",
  ]);
  expect(failed(gradeSample(once, { ...base, routines: [reminder] }))).toEqual([
    "reminder set before the last turn",
  ]);
  // Midnight in Berlin is still the previous day in UTC.
  const midnight = { ...reminder, runAt: "2027-11-18T23:00:00.000Z" };
  expect(
    failed(
      gradeSample(once, { ...base, routinesBeforeLastTurn: [midnight], routines: [midnight] }),
    ),
  ).toEqual([]);
  const agreed = byId("reminder-after-agreement");
  const decide = {
    ...reminder,
    runAt: "2027-11-16T15:00:00.000Z",
    title: "Decide dinner",
    prompt: "Remind the user to decide between pancakes and lentil soup.",
  };
  expect(failed(gradeSample(agreed, { ...base, routines: [decide] }))).toEqual([]);
  expect(
    failed(gradeSample(agreed, { ...base, routinesBeforeLastTurn: [decide], routines: [decide] })),
  ).toEqual(["no routine before the user agreed"]);
  expect(
    failed(
      gradeSample(agreed, {
        ...base,
        routines: [{ ...decide, runAt: "2027-11-17T08:00:00.000Z" }],
      }),
    ),
  ).toEqual(["exactly one routine for the reminder"]);
  const errand = {
    ...decide,
    title: "Buy red lentils if you choose soup",
    prompt: "Remind me to buy red lentils if I decide on lentil soup.",
  };
  expect(failed(gradeSample(agreed, { ...base, routines: [errand] }))).toEqual([
    "exactly one routine for the reminder",
  ]);
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

it("requires a held-alert explanation read from the Bot's alerts", () => {
  const testCase = byId("explains-held-alert");
  const read = {
    type: "tool_call",
    title: null,
    text: JSON.stringify({ toolName: "t3_bot", input: { action: "read" } }),
  };
  const grounded =
    "It was held: your daily limit of 1 alert was already reached. The digest goes out at 05:45.";
  expect(failed(gradeSample(testCase, { ...base, text: grounded, tools: [read] }))).toEqual([]);
  expect(failed(gradeSample(testCase, { ...base, text: grounded }))).toEqual([
    "read the Bot's alerts",
  ]);
  const guessed = "The daily limit was not reached. Your push should have arrived at 15:45.";
  expect(failed(gradeSample(testCase, { ...base, text: guessed, tools: [read] }))).toEqual([
    "answer must /held/i",
    "answer must /\\b0?5:45/i",
  ]);
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

it("passes one grounded diagnosis and fails one that ran the failing command again", () => {
  const testCase = byId("diagnoses-failed-routine");
  const diagnosis = {
    taskId: "bot-task:routine",
    runId: "run:1",
    title: "Session preparation",
    workThreadId: "bot-work:bot-task:routine",
  } as never;
  const run: SampleRun = {
    ...base,
    text: "The run failed because `kill -9 $PPID` killed the agent's parent process. Remove that command.",
    tasks: [
      { status: "failed", origin: "routine" },
      { status: "completed", origin: "routine", diagnosis },
    ],
    tools: [{ type: "command_execution", title: "cat sessions/session-11.md", text: null }],
  };
  expect(failed(gradeSample(testCase, run))).toEqual([]);
  expect(
    failed(
      gradeSample(testCase, {
        ...run,
        text: "It failed.",
        tasks: [{ status: "failed", origin: "routine" }],
        tools: [{ type: "command_execution", title: "kill -9 $PPID", text: null }],
      }),
    ),
  ).toEqual([
    "one completed diagnosis",
    "the diagnosis did not run the failing command again",
    "result must /kill/i",
    "result must /PPID|parent/i",
  ]);
});

it("grades a watch by what reached the user, not by what each run wrote", () => {
  const recap =
    'From sessions/session-11.md: the party reached the Sunless Gate and Ilvara fled.\nOpen: who hired Ilvara?\nT3_WATCH {"occasion": "2026-12-04 Session 12", "items": ["Who hired Ilvara?"]}';
  const nothingNew = 'Session 12 was already posted.\nT3_WATCH {"new": false}';
  const posted: SampleRun = {
    ...base,
    text: recap,
    runTexts: [recap],
    runThreads: ["work-1", "work-2"],
    tasks: [{ status: "completed", origin: "routine", workThreadId: "work-1" }],
  };

  expect(failed(gradeSample(byId("watch-posts-unprepared-session"), posted))).toEqual([]);
  const second = byId("watch-quiet-on-second-check");
  expect(failed(gradeSample(second, { ...posted, runTexts: [recap, nothingNew] }))).toEqual([]);
  // Without the watch every run is a result, as on a server that predates it.
  expect(
    failed(
      gradeSample(second, {
        ...posted,
        runTexts: [recap, recap],
        tasks: [...posted.tasks, ...posted.tasks],
      }),
    ),
  ).toEqual(["1 of 2 runs reached the user"]);
  // A first run that showed nothing and a second that posted is not the first run's result.
  expect(
    failed(
      gradeSample(second, {
        ...posted,
        runTexts: [nothingNew, recap],
        tasks: [{ ...posted.tasks[0]!, workThreadId: "work-2" }],
      }),
    ),
  ).toEqual(["the first run is the one shown"]);
  expect(
    failed(
      gradeSample(byId("watch-quiet-when-prepared"), { ...posted, text: "", runTexts: ["Ready."] }),
    ),
  ).toEqual(["0 of 1 runs reached the user", "every run ended with a watch report"]);
  expect(
    failed(
      gradeSample(byId("watch-keeps-to-named-sources"), {
        ...posted,
        tools: [{ type: "command_execution", title: "cat private/diary.md", text: null }],
        filesChanged: ["world/notes.md"],
      }),
    ),
  ).toEqual(["no project files changed", "never mentions /private//i", "never mentions /diary/i"]);

  const watch = { botId: "bp-1", sessionAt: undefined, runAt: null, watch: true };
  const home = byId("sets-up-standing-watch");
  expect(
    failed(gradeSample(home, { ...base, routines: [{ ...watch, allowChanges: false }] })),
  ).toEqual([]);
  expect(
    failed(
      gradeSample(home, {
        ...base,
        routines: [{ ...watch, watch: false, runAt: "2026-12-03T08:00:00Z", allowChanges: true }],
      }),
    ),
  ).toEqual(["the routine is a watch", "the watch recurs", "the watch makes no changes"]);
});
