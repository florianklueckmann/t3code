import { expect, it } from "@effect/vitest";

import { CASES } from "./cases.ts";
import { gradeSample, type SampleRun } from "./run.ts";

const standing = CASES.find((testCase) => testCase.id === "standing-source-added")!;
const ids = { botId: "bs-1", projectIds: { a: "project-a", b: "project-b" } };
const update = (botId: string, projectId: string) => ({
  type: "dynamic_tool",
  title: "t3 bot",
  text: JSON.stringify({
    toolName: "t3-code.t3_bot",
    input: { action: "update", botId, projectId },
  }),
});
const run = (tools: SampleRun["tools"]): SampleRun => ({
  answers: ["Added it."],
  tools,
  sources: {
    bot: {
      a: [
        "canon/session-log.md",
        "rules/house-rules.md",
        "bestiary/homebrew.md",
        "lore/sword-coast-notes.md",
      ],
      b: ["canon/session-log.md"],
    },
    twin: ["canon/session-log.md"],
  },
  ids,
  learning: [],
});
const updateCheck = (tools: SampleRun["tools"]) =>
  gradeSample(standing, run(tools)).find((check) => check.check.startsWith("t3_bot update"))?.pass;

it("credits a standing update only when every call names the Bot's own ids", () => {
  expect(updateCheck([update("bs-1", "project-a")])).toBe(true);
  expect(updateCheck([update("bs-1", "project-a"), update("bs-1", "project-b")])).toBe(false);
  expect(updateCheck([update("bs-1-twin", "project-a")])).toBe(false);
  expect(updateCheck([])).toBe(false);
});

it("credits only learning the Bot recorded itself, in the expected scope and status", () => {
  const waits = CASES.find((testCase) => testCase.id === "correction-waits-for-adoption")!;
  const lesson = {
    scope: "a" as const,
    kind: "preference",
    text: "Answer in a single sentence.",
    origin: "correction",
    status: "pending",
    byBot: true,
  };
  const learningCheck = (learning: SampleRun["learning"]) =>
    gradeSample(waits, { ...run([]), learning }).find((check) => check.check.startsWith("learning"))
      ?.pass;
  expect(learningCheck([lesson])).toBe(true);
  expect(learningCheck([{ ...lesson, status: "active" }])).toBe(false);
  expect(learningCheck([{ ...lesson, scope: "b" }])).toBe(false);
  expect(learningCheck([{ ...lesson, byBot: false }])).toBe(false);
  const fact = CASES.find((testCase) => testCase.id === "fact-shared-on-explicit-request")!;
  const shared = {
    ...lesson,
    scope: "all" as const,
    kind: "fact",
    text: "The user's name is Rowan.",
    origin: "instruction",
    status: "active",
  };
  const factCheck = (learning: SampleRun["learning"]) =>
    gradeSample(fact, { ...run([]), learning }).find((check) => check.check.startsWith("learning"))
      ?.pass;
  expect(factCheck([shared])).toBe(true);
  expect(factCheck([{ ...shared, kind: "preference" }])).toBe(false);
  expect(factCheck([{ ...shared, scope: "a" }])).toBe(false);
  // Source cases must not turn a source change into learning.
  const learnedToo = gradeSample(standing, {
    ...run([update("bs-1", "project-a")]),
    learning: [lesson],
  });
  expect(learnedToo.find((check) => check.check === "no learning recorded")?.pass).toBe(false);
});

it("credits a history answer only when it links a message of the cited turn", () => {
  const history = CASES.find((testCase) => testCase.id === "history-after-fresh-start")!;
  const citeCheck = (answer: string) =>
    gradeSample(history, {
      ...run([]),
      answers: ["Noted.", answer],
      turnMessageIds: [["msg-1", "msg-2"], ["msg-3"]],
    }).find((check) => check.check.includes("links a message"))?.pass;
  expect(
    citeCheck("'brass lantern' ([Home](t3-thread://v2/env/home#message=msg-1&find=brass))."),
  ).toBe(true);
  expect(citeCheck("'brass lantern' (<t3-thread://v2/env/home>).")).toBe(false);
  expect(citeCheck("'brass lantern' (t3-thread://v2/env/home#message=msg-3&find=brass)")).toBe(
    false,
  );
});

