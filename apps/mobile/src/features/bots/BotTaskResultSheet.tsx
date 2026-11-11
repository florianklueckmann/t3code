import { BOT_TASK_RESULT_UNSUPPORTED, botTaskResultNotice } from "@t3tools/client-runtime/bots";
import type { BotTaskSummary, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Notice } from "../../components/ui/Notice";
import { Sheet } from "../../components/ui/Sheet";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownImageSource } from "../../native/useMarkdownImageSource";
import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { BotTaskAction, BotTaskStatusLine } from "./BotTaskPresentation";

/** Callers swap only the children, so iOS never presents a second sheet over a closing one. */
export function BotTaskResultSheet(props: {
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Sheet title="Task result" onClose={props.onClose}>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          gap: 16,
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Math.max(24, insets.bottom + 16),
        }}
      >
        {props.children}
      </ScrollView>
    </Sheet>
  );
}

export function BotTaskResultLoading() {
  return (
    <View className="flex-row items-center gap-2" accessibilityLiveRegion="polite">
      <AppActivityIndicator size="small" />
      <Text className="text-sm text-foreground-muted">Loading saved result…</Text>
    </View>
  );
}

export function BotTaskResult(props: {
  readonly environmentId: EnvironmentId;
  readonly task: BotTaskSummary;
  readonly when: string;
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
  const detail = data?.task.detail ?? null;
  return (
    <>
      <View className="gap-1.5">
        <Text selectable className="font-t3-semibold text-lg text-foreground">
          {props.task.title}
        </Text>
        <BotTaskStatusLine
          status={data?.task.status ?? props.task.status}
          trailing={`Final response of this run · ${props.when}`}
        />
        {detail === null ? null : (
          <Text selectable className="text-sm text-foreground-muted">
            {detail}
          </Text>
        )}
        {/* Kept above the answer so it stays reachable without scrolling a long result. */}
        {workThreadId === null ? null : (
          <View className="flex-row">
            <BotTaskAction
              label="Open thread"
              icon="bubble.left"
              tone="neutral"
              accessibilityLabel={`Open thread for ${props.task.title}`}
              onPress={() => {
                props.onClose();
                props.onOpenThread(workThreadId);
              }}
            />
          </View>
        )}
      </View>
      <View className="border-t border-border-subtle" />
      {query.error !== null ? (
        <View className="gap-3">
          <Notice tone="danger" icon="exclamationmark.triangle" message={query.error} />
          <View className="flex-row">
            <Button label="Retry" size="compact" onPress={query.refresh} />
          </View>
        </View>
      ) : data === null ? (
        query.isSuccess ? (
          <Notice icon="info.circle" message={BOT_TASK_RESULT_UNSUPPORTED} />
        ) : (
          <BotTaskResultLoading />
        )
      ) : data.result.state === "available" ? (
        <SelectableMarkdownText
          markdown={data.result.text}
          textStyle={styles.nativeTextStyle}
          resolveImageSource={resolveImageSource}
          onLinkPress={(href) => void tryOpenExternalUrl(href, "markdown-link")}
        />
      ) : (
        <Notice icon="info.circle" message={botTaskResultNotice(data) ?? ""} />
      )}
    </>
  );
}
