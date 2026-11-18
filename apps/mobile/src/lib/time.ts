// Host timestamps may carry UTC offsets or mixed fractions, so text order is not time order.
export function compareTimestamps(left: string, right: string): number {
  return (Date.parse(left) || 0) - (Date.parse(right) || 0);
}

export function byTimestamp(newestFirst: boolean) {
  return (left: { readonly date: string }, right: { readonly date: string }) =>
    newestFirst
      ? compareTimestamps(right.date, left.date)
      : compareTimestamps(left.date, right.date);
}

export function relativeTime(input: string, nowMs: number = Date.now()): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return "<1m";
  }

  const deltaSeconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (deltaSeconds < 60) return "<1m";

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m`;

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h`;

  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d`;
}

export { msUntilRelativeTimeChange } from "@t3tools/client-runtime/clock";