it("credits a Bot-level Home only for one briefed task per named project and no edits", () => {
  const distributes = CASES.find((testCase) => testCase.id === "bot-home-distributes")!;
  const asks = CASES.find((testCase) => testCase.id === "bot-home-asks-first")!;
  const start = (
    projectId: string,
    {
      task = "Change the headings.\nDone when: all headings match." as unknown,
      botId = "bs-1",
      refused = false,
    } = {},
  ) => ({
    type: "dynamic_tool",
    title: "t3 bot",
    text: JSON.stringify({
      toolName: "t3-code.t3_bot",
      input: { action: "start_task", botId, projectId, task },
      output: refused
        ? { error: "Refused." }
        : {
            structuredContent: {
              task: {
                id: `task-${projectId}`,
                botId,
                projectId,
                homeThreadId: "bot-home:bs-1:bot-home-bs-1",
                workThreadId: `bot-work:task-${projectId}`,
                origin: "direct",
                title: "Change the headings",
                scheduledTaskId: null,
                occurrenceDueAt: null,
                sessionAt: null,
                runtimeMode: "full-access",
                status: "accepted",
                detail: null,
                createdAt: "2026-11-27T00:00:00.000Z",
                updatedAt: "2026-11-27T00:00:00.000Z",
                completedAt: null,
              },
            },
          },
    }),
  });
  const edit = { type: "file_change", title: "canon/session-log.md", text: null };
  // The sources stay as attached, unlike the standing change `run` stores.
  const untouched = (tools: SampleRun["tools"]): SampleRun => ({
    ...run(tools),
    sources: {
      bot: {
        a: ["canon/session-log.md", "rules/house-rules.md", "bestiary/homebrew.md"],
        b: ["canon/session-log.md"],
      },
      twin: ["canon/session-log.md"],
    },
    checkoutsUnchanged: true,
  });
  const passes = (testCase: typeof distributes, tools: SampleRun["tools"], answer = "Started.") =>
    gradeSample(testCase, { ...untouched(tools), answers: [answer] }).every((check) => check.pass);
  const both = [start("project-a"), start("project-b")];
  expect(
    gradeSample(distributes, untouched([start("project-a"), start("project-b")])).filter(
      (check) => !check.pass,
    ),
  ).toEqual([]);
  expect(passes(distributes, [start("project-a")])).toBe(false);
  expect(passes(distributes, [start("project-a"), start("project-a"), start("project-b")])).toBe(
    false,
  );
  expect(
    passes(distributes, [start("project-a"), start("project-b"), start("bot-home-bs-1")]),
  ).toBe(false);
  for (const task of ["Change them.", "Change them. Done when:", "Change them. Done when: ."]) {
    expect(passes(distributes, [start("project-a"), start("project-b", { task })])).toBe(false);
  }
  const inSentence = "Change them. Done when every heading matches.";
  expect(passes(distributes, [start("project-a"), start("project-b", { task: inSentence })])).toBe(
    true,
  );
  expect(passes(distributes, [...both, start("project-a", { botId: "bs-1-twin" })])).toBe(false);
  expect(passes(distributes, [start("project-a", { botId: "bs-1-twin" }), both[1]!])).toBe(false);
  expect(passes(distributes, [...both, edit])).toBe(false);
  expect(
    gradeSample(distributes, { ...untouched(both), checkoutsUnchanged: false }).every(
      (check) => check.pass,
    ),
  ).toBe(false);
  expect(passes(asks, [], "Cleaned it up.")).toBe(false);
  expect(passes(asks, [], "Which campaign, and what should go?")).toBe(true);
  expect(passes(asks, [start("project-a")], "Which campaign?")).toBe(false);
  expect(passes(asks, [start("bot-home-bs-1", { refused: true })], "Which campaign?")).toBe(false);
  expect(passes(asks, [start("project-a", { task: 123, refused: true })], "Which?")).toBe(false);
});

it("fails a stored list that repeats one source in place of another", () => {
  const stored = run([update("bs-1", "project-a")]);
  const repeated = {
    ...stored,
    sources: {
      ...stored.sources,
      bot: {
        ...stored.sources.bot,
        a: [
          "canon/session-log.md",
          "canon/session-log.md",
          "bestiary/homebrew.md",
          "lore/sword-coast-notes.md",
        ],
      },
    },
  };
  expect(gradeSample(standing, repeated).find((check) => check.check === "sources a")?.pass).toBe(
    false,
  );
});
