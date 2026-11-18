import { expect, it } from "vite-plus/test";

import { formatRelativeTimeLabel, msUntilRelativeTimeChange } from "./relativeTime.ts";

it("keeps clock-skewed timestamps at just now until a minute has elapsed", () => {
  const timestamp = "2026-11-18T07:41:50.000Z";
  const now = Date.parse("2026-11-18T07:41:30.000Z");
  const nextChange = Date.parse("2026-11-18T07:42:50.000Z");
  expect(formatRelativeTimeLabel(timestamp, now)).toBe("just now");
  expect(msUntilRelativeTimeChange(timestamp, now)).toBe(nextChange - now);
  expect(formatRelativeTimeLabel(timestamp, nextChange)).toBe("1m ago");
});
