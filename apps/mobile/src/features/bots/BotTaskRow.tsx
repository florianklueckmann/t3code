import { useAtomValue } from "@effect/atom-react";
import { isBotTaskOpen } from "@t3tools/client-runtime/bots";
import type { BotTaskSummary, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { cn } from "../../lib/cn";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatBotInstant } from "../settings/botRoutineDraft";
import { BotTaskAction, BotTaskStatusLine } from "./BotTaskPresentation";
import { BotTaskResult, BotTaskResultSheet } from "./BotTaskResultSheet";
import { reportBotFailure } from "./reportBotFailure";

/** One Bot task: its status, when it ran, its result and a link to its work thread. */
export function BotTaskRow(props: {
  readonly environmentId: EnvironmentId;
  readonly task: BotTaskSummary;
  readonly onOpen: (threadId: ThreadId) => void;
  /** Home passes it for finished tasks only; history rows leave it out. */
  readonly onHide?: (() => void) | undefined;
  readonly showDetail?: boolean;
  readonly borderTop?: boolean;
}) {
  const { task } = props;
  const canCancel = useAtomValue(
    serverEnvironment.cancelBotTask.permissionAtom(props.environmentId),
  );
  const cancel = useAtomCommand(serverEnvironment.cancelBotTask, { reportFailure: false });
  const [resultOpen, setResultOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const workThreadId = task.workThreadId;
  const when = formatBotInstant(task.completedAt ?? task.createdAt);
  const canView = task.status === "completed";
  const showCancel = isBotTaskOpen(task) && canCancel;
  const onHide = props.onHide;
  const hasActions = canView || workThreadId !== null || showCancel || onHide !== undefined;
  const confirmCancel = () =>
    Dialog.alert("Cancel task?", task.title, [
      { text: "Keep working", style: "cancel" },
      {
        text: "Cancel task",
        style: "destructive",
        onPress: () => {
          setCancelling(true);
          void cancel({ environmentId: props.environmentId, input: { taskId: task.id } }).then(
            (result) => {
              setCancelling(false);
              reportBotFailure("Could not cancel task", result);
            },
          );
        },
      },
    ]);

  return (
    <View
      className={cn(
        // Actions carry their own touch height, so the row only needs a little padding below them.
        "gap-1 px-4 pt-3",
        hasActions ? "pb-1" : "pb-3",
        props.borderTop && "border-t border-border-subtle",
      )}
    >
      <Text className="text-sm text-foreground" numberOfLines={3}>
        {task.title}
      </Text>
      <BotTaskStatusLine status={task.status} trailing={when} numberOfLines={1} />
      {props.showDetail && task.detail ? (
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          {task.detail}
        </Text>
      ) : null}
      {hasActions ? (
        <View className="flex-row flex-wrap items-center gap-x-5">
          {canView ? (
            <BotTaskAction
              label="View result"
              icon="doc.text"
              tone="primary"
              accessibilityLabel={`View result for ${task.title}`}
              onPress={() => setResultOpen(true)}
            />
          ) : null}
          {workThreadId === null ? null : (
            <BotTaskAction
              label="Open thread"
              icon="bubble.left"
              tone="neutral"
              accessibilityLabel={`Open thread for ${task.title}`}
              onPress={() => props.onOpen(workThreadId)}
            />
          )}
          {showCancel ? (
            <BotTaskAction
              label="Cancel"
              icon="xmark"
              tone="danger"
              accessibilityLabel={`Cancel ${task.title}`}
              disabled={cancelling}
              onPress={confirmCancel}
            />
          ) : null}
          {onHide === undefined ? null : (
            <BotTaskAction
              label="Hide"
              icon="eye.slash"
              tone="neutral"
              accessibilityLabel={`Hide ${task.title} from Home`}
              onPress={onHide}
            />
          )}
        </View>
      ) : null}
      {resultOpen ? (
        <BotTaskResultSheet onClose={() => setResultOpen(false)}>
          <BotTaskResult
            environmentId={props.environmentId}
            task={task}
            when={when}
            onClose={() => setResultOpen(false)}
            onOpenThread={props.onOpen}
          />
        </BotTaskResultSheet>
      ) : null}
    </View>
  );
}
