import type { BotRoutineDraft } from "@t3tools/client-runtime/bots";

import { toDateTimeLocalValue } from "./scheduledTasksSettings.logic";

/** The routine form; timing fields of both kinds stay filled while the user switches between them. */
export interface BotRoutineForm {
  readonly title: string;
  readonly prompt: string;
  readonly timing: BotRoutineDraft["timing"];
  /** A `datetime-local` value in the browser's time zone. */
  readonly sessionAt: string;
  readonly leadHours: string;
  readonly timeOfDay: string;
  readonly weekdays: ReadonlyArray<number>;
}

export function botRoutineForm(draft: BotRoutineDraft): BotRoutineForm {
  const base = {
    title: draft.title,
    prompt: draft.prompt,
    sessionAt: "",
    leadHours: "24",
    timeOfDay: "09:00",
    weekdays: [],
  };
  return draft.timing === "session"
    ? {
        ...base,
        timing: "session",
        sessionAt:
          draft.sessionAtMs === null ? "" : toDateTimeLocalValue(new Date(draft.sessionAtMs)),
        leadHours: String(draft.leadMinutes / 60),
      }
    : { ...base, timing: "recurring", timeOfDay: draft.timeOfDay, weekdays: draft.weekdays };
}

/** Unparseable session or lead fields become values the shared validation rejects. */
export function botRoutineDraftFromForm(form: BotRoutineForm): BotRoutineDraft {
  const base = { title: form.title, prompt: form.prompt };
  if (form.timing === "recurring") {
    return { ...base, timing: "recurring", timeOfDay: form.timeOfDay, weekdays: form.weekdays };
  }
  const sessionAtMs = form.sessionAt === "" ? Number.NaN : new Date(form.sessionAt).getTime();
  const leadHours = form.leadHours.trim() === "" ? Number.NaN : Number(form.leadHours);
  return {
    ...base,
    timing: "session",
    sessionAtMs: Number.isNaN(sessionAtMs) ? null : sessionAtMs,
    leadMinutes: Math.round(leadHours * 60),
  };
}
