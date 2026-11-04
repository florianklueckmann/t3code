import { expect, it } from "@effect/vitest";

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
