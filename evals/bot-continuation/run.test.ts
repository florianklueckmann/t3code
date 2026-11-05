import { expect, it } from "@effect/vitest";
import { CASES } from "./cases.ts";
import { gradeSample, type Observation, type ObservedNote } from "./grade.ts";

const note = (): ObservedNote => ({
  revision: 1,
  note: {
    requests: [{ text: "Lantern checklist after date", refs: [{ kind: "message" }] }],
    waiting: [{ text: "Proposal: blue packaging; date unknown", refs: [{ kind: "message" }] }],
    decided: [],
    context: [],
  },
  updatedBy: { kind: "bot", threadId: "home", runId: "run-1" },
  newerInputs: { count: 0 },
});
const observation = (): Observation => ({
  supported: true,
  capture: note(),
  resumed: note(),
  answer: "Lantern date still pending; packaging is a proposal.",
  calls: [{ action: "save_continuation", botId: "bot", projectId: "project" }],
  botId: "bot",
  projectId: "project",
  homeThreadId: "home",
  errors: [],
  settled: true,
  unchangedSettings: true,
  tasks: 0,
  routines: 0,
});
const passes = (run: Observation, index = 0) =>
  gradeSample(CASES[index]!, run).every((check) => check.pass);

it("requires durable capture and actual scoped tool activity in addition to an answer", () => {
  expect(passes(observation())).toBe(true);
  expect(passes({ ...observation(), supported: false, capture: null, resumed: null })).toBe(false);
  expect(passes({ ...observation(), calls: [] })).toBe(false);
  expect(
    passes({
      ...observation(),
      calls: [{ action: "save_continuation", botId: "other", projectId: "project" }],
    }),
  ).toBe(false);
  expect(passes({ ...observation(), capture: { ...note(), updatedBy: { kind: "user" } } })).toBe(
    false,
  );
  expect(passes({ ...observation(), settled: false })).toBe(false);
});
it("rejects section promotion, missing refs, restored resolved work and hidden mutations", () => {
  const promoted = note();
  expect(
    passes({
      ...observation(),
      resumed: {
        ...promoted,
        note: { ...promoted.note, decided: promoted.note.waiting, waiting: [] },
      },
    }),
  ).toBe(false);
  expect(
    passes({
      ...observation(),
      capture: { ...note(), note: { ...note().note, requests: [{ text: "Lantern", refs: [] }] } },
    }),
  ).toBe(false);
  expect(passes({ ...observation(), unchangedSettings: false })).toBe(false);
  expect(passes({ ...observation(), tasks: 1 })).toBe(false);
  expect(passes(observation(), 1)).toBe(false);
});
it("ordinary answers cannot invent work or perform an acknowledgement save", () => {
  const empty: ObservedNote = {
    ...note(),
    revision: null,
    updatedBy: null,
    note: { requests: [], waiting: [], decided: [], context: [] },
  };
  const run = { ...observation(), capture: empty, resumed: empty, answer: "17", calls: [] };
  expect(passes(run, 2)).toBe(true);
  expect(passes({ ...run, calls: observation().calls }, 2)).toBe(false);
  expect(passes({ ...run, resumed: note() }, 2)).toBe(false);
});
