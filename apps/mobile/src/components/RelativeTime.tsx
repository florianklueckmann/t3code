import { formatRelativeTimeLabel, msUntilRelativeTimeChange } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";
import { relativeTime } from "../lib/time";

// The React Compiler caches inline relativeTime calls on the timestamp alone.
export function RelativeTime(props: { timestamp: string; withAgo?: boolean }) {
  const subscribe = (onChange: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const delayMs = msUntilRelativeTimeChange(props.timestamp);
      if (delayMs === null) return;
      timer = setTimeout(() => {
        onChange();
        schedule();
      }, delayMs);
    };
    schedule();
    return () => clearTimeout(timer);
  };
  const getSnapshot = () =>
    props.withAgo ? formatRelativeTimeLabel(props.timestamp) : relativeTime(props.timestamp);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
