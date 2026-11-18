// @effect-diagnostics globalDate:off - Relative labels read the client clock outside an Effect runtime.

type RelativeTimeParts = { value: string; suffix: string | null };
export type RelativeTimeState =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "relative"; value: string; suffix: string | null };

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function relativeTimeUnitMs(elapsedMs: number): number {
  if (elapsedMs < HOUR_MS) return MINUTE_MS;
  if (elapsedMs < DAY_MS) return HOUR_MS;
  return DAY_MS;
}

/** Elapsed time floored to formatRelativeTime precision; equal labels yield equal values. */
export function relativeTimeElapsedMs(isoDate: string, nowMs: number = Date.now()): number | null {
  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) return null;
  const elapsedMs = Math.max(0, nowMs - timestamp);
  const unitMs = relativeTimeUnitMs(elapsedMs);
  return Math.floor(elapsedMs / unitMs) * unitMs;
}

export function msUntilRelativeTimeChange(
  isoDate: string,
  nowMs: number = Date.now(),
): number | null {
  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) return null;
  const elapsedMs = Math.max(0, nowMs - timestamp);
  const unitMs = relativeTimeUnitMs(elapsedMs);
  const nextChangeMs = timestamp + (Math.floor(elapsedMs / unitMs) + 1) * unitMs;
  // Delays above 2^31-1 fire immediately; cap safely and let callers reschedule.
  return Math.min(nextChangeMs - nowMs, DAY_MS);
}

export function formatRelativeElapsed(elapsedMs: number): RelativeTimeParts {
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return { value: "just now", suffix: null };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: `${minutes}m`, suffix: "ago" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: `${hours}h`, suffix: "ago" };
  const days = Math.floor(hours / 24);
  return { value: `${days}d`, suffix: "ago" };
}

export function formatRelativeTime(
  isoDate: string,
  nowMs: number = Date.now(),
): RelativeTimeParts | null {
  const elapsedMs = relativeTimeElapsedMs(isoDate, nowMs);
  return elapsedMs === null ? null : formatRelativeElapsed(elapsedMs);
}

export function formatRelativeTimeLabel(isoDate: string, nowMs: number = Date.now()) {
  const relative = formatRelativeTime(isoDate, nowMs);
  if (!relative) return "";
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}
