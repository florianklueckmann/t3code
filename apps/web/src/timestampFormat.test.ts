import { describe, expect, it } from "vite-plus/test";

import {
  formatDayAwareTimestamp,
  formatRelativeTimeLabel,
  formatUpcomingTimestamp,
} from "./timestampFormat";

it("reads a save stamped ahead of this clock as just now, never as upcoming", () => {
  const now = Date.parse("2026-11-18T07:41:30.000Z");
  expect(formatRelativeTimeLabel("2026-11-18T07:41:50.000Z", now)).toBe("just now");
  expect(formatRelativeTimeLabel("2026-11-18T07:38:00.000Z", now)).toBe("3m ago");
});

describe("timestamps in an explicit time zone", () => {
  // 23:00 UTC on July 1 is 7 PM on July 1 in New York, whatever the host zone.
  const now = Date.parse("2026-07-01T23:00:00.000Z");
  const zone = "America/New_York";

  it("picks relative days from the calendar in that zone", () => {
    expect(formatUpcomingTimestamp("2026-07-02T00:30:00.000Z", "12-hour", now, zone)).not.toMatch(
      /tomorrow/,
    );
    expect(formatUpcomingTimestamp("2026-07-02T05:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^tomorrow at /,
    );
    expect(formatDayAwareTimestamp("2026-07-01T03:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^yesterday at /,
    );
  });
});
