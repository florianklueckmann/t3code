/**
 * A Bot granted Calendar (this Mac), asked about its day. Source: T3B-87, the first Bot calendar
 * connection; the owner's proof asks a Bot for today's events.
 */
export interface CalendarCase {
  readonly id: string;
  readonly prompt: string;
  /** Whether the answer needs the calendar at all. */
  readonly needsCalendar: boolean;
}

export const CASES: ReadonlyArray<CalendarCase> = [
  { id: "today", prompt: "What's on my calendar today?", needsCalendar: true },
  // Control: ordinary work that must not read the calendar.
  {
    id: "no-calendar",
    prompt: "How many minutes are there in three and a half hours?",
    needsCalendar: false,
  },
];

/** Two selected calendars and one the user did not select. */
export const CALENDARS = [
  { id: "fixture-personal", title: "Personal", sourceName: "iCloud", writable: true },
  { id: "fixture-work", title: "Work", sourceName: "Google", writable: true },
  { id: "fixture-family", title: "Family", sourceName: "iCloud", writable: true },
] as const;
export const SELECTED = ["fixture-personal", "fixture-work"] as const;

/** Events relative to the run's local day, so "today" means the same thing to the model and grader. */
export const EVENTS = [
  { title: "Dentist", calendar: "fixture-personal", day: 0, start: "09:30", end: "10:00" },
  { title: "Team sync", calendar: "fixture-work", day: 0, start: "14:00", end: "15:00" },
  { title: "Recycling pickup", calendar: "fixture-personal", day: 0, allDay: true },
  { title: "Grandma's visit", calendar: "fixture-family", day: 0, start: "17:00", end: "19:00" },
  { title: "Flight to Lisbon", calendar: "fixture-work", day: 1, start: "07:15", end: "09:40" },
] as const;
export const TODAY_TITLES = ["Dentist", "Team sync", "Recycling pickup"];
export const UNSELECTED_TITLE = "Grandma's visit";
