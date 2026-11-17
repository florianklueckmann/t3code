import { BOT_TURN_LEARNING_LIMITS } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { turnLearning } from "./BotLearning.ts";
import type { BotLearningRow } from "./BotStore.ts";

const projectA = "project-a";
const projectB = "project-b";

const row = (
  id: string,
  minute: number,
  options: {
    readonly projectId?: string | null;
    readonly origin?: "instruction" | "correction";
    readonly status?: BotLearningRow["status"];
    readonly text?: string;
  } = {},
): BotLearningRow => ({
  entry_id: id,
  revision: 1,
  bot_id: "bot",
  project_id: options.projectId === undefined ? projectA : options.projectId,
  kind: "preference",
  text: options.text ?? `Lesson ${id}.`,
  normalized_text: "",
  rationale: "",
  evidence: "",
  origin: options.origin ?? "correction",
  source_json: '{"kind":"user"}',
  learned_in_project_id: projectA,
  status: options.status ?? "active",
  base_revision: null,
  conflicts_with_instruction: 0,
  created_at: `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
  decided_at: null,
  activated_at: null,
  restored_from: null,
});

const many = (count: number, options: Parameters<typeof row>[2] = {}) =>
  Array.from({ length: count }, (_, index) =>
    row(`e${String(index + 1).padStart(2, "0")}`, index + 1, options),
  );

// "- [e01 r1; preference] " precedes the text of a project's correction.
const PREFIX = 23;
const sized = (lineLength: number) => "x".repeat(lineLength - PREFIX);
const perLine = BOT_TURN_LEARNING_LIMITS.chars / 8;

it.each([
  {
    name: "includes everything within the limits",
    rows: many(3),
    selected: ["e03", "e02", "e01"],
    eligible: 3,
  },
  {
    name: "includes an entry that reaches the character budget exactly",
    rows: many(8, { text: sized(perLine) }),
    selected: ["e08", "e07", "e06", "e05", "e04", "e03", "e02", "e01"],
    eligible: 8,
    chars: BOT_TURN_LEARNING_LIMITS.chars,
  },
  {
    name: "leaves out an entry one character over the budget, and everything older",
    rows: [
      row("e00", 0, { text: "Short." }),
      ...many(7, { text: sized(perLine) }),
      row("e08", 8, { text: sized(perLine + 1) }),
    ],
    selected: ["e08", "e07", "e06", "e05", "e04", "e03", "e02"],
    eligible: 9,
    chars: BOT_TURN_LEARNING_LIMITS.chars - perLine + 1,
  },
  {
    name: "leaves out the oldest past 40 entries, never a standing instruction",
    rows: [row("instruction", 0, { origin: "instruction" }), ...many(41)],
    selected: [
      "instruction",
      ...many(41)
        .slice(2)
        .map((each) => each.entry_id)
        .toReversed(),
    ],
    eligible: 42,
  },
  {
    name: "puts standing instructions first when the budget runs out",
    rows: [
      ...many(8, { text: sized(perLine) }),
      row("instruction", 0, { origin: "instruction", text: "Give dates in Dale Reckoning." }),
    ],
    selected: ["instruction", "e08", "e07", "e06", "e05", "e04", "e03", "e02"],
    eligible: 9,
  },
  {
    name: "counts entries for all projects but never another project's",
    rows: [
      row("shared", 0, { projectId: null }),
      ...many(40),
      row("other", 50, { projectId: projectB }),
    ],
    selected: many(40)
      .map((each) => each.entry_id)
      .toReversed(),
    eligible: 41,
  },
  {
    name: "counts only entries in use",
    rows: [
      ...many(2),
      row("retired", 10, { status: "retired" }),
      row("pending", 11, { status: "pending" }),
    ],
    selected: ["e02", "e01"],
    eligible: 2,
  },
])("$name", ({ rows, selected, eligible, ...expected }) => {
  const turn = turnLearning(rows, projectA);
  expect(turn.summary.selected).toEqual(selected);
  expect(turn.summary.eligible).toBe(eligible);
  expect(turn.omitted).toBe(eligible - selected.length);
  // The summary describes exactly the lines the turn receives.
  expect(turn.lines.map((line) => line.slice(3, line.indexOf(" ", 3)))).toEqual(selected);
  expect(turn.summary.chars).toBe(turn.lines.reduce((sum, line) => sum + line.length, 0));
  if ("chars" in expected) expect(turn.summary.chars).toBe(expected.chars);
});
