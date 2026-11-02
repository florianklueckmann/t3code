import { useAtomValue } from "@effect/atom-react";
import { BOT_TASK_STATUS_LABELS, isBotTaskOpen } from "@t3tools/client-runtime/bots";
import type { BotTaskSummary, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { cn } from "../../lib/cn";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatBotInstant } from "../settings/botRoutineDraft";
import { reportBotFailure } from "./reportBotFailure";

/** One Bot task: its status, when it ran, and links to its work thread. */
export function BotTaskRow(props: {
  readonly environmentId: EnvironmentId;
  readonly task: BotTaskSummary;
  readonly onOpen: (threadId: ThreadId) => void;
  readonly showDetail?: boolean;
  readonly borderTop?: boolean;
}) {
  const { task } = props;
  const canCancel = useAtomValue(
    serverEnvironment.cancelBotTask.permissionAtom(props.environmentId),
  );
  const cancel = useAtomCommand(serverEnvironment.cancelBotTask, { reportFailure: false });
  const [cancelling, setCancelling] = useState(false);
  const workThreadId = task.workThreadId;
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
        "flex-row items-center gap-3 px-4 py-2",
        props.borderTop && "border-t border-border-subtle",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-sm text-foreground" numberOfLines={1}>
          {task.title}
        </Text>
        <Text
          className={cn(
            "text-xs",
            task.status === "failed" ? "text-danger-foreground" : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {BOT_TASK_STATUS_LABELS[task.status]} ·{" "}
          {formatBotInstant(task.completedAt ?? task.createdAt)}
        </Text>
        {props.showDetail && task.detail ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={2}>
            {task.detail}
          </Text>
        ) : null}
      </View>
      {isBotTaskOpen(task) && canCancel ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Cancel ${task.title}`}
          disabled={cancelling}
          hitSlop={8}
          onPress={confirmCancel}
          className="active:opacity-70 disabled:opacity-50"
        >
          <Text className="text-sm text-danger-foreground">Cancel</Text>
        </Pressable>
      ) : null}
      {workThreadId === null ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${task.title}`}
          hitSlop={8}
          onPress={() => props.onOpen(workThreadId)}
          className="active:opacity-70"
        >
          <Text className="text-sm text-primary-text">Open</Text>
        </Pressable>
      )}
    </View>
  );
}
