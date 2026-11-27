import { BOT_TASK_NEEDS_YOU_LABEL, BOT_TASK_STATUS_LABELS } from "@t3tools/client-runtime/bots";
import type { BotTaskStatus } from "@t3tools/contracts";

import { Badge } from "../ui/badge";

const STATUS_VARIANTS: Record<BotTaskStatus, "info" | "warning" | "success" | "error" | "outline"> =
  {
    accepted: "info",
    running: "info",
    waiting: "warning",
    completed: "success",
    failed: "error",
    interrupted: "outline",
    cancelled: "outline",
    skipped: "outline",
  };

export function BotTaskStatusBadge(props: {
  readonly status: BotTaskStatus;
  /** A completed result the result check did not accept as done. */
  readonly needsYou?: boolean;
}) {
  if (props.needsYou === true) return <Badge variant="warning">{BOT_TASK_NEEDS_YOU_LABEL}</Badge>;
  return (
    <Badge variant={STATUS_VARIANTS[props.status]}>{BOT_TASK_STATUS_LABELS[props.status]}</Badge>
  );
}
