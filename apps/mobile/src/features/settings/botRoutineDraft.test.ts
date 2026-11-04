import { emptyBotRoutineDraft } from "@t3tools/client-runtime/bots";
import { describe, expect, it } from "vite-plus/test";

import {
  formatLeadTime,
  leadTimeOptions,
  toggleBotRoutineWeekday,
  withBotRoutineTiming,
} from "./botRoutineDraft";

describe("formatLeadTime", () => {
  it.each([
    [0, "When it starts"],
    [45, "45 min"],
    [90, "1 h 30 min"],
    [1440, "1 day"],
    [1530, "1 day 1 h 30 min"],
    [10080, "7 days"],
  ])("formats %i minutes", (minutes, label) => {
    expect(formatLeadTime(minutes)).toBe(label);
  });
});

describe("leadTimeOptions", () => {
  it("keeps a saved lead time that matches no preset, in order", () => {
    const options = leadTimeOptions(90);
    expect(options).toContain(90);
    expect(options.indexOf(90)).toBe(options.indexOf(60) + 1);
    expect(leadTimeOptions(60)).not.toContain(90);
  });
});

describe("toggleBotRoutineWeekday", () => {
  it("treats no weekdays as every day", () => {
    expect(toggleBotRoutineWeekday([], 1)).toEqual([0, 2, 3, 4, 5, 6]);
    expect(toggleBotRoutineWeekday([0, 2, 3, 4, 5, 6], 1)).toEqual([]);
    expect(toggleBotRoutineWeekday([3], 3)).toEqual([3]);
    expect(toggleBotRoutineWeekday([3], 5)).toEqual([3, 5]);
  });
});

describe("withBotRoutineTiming", () => {
  it("keeps the name and brief and resets the timing", () => {
    const session = { ...emptyBotRoutineDraft(), prompt: "Recap", allowChanges: true };
    const recurring = withBotRoutineTiming(session, "recurring");
    expect(recurring).toEqual({
      title: session.title,
      prompt: "Recap",
      allowChanges: true,
      timing: "recurring",
      timeOfDay: "09:00",
      weekdays: [],
    });
    expect(withBotRoutineTiming(recurring, "session")).toMatchObject({
      timing: "session",
      sessionAtMs: null,
      leadMinutes: 1440,
      allowChanges: true,
    });
  });
});
