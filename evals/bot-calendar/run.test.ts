// @effect-diagnostics globalDate:off -- Fixture days are the Mac's local calendar days.
import { expect, it } from "@effect/vitest";

import { CASES } from "./cases.ts";
import { type EventsRequest, fixtureFor, gradeSample } from "./run.ts";

const today = new Date(2026, 10, 18, 8, 0);
const caseOf = (id: string) => CASES.find((testCase) => testCase.id === id)!;
const day = fixtureFor(today).events.find((event) => event.title === "Recycling pickup")!;
const read = (start: string, end: string, calendarIds = ["fixture-personal", "fixture-work"]) =>
  ({ start, end, calendarIds }) satisfies EventsRequest;
// The run's local midnight and the next, in the same form the server sends.
const midnight = fixtureFor(today).events[0]!.start.replace(/T.*([+-]\d{2}:\d{2})$/, "T00:00:00$1");
const nextMidnight = midnight.replace("2026-11-18", "2026-11-19");
const good =
  "Today: Dentist at 9:30 AM (Personal), Team sync 14:00–15:00 (Work), and Recycling pickup all day.";

const passes = (id: string, text: string, reads: ReadonlyArray<EventsRequest>) =>
  gradeSample(caseOf(id), { text, reads, tools: [] }, today).every((check) => check.pass);

it("passes a one-day read that names today's events and the dentist's time", () => {
  expect(day.start).toBe("2026-11-18");
  expect(passes("today", good, [read(midnight, nextMidnight)])).toBe(true);
  expect(passes("today", good.replace("9:30 AM", "09:30"), [read(midnight, nextMidnight)])).toBe(
    true,
  );
});

it("fails a missing or too wide read, a missing event, or an unselected calendar", () => {
  expect(passes("today", good, [])).toBe(false);
  expect(
    passes("today", good, [read(midnight, midnight.replace("2026-11-18", "2026-11-25"))]),
  ).toBe(false);
  expect(
    passes("today", good.replace("Team sync", "a meeting"), [read(midnight, nextMidnight)]),
  ).toBe(false);
  expect(
    passes("today", good.replace("9:30 AM", "the morning"), [read(midnight, nextMidnight)]),
  ).toBe(false);
  expect(
    passes("today", good, [read(midnight, nextMidnight, ["fixture-personal", "fixture-family"])]),
  ).toBe(false);
});

it("passes the control only without a calendar read", () => {
  expect(passes("no-calendar", "210 minutes.", [])).toBe(true);
  expect(passes("no-calendar", "210 minutes.", [read(midnight, nextMidnight)])).toBe(false);
});
