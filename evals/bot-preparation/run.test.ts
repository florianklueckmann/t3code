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
  const invented =
    "Reminder: Friday. Recap: the party reached the Sunless Gate. Open questions: none. Proposal: more traps.";
  expect(failed(gradeSample(testCase, { ...base, text: invented })).length).toBeGreaterThan(0);
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
});
