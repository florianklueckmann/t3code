import { describe, expect, it } from "vite-plus/test";

import { botRoutineDraftFromForm, botRoutineForm } from "./botRoutineForm.logic";

describe("bot routine form", () => {
  it("round-trips a session routine through the local date input and hour lead", () => {
    const sessionAtMs = new Date(2026, 10, 5, 19, 30).getTime();
    const draft = {
      title: "Prep",
      prompt: "Recap the last session",
      allowChanges: true,
      timing: "session",
      sessionAtMs,
      leadMinutes: 90,
    } as const;

    const form = botRoutineForm(draft);

    expect(form).toMatchObject({ sessionAt: "2026-11-05T19:30", leadHours: "1.5" });
    expect(botRoutineDraftFromForm(form)).toEqual(draft);
  });

  it("does not read a blank session or lead as midnight or zero hours", () => {
    const draft = botRoutineDraftFromForm({
      ...botRoutineForm({
        title: "Prep",
        prompt: "Recap",
        allowChanges: false,
        timing: "session",
        sessionAtMs: null,
        leadMinutes: 60,
      }),
      leadHours: " ",
    });

    expect(draft).toMatchObject({ timing: "session", sessionAtMs: null });
    expect(draft.timing === "session" && Number.isNaN(draft.leadMinutes)).toBe(true);
  });
});
