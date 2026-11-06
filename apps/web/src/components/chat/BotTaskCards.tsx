import { useAtomValue } from "@effect/atom-react";
import {
  botConversationForThread,
  botTaskCardKey,
  HiddenBotTaskCards,
  hideBotTaskCard,
  homeBotTaskCards,
  isBotTaskOpen,
  showBotTaskCards,
} from "@t3tools/client-runtime/bots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BotTaskSummary, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { EyeIcon, EyeOffIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { BotTaskResultDialog } from "./BotTaskResultDialog";
import { BotTaskStatusBadge } from "./BotTaskStatusBadge";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

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
  onHide,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: BotTaskSummary;
  /** Home passes it for finished tasks only; history rows leave it out. */
  readonly onHide?: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  const formatInstant = useUpcomingInstantFormatter();
  const canCancel = useAtomValue(serverEnvironment.cancelBotTask.permissionAtom(environmentId));
  const cancelTask = useAtomCommand(serverEnvironment.cancelBotTask, { label: "bot task cancel" });
  const [cancelling, setCancelling] = useState(false);
  const workThreadId = task.workThreadId;
  const when = formatInstant(task.completedAt ?? task.occurrenceDueAt ?? task.createdAt);
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
        <p className="font-medium wrap-anywhere">{task.title}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
          <BotTaskStatusBadge status={task.status} />
          <span>
            {when}
            {task.sessionAt === null ? null : ` · session ${formatInstant(task.sessionAt)}`}
          </span>
        </div>
        {task.detail === null ? null : (
          <p className="text-muted-foreground wrap-anywhere">{task.detail}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {task.status === "completed" ? (
          <BotTaskResultDialog
            environmentId={environmentId}
            task={task}
            when={when}
            onOpenThread={workThreadId === null ? null : openThread}
          />
        ) : null}
        {workThreadId === null ? null : (
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label={`Open thread for ${task.title}`}
            onClick={openThread}
          >
            <MessageSquareIcon aria-hidden />
            Open thread
          </Button>
        )}
        {isBotTaskOpen(task) ? (
          <Button
            size="xs"
            variant="ghost-destructive"
            aria-label={`Cancel ${task.title}`}
            disabled={!canCancel || cancelling}
            onClick={() => void cancel()}
          >
            <XIcon aria-hidden />
            Cancel
          </Button>
        ) : null}
        {onHide === undefined ? null : (
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label={`Hide ${task.title} from Home`}
            onClick={onHide}
          >
            <EyeOffIcon aria-hidden />
            Hide
          </Button>
        )}
      </div>
    </li>
  );
}

const HIDDEN_BOT_TASK_CARDS_STORAGE_KEY = "t3code:hidden-bot-task-cards:v1";

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
  const [hidden, setHidden] = useLocalStorage(
    HIDDEN_BOT_TASK_CARDS_STORAGE_KEY,
    [],
    HiddenBotTaskCards,
  );
  const loadedTasks = tasksQuery.data?.tasks ?? [];
  const { visible, hiddenKeys } = homeBotTaskCards(environmentId, loadedTasks, threadId, hidden);
  if (visible.length === 0 && hiddenKeys.length === 0) return null;
  return (
    <section
      aria-label="Bot tasks"
      className="mb-2 space-y-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs"
    >
      {visible.length === 0 ? null : (
        <ul className="space-y-2">
          {visible.map((task) => (
            <BotTaskRow
              key={task.id}
              environmentId={environmentId}
              task={task}
              onHide={
                botTaskCardKey(environmentId, task) === null
                  ? undefined
                  : () => setHidden((current) => hideBotTaskCard(current, environmentId, task))
              }
            />
          ))}
        </ul>
      )}
      {hiddenKeys.length === 0 ? null : (
        <Button
          size="xs"
          variant="ghost-muted"
          aria-label={`Show ${hiddenKeys.length} hidden finished ${hiddenKeys.length === 1 ? "task" : "tasks"}`}
          onClick={() => setHidden((current) => showBotTaskCards(current, hiddenKeys))}
        >
          <EyeIcon aria-hidden />
          {`Show ${hiddenKeys.length} hidden`}
        </Button>
      )}
    </section>
  );
}
