import { useAtomValue } from "@effect/atom-react";
import {
  BOT_TASK_STATUS_LABELS,
  botConversationForThread,
  isBotTaskOpen,
} from "@t3tools/client-runtime/bots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BotTaskStatus, BotTaskSummary, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { BotTaskResultDialog } from "./BotTaskResultDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

const HOME_TASK_CARD_LIMIT = 3;

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

/** Formats instants in the user's timestamp format, refreshed each minute. */
export function useUpcomingInstantFormatter(): (iso: string) => string {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  return (iso) => formatUpcomingTimestamp(iso, timestampFormat, nowMs);
}

/** One Bot task: its status, when it was due or asked for, and links to its work thread. */
export function BotTaskRow({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: BotTaskSummary;
}) {
  const navigate = useNavigate();
  const formatInstant = useUpcomingInstantFormatter();
  const canCancel = useAtomValue(serverEnvironment.cancelBotTask.permissionAtom(environmentId));
  const cancelTask = useAtomCommand(serverEnvironment.cancelBotTask, { label: "bot task cancel" });
  const [cancelling, setCancelling] = useState(false);
  const workThreadId = task.workThreadId;
  const openThread = () => {
    if (workThreadId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, workThreadId)),
    });
  };
  const cancel = async () => {
    setCancelling(true);
    const result = await cancelTask({ environmentId, input: { taskId: task.id } });
    setCancelling(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not cancel the task",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  return (
    <li className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1 basis-48 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 font-medium wrap-anywhere">{task.title}</span>
          <Badge variant={STATUS_VARIANTS[task.status]}>
            {BOT_TASK_STATUS_LABELS[task.status]}
          </Badge>
        </div>
        <p className="text-muted-foreground">
          {formatInstant(task.completedAt ?? task.occurrenceDueAt ?? task.createdAt)}
          {task.sessionAt === null ? null : ` · session ${formatInstant(task.sessionAt)}`}
        </p>
        {task.detail === null ? null : (
          <p className="text-muted-foreground wrap-anywhere">{task.detail}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {task.status === "completed" ? (
          <BotTaskResultDialog
            environmentId={environmentId}
            task={task}
            onOpenThread={openThread}
          />
        ) : null}
        {workThreadId === null ? null : (
          <Button size="xs" variant="ghost-muted" onClick={openThread}>
            <MessageSquareIcon aria-hidden />
            Open thread
          </Button>
        )}
        {isBotTaskOpen(task) ? (
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={!canCancel || cancelling}
            onClick={() => void cancel()}
          >
            <XIcon aria-hidden />
            Cancel
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** The newest tasks a Bot runs from this home conversation. */
export function BotTaskCards({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const botsQuery = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const conversation =
    botsQuery.data === null ? null : botConversationForThread(botsQuery.data.bots, threadId);
  const tasksQuery = useEnvironmentQuery(
    conversation === null
      ? null
      : serverEnvironment.botTasksLive({
          environmentId,
          input: { botId: conversation.bot.id, projectId: conversation.context.projectId },
        }),
  );
  const tasks = (tasksQuery.data?.tasks ?? [])
    .filter((task) => task.homeThreadId === threadId)
    .slice(0, HOME_TASK_CARD_LIMIT);
  if (tasks.length === 0) return null;
  return (
    <section
      aria-label="Bot tasks"
      className="mb-2 rounded-lg border border-border bg-background px-3 py-2 text-xs"
    >
      <ul className="space-y-2">
        {tasks.map((task) => (
          <BotTaskRow key={task.id} environmentId={environmentId} task={task} />
        ))}
      </ul>
    </section>
  );
}
