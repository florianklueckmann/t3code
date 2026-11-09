import { expect, it } from "@effect/vitest";
import { CASES } from "./cases.ts";
import { readToolCalls } from "./observe.ts";
import {
  gradeSample,
  isMissingContinuationApi,
  type Observation,
  type ObservedNote,
} from "./grade.ts";

const note = (): ObservedNote => ({
  botId: "bot",
  projectId: "project",
  homeThreadId: "home",
  revision: 1,
  note: {
    requests: [
      {
        text: "Lantern checklist after date",
        refs: [{ kind: "message", messageId: "input-1", digest: "digest-1", quote: "Lantern" }],
      },
    ],
    waiting: [
      {
        text: "Proposal: blue packaging; date unknown",
        refs: [{ kind: "message", messageId: "input-1", digest: "digest-1", quote: "Lantern" }],
      },
    ],
    decided: [],
    context: [],
  },
  updatedBy: { kind: "bot", threadId: "home", runId: "run-1" },
  newerInputs: { count: 0 },
});
const observation = (): Observation => ({
  supported: true,
  capture: note(),
  seed: null,
  seedRunId: null,
  captureRunId: "run-1",
  unchangedFiles: true,
  directInputs: [
    {
      messageId: "input-1",
      threadId: "home",
      text: "Lantern and blue packaging",
      digest: "digest-1",
      direct: true,
    },
  ],
  resumed: note(),
  answer: "Lantern date still pending; blue packaging is a proposal.",
  calls: [{ action: "save_continuation", runId: "run-1", botId: "bot", projectId: "project" }],
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
      calls: [
        { action: "save_continuation", runId: "run-1", botId: "other", projectId: "project" },
      ],
    }),
  ).toBe(false);
  expect(passes({ ...observation(), capture: { ...note(), updatedBy: { kind: "user" } } })).toBe(
    false,
  );
  expect(passes({ ...observation(), settled: false })).toBe(false);
  expect(
    passes({
      ...observation(),
      capture: { ...note(), updatedBy: { kind: "bot", threadId: "home", runId: "arbitrary-run" } },
    }),
  ).toBe(false);
  expect(passes({ ...observation(), directInputs: [] })).toBe(false);
  expect(
    passes({
      ...observation(),
      directInputs: [{ ...observation().directInputs[0]!, direct: false }],
    }),
  ).toBe(false);
  expect(
    passes({
      ...observation(),
      directInputs: [{ ...observation().directInputs[0]!, threadId: "foreign-home" }],
    }),
  ).toBe(false);
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
  expect(passes({ ...observation(), unchangedFiles: false })).toBe(false);
  expect(
    passes({
      ...observation(),
      resumed: {
        ...note(),
        note: {
          ...note().note,
          waiting: [{ text: "Date unknown", refs: note().note.waiting[0]!.refs }],
        },
      },
    }),
  ).toBe(false);
  expect(passes({ ...observation(), answer: "Lantern date is pending" })).toBe(false);
  expect(passes(observation(), 1)).toBe(false);
});
it("requires every submitted draft to fit the budget, not only the final persisted note", () => {
  const budget = { items: 2, totalTextUnits: 90, maxTextUnits: 50, maxQuoteUnits: 7 };
  const run = {
    ...observation(),
    calls: observation().calls.map((call) => ({ ...call, noteBudget: budget })),
  };
  expect(passes(run, 3)).toBe(true);
  for (const exceeded of [
    { items: 21 },
    { totalTextUnits: 4001 },
    { maxTextUnits: 401 },
    { maxQuoteUnits: 401 },
  ]) {
    const rejectedThenCorrected = {
      ...run,
      calls: [{ ...run.calls[0]!, noteBudget: { ...budget, ...exceeded } }, ...run.calls],
    };
    expect(passes(rejectedThenCorrected, 3)).toBe(false);
  }
  expect(passes(observation(), 3)).toBe(false);
});

it("keeps malformed save attempts visible when a later draft is valid", () => {
  const draft = { requests: [{ text: "Lantern" }], waiting: [], decided: [], context: [] };
  const activity = (continuation: unknown) => ({
    type: "tool_call",
    runId: "run-1",
    text: JSON.stringify({
      toolName: "t3_bot",
      input: { action: "save_continuation", botId: "bot", projectId: "project", continuation },
    }),
  });
  for (const malformed of [
    undefined,
    { note: "not an object" },
    { note: { requests: [], waiting: [], decided: [] } },
    { note: { ...draft, context: "not an array" } },
    { note: { ...draft, requests: [{ text: 123 }] } },
  ]) {
    const calls = readToolCalls([activity(malformed), activity({ note: draft })]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.noteBudget).toBeUndefined();
    expect(passes({ ...observation(), calls }, 3)).toBe(false);
    expect(
      passes(
        { ...observation(), capture: null, resumed: null, answer: "17", calls: calls.slice(0, 1) },
        2,
      ),
    ).toBe(false);
  }
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
  expect(passes({ ...run, supported: false, capture: null, resumed: null }, 2)).toBe(true);
  expect(passes({ ...run, supported: false, capture: null, resumed: null, answer: "18" }, 2)).toBe(
    false,
  );
  expect(passes({ ...run, calls: observation().calls }, 2)).toBe(false);
  expect(passes({ ...run, resumed: note() }, 2)).toBe(false);
});

it("correction requires the seed to have actually persisted before removal", () => {
  const corrected: ObservedNote = {
    ...note(),
    revision: 2,
    updatedBy: { kind: "bot", threadId: "home", runId: "run-2" },
    note: {
      ...note().note,
      requests: [{ text: "Harbor checklist", refs: note().note.requests[0]!.refs }],
      waiting: [],
    },
  };
  const run: Observation = {
    ...observation(),
    capture: corrected,
    resumed: corrected,
    seed: note(),
    seedRunId: "run-1",
    captureRunId: "run-2",
    answer: "Harbor remains; Lantern and blue packaging were removed.",
    calls: [...observation().calls, { ...observation().calls[0]!, runId: "run-2" }],
  };
  expect(passes(run, 1)).toBe(true);
  expect(passes({ ...run, seed: null }, 1)).toBe(false);
  expect(passes({ ...run, seed: { ...note(), note: { ...note().note, waiting: [] } } }, 1)).toBe(
    false,
  );
  expect(passes({ ...run, calls: [run.calls[1]!] }, 1)).toBe(false);
});
it("recognizes the baseline action-enum error without hiding transport or auth failures", () => {
  const actions = [
    "list",
    "read",
    "create",
    "update",
    "archive",
    "restore",
    "attach",
    "detach",
    "start_task",
    "list_tasks",
    "cancel_task",
    "learn",
    "adopt",
    "reject",
    "retire",
    "reinstate",
  ];
  const error = `t3_bot: Error: T3 Code MCP tools/call failed: ${JSON.stringify({ code: -32602, message: `Invalid parameters for tool 't3_bot': Expected ${actions.map((action) => JSON.stringify(action)).join(" | ")}\n  at ["action"]` })}`;
  expect(isMissingContinuationApi(error)).toBe(true);
  expect(isMissingContinuationApi(error.replace("-32602", "-32603"))).toBe(false);
  expect(isMissingContinuationApi(error.replace('[\\"action\\"]', '[\\"botId\\"]'))).toBe(false);
  for (const message of [
    "t3_bot: 401 Unauthorized",
    "t3_bot: connection refused",
    "t3_bot: server database corruption",
    "t3_bot: continuation decoder missing note",
    "t3_bot: Unknown action read_continuation",
  ])
    expect(isMissingContinuationApi(message)).toBe(false);
});
