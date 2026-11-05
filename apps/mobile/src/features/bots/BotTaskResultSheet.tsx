import {
  BOT_TASK_RESULT_UNSUPPORTED,
  BOT_TASK_STATUS_LABELS,
  botTaskResultNotice,
} from "@t3tools/client-runtime/bots";
import type { BotTaskSummary, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Sheet } from "../../components/ui/Sheet";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownImageSource } from "../../native/useMarkdownImageSource";
import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";

export function BotTaskResultSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly task: BotTaskSummary;
  readonly onClose: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.botTaskResult({
      environmentId: props.environmentId,
      input: { taskId: props.task.id },
    }),
  );
  const styles = useMarkdownPreviewStyles();
  const project = useProject({
    environmentId: props.environmentId,
    projectId: props.task.projectId,
  });
  const resolveImageSource = useMarkdownImageSource({
    environmentId: props.environmentId,
    threadId: props.task.workThreadId,
    workspaceRoot: project?.workspaceRoot ?? null,
  });
  const data = query.data;
  const workThreadId = data?.task.workThreadId ?? props.task.workThreadId;
  return (
    <Sheet title="Task result" onClose={props.onClose}>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pb-8 pt-4"
      >
        <View className="gap-1">
          <Text className="font-t3-semibold text-lg text-foreground">{props.task.title}</Text>
          <Text className="font-t3-semibold text-sm text-foreground">
            {BOT_TASK_STATUS_LABELS[data?.task.status ?? props.task.status]}
          </Text>
        </View>
        {query.error !== null ? (
          <View className="gap-2" accessibilityLiveRegion="polite">
            <Text className="text-sm text-danger-foreground">{query.error}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={query.refresh}
              className="self-start py-2 active:opacity-70"
            >
              <Text className="text-sm text-primary-text">Retry</Text>
            </Pressable>
          </View>
        ) : data === null ? (
          <Text className="text-sm text-foreground-muted">
            {query.isSuccess ? BOT_TASK_RESULT_UNSUPPORTED : "Loading saved result…"}
          </Text>
        ) : (
          <>
            {data.task.detail === null ? null : (
              <Text className="text-sm text-foreground-muted">{data.task.detail}</Text>
            )}
            {data.result.state === "available" ? (
              <SelectableMarkdownText
                markdown={data.result.text}
                textStyle={styles.nativeTextStyle}
                resolveImageSource={resolveImageSource}
                onLinkPress={(href) => void tryOpenExternalUrl(href, "markdown-link")}
              />
            ) : (
              <Text className="text-sm text-foreground-muted">{botTaskResultNotice(data)}</Text>
            )}
          </>
        )}
        {workThreadId === null ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              props.onClose();
              props.onOpenThread(workThreadId);
            }}
            className="self-start py-2 active:opacity-70"
          >
            <Text className="text-sm text-primary-text">Open thread</Text>
          </Pressable>
        )}
      </ScrollView>
    </Sheet>
  );
}
