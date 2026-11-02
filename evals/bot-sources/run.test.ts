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
  // Source cases must not turn a source change into learning.
  const learnedToo = gradeSample(standing, {
    ...run([update("bs-1", "project-a")]),
    learning: [lesson],
  });
  expect(learnedToo.find((check) => check.check === "no learning recorded")?.pass).toBe(false);
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
