import type { BotRoutineDraft } from "@t3tools/client-runtime/bots";

const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;

const LEAD_TIME_PRESETS = [
  0,
  15,
  30,
  HOUR_MINUTES,
  2 * HOUR_MINUTES,
  3 * HOUR_MINUTES,
  6 * HOUR_MINUTES,
  12 * HOUR_MINUTES,
  DAY_MINUTES,
  2 * DAY_MINUTES,
  7 * DAY_MINUTES,
];

export function formatLeadTime(minutes: number): string {
  if (minutes <= 0) return "When it starts";
  const days = Math.floor(minutes / DAY_MINUTES);
  const hours = Math.floor((minutes % DAY_MINUTES) / HOUR_MINUTES);
  const rest = minutes % HOUR_MINUTES;
  return [
    days > 0 ? `${days} ${days === 1 ? "day" : "days"}` : null,
    hours > 0 ? `${hours} h` : null,
    rest > 0 ? `${rest} min` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The presets, plus a saved lead time from another client that matches none of them. */
export function leadTimeOptions(current: number): ReadonlyArray<number> {
  return LEAD_TIME_PRESETS.includes(current)
    ? LEAD_TIME_PRESETS
    : [...LEAD_TIME_PRESETS, current].sort((left, right) => left - right);
}

/** Tomorrow at the next full hour, the first value the session pickers show. */
export function defaultBotSessionAtMs(nowMs: number): number {
  return Math.ceil(nowMs / 3_600_000) * 3_600_000 + DAY_MINUTES * 60_000;
}

/** Switching timing keeps the name and brief and starts the new timing from its defaults. */
export function withBotRoutineTiming(
  draft: BotRoutineDraft,
  timing: BotRoutineDraft["timing"],
): BotRoutineDraft {
  if (draft.timing === timing) return draft;
  const base = { title: draft.title, prompt: draft.prompt, allowChanges: draft.allowChanges };
  return timing === "session"
    ? { ...base, timing, sessionAtMs: null, leadMinutes: DAY_MINUTES }
    : { ...base, timing, timeOfDay: "09:00", weekdays: [] };
}

const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/** An empty list means every day, so the last remaining day cannot be turned off. */
export function toggleBotRoutineWeekday(
  weekdays: ReadonlyArray<number>,
  day: number,
): ReadonlyArray<number> {
  const current = weekdays.length === 0 ? ALL_WEEKDAYS : weekdays;
  const next = current.includes(day) ? current.filter((entry) => entry !== day) : [...current, day];
  if (next.length === 0) return weekdays;
  return next.length === ALL_WEEKDAYS.length ? [] : next;
}

export function formatBotInstant(value: string | number): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
