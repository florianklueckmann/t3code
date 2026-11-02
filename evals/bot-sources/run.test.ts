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
});
const updateCheck = (tools: SampleRun["tools"]) =>
  gradeSample(standing, run(tools)).find((check) => check.check.startsWith("t3_bot update"))?.pass;

it("credits a standing update only when every call names the Bot's own ids", () => {
  expect(updateCheck([update("bs-1", "project-a")])).toBe(true);
  expect(updateCheck([update("bs-1", "project-a"), update("bs-1", "project-b")])).toBe(false);
  expect(updateCheck([update("bs-1-twin", "project-a")])).toBe(false);
  expect(updateCheck([])).toBe(false);
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
