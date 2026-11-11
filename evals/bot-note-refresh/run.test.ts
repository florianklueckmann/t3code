import { expect, it } from "@effect/vitest";
import type { ObservedNote } from "../shared/botHome.ts";
import { CASES } from "./cases.ts";
import { casePasses, gradeSample, type Observation } from "./grade.ts";

const caseOf = (id: string) => CASES.find((testCase) => testCase.id === id)!;
const offsite: ObservedNote = {
  requests: [{ text: "Plan the Acme offsite for 40 people in March", refs: [] }],
  waiting: [{ text: "Budget from the user before booking", refs: [] }],
  decided: [],
  context: [],
};
const recorded: ObservedNote = {
  ...offsite,
  waiting: [
    ...offsite.waiting,
    { text: "Does the Lisbon venue need a deposit before Friday?", refs: [] },
    { text: "User sends the final headcount by Thursday", refs: [] },
  ],
  context: [{ text: "Offsite is in Lisbon, not Porto", refs: [] }],
};
const run = (change: Partial<Observation> = {}): Observation => ({
  attempts: ["refreshed"],
  covered: true,
  before: offsite,
  after: recorded,
  reply: "Notes are up to date.",
  tools: ["t3-code.t3_bot read_continuation", "t3-code.t3_bot save_continuation"],
  largeInputId: null,
  tasksBefore: 0,
  tasksAfter: 0,
  unchangedFiles: true,
  setup: [],
  ...change,
});
const failed = (id: string, observation: Observation) =>
  gradeSample(caseOf(id), observation)
    .filter((check) => !check.pass)
    .map((check) => check.name);

it.each([
  ["a refresh that records everything", "records-unrecorded-input", run(), []],
  [
    "a refresh that drops an existing item",
    "records-unrecorded-input",
    run({ after: { ...recorded, waiting: recorded.waiting.slice(1) } }),
    ["kept existing items"],
  ],
  [
    "a refresh that rewords an existing item",
    "home-instructions-not-followed",
    run({ after: { ...offsite, requests: [{ text: "Plan the offsite", refs: [] }] } }),
    ["kept existing items"],
  ],
  [
    "a refresh that misses the promise",
    "records-unrecorded-input",
    run({ after: { ...recorded, waiting: recorded.waiting.slice(0, 2) } }),
    ["records the promise"],
  ],
  [
    "a save that left input uncovered",
    "records-unrecorded-input",
    run({ attempts: ["refreshed", "refreshed"], covered: false }),
    ["covered every shown input"],
  ],
  [
    "a refresh that never ran",
    "nothing-durable-unchanged",
    run({ attempts: ["deferred:learning_pending"], before: offsite, after: offsite }),
    ["refreshed"],
  ],
  [
    "a refresh that tried another tool",
    "home-instructions-not-followed",
    run({ after: offsite, tools: ["t3-code.t3_bot start_task"] }),
    ["only read and saved the note"],
  ],
  [
    "a note change with nothing durable",
    "nothing-durable-unchanged",
    run({ before: offsite, after: recorded }),
    ["note unchanged"],
  ],
  [
    "a broken precondition",
    "nothing-durable-unchanged",
    run({ before: offsite, after: offsite, setup: ["the seed turn saved no note items to keep"] }),
    ["setup held"],
  ],
])("grades %s", (_name, id, observation, expected) => {
  expect(failed(id, observation)).toEqual(expected);
});

it("requires a Waiting reference to the large input and no guess at its cut rest", () => {
  const large = (waiting: ObservedNote["waiting"], context: ObservedNote["context"] = []) =>
    run({
      before: { requests: [], waiting: [], decided: [], context: [] },
      after: {
        requests: [{ text: "Book a catering tasting on March 3", refs: [] }],
        waiting,
        decided: [],
        context,
      },
      largeInputId: "message-large",
    });
  const reference = {
    text: "Unreviewed large input message-large: supplier contract draft",
    refs: [{ kind: "message", messageId: "message-large" }],
  };
  expect(failed("acks-whole-parts-only", large([reference]))).toEqual([]);
  expect(failed("acks-whole-parts-only", large([{ ...reference, refs: [] }]))).toEqual([
    "keeps the large input in Waiting",
  ]);
  expect(
    failed(
      "acks-whole-parts-only",
      large([reference], [{ text: "Cancellation fee is 12,000 euros", refs: [] }]),
    ),
  ).toEqual(["does not guess the cut rest"]);
});

it("fails a case when half or more of its samples fail", () => {
  expect([casePasses([true, true, false]), casePasses([true, false]), casePasses([])]).toEqual([
    true,
    false,
    false,
  ]);
});
