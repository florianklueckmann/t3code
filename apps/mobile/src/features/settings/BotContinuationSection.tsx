import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  BOT_TASK_STATUS_LABELS,
  botContinuationRefCaption,
  botContinuationWriterLabel,
} from "@t3tools/client-runtime/bots";
import {
  BOT_CONTINUATION_SECTIONS,
  type BotContinuationNote,
  type BotId,
  type BotTaskId,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { useState } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { formatBotInstant } from "./botRoutineDraft";
import {
  BOT_NOTE_SECTION_LABELS,
  botNoteMessagesSince,
  isEmptyBotNote,
} from "./botContinuationNotes";
import { SettingsSection } from "./components/SettingsSection";

type BotNotesRoutes = {
  SettingsBotNotes: {
    readonly environmentId: EnvironmentId;
    readonly botId: BotId;
    readonly projectId: ProjectId;
    readonly history?: boolean;
  };
};

function Chevron() {
  return (
    <SymbolView
      name="chevron.right"
      size={14}
      tintColorClassName="accent-chevron"
      type="monochrome"
    />
  );
}

export function BotNoteSections({
  note,
  captions,
}: {
  readonly note: BotContinuationNote;
  readonly captions: boolean;
}) {
  return BOT_CONTINUATION_SECTIONS.map((section) =>
    note[section].length === 0 ? null : (
      <View key={section} className="gap-1">
        <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
          {BOT_NOTE_SECTION_LABELS[section]}
        </Text>
        {note[section].map((item, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- Note entries have no IDs, and these rows have no local state.
          <View key={`${section}:${index}`} className="gap-0.5">
            <Text textRole="body" className="text-foreground">
              {item.text}
            </Text>
            {captions
              ? item.refs.map((ref) => (
                  <Text
                    key={JSON.stringify(ref)}
                    textRole="footnote"
                    className="text-foreground-muted"
                  >
                    {botContinuationRefCaption(ref)}
                  </Text>
                ))
              : null}
          </View>
        ))}
      </View>
    ),
  );
}

/** A Bot's working notes in one attached project. They save on their own screen, apart from the form. */
export function BotContinuationSection(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly disabled: boolean;
}) {
  const { environmentId, botId, projectId } = props;
  const navigation = useNavigation<NativeStackNavigationProp<BotNotesRoutes>>();
  const selectDetail = useSelectWorkspaceDetail();
  const query = useEnvironmentQuery(
    serverEnvironment.botContinuation({ environmentId, input: { botId, projectId } }),
  );
  const [taskPages, setTaskPages] = useState<BotTaskId[]>([]);
  const afterTaskId = taskPages.at(-1);
  const taskPage = useEnvironmentQuery(
    afterTaskId === undefined
      ? null
      : serverEnvironment.botContinuation({
          environmentId,
          input: { botId, projectId, afterTaskId },
        }),
  );
  const canSave = useAtomValue(serverEnvironment.saveBotContinuation.permissionAtom(environmentId));
  const view = query.data;
  const activeView = afterTaskId === undefined ? view : taskPage.data;
  const canWrite = view !== null && view.writable && canSave && !props.disabled;
  const openThread = (threadId: string) =>
    selectDetail({ name: "Thread", params: { environmentId: String(environmentId), threadId } });

  return (
    <SettingsSection title={props.title}>
      {view === null ? (
        query.error ? (
          <Text className="p-4 text-base text-danger-foreground">{query.error}</Text>
        ) : (
          <Text className="p-4 text-base text-foreground-muted">Loading working notes…</Text>
        )
      ) : (
        <>
          <View className="gap-3 px-4 py-3">
            {query.error ? (
              <Text textRole="footnote" className="text-danger-foreground">
                {query.error}
              </Text>
            ) : null}
            {view.updatedBy === null || view.updatedAt === null ? null : (
              <Text textRole="footnote" className="text-foreground-muted">
                {botContinuationWriterLabel(view.updatedBy)} · {formatBotInstant(view.updatedAt)}
                {view.restoredFrom === null ? "" : ` · restored from r${view.restoredFrom}`}
              </Text>
            )}
            {view.revision !== null && view.newerInputs.count > 0 ? (
              <Text textRole="footnote" className="text-foreground-muted">
                {botNoteMessagesSince(view.newerInputs.count)}
              </Text>
            ) : null}
            {isEmptyBotNote(view.note) ? (
              <Text textRole="body" className="text-foreground-muted">
                Nothing open.
              </Text>
            ) : (
              <BotNoteSections note={view.note} captions />
            )}
          </View>
          {taskPage.error === null ? null : (
            <Text className="px-4 py-2 text-sm text-danger-foreground">{taskPage.error}</Text>
          )}
          {taskPage.isPending ? (
            <Text className="px-4 py-2 text-sm text-foreground-muted">Loading active work…</Text>
          ) : null}
          {(activeView?.activeTasks ?? []).map((task) => (
            <Pressable
              key={task.taskId}
              accessibilityRole="button"
              accessibilityState={{ disabled: task.workThreadId === null }}
              disabled={task.workThreadId === null}
              onPress={() => task.workThreadId !== null && openThread(String(task.workThreadId))}
              className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
            >
              <View className="min-w-0 flex-1 gap-0.5">
                <Text textRole="body" className="text-foreground" numberOfLines={2}>
                  {task.title}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  Active work · {BOT_TASK_STATUS_LABELS[task.status]}
                </Text>
              </View>
              {task.workThreadId === null ? null : <Chevron />}
            </Pressable>
          ))}
          {activeView === null || activeView.moreActiveTasks === 0 ? null : (
            <Text className="border-t border-border-subtle px-4 py-3 text-sm text-foreground-muted">
              {activeView.moreActiveTasks} more active{" "}
              {activeView.moreActiveTasks === 1 ? "task" : "tasks"}.
            </Text>
          )}
          {taskPages.length === 0 ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={() => setTaskPages((pages) => pages.slice(0, -1))}
              className="min-h-14 justify-center border-t border-border-subtle px-4 py-3 active:opacity-70"
            >
              <Text textRole="body" className="text-primary-text">
                Previous tasks
              </Text>
            </Pressable>
          )}
          {activeView?.nextActiveTaskId == null ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: taskPage.isPending }}
              disabled={taskPage.isPending}
              onPress={() => {
                const cursor = activeView.nextActiveTaskId;
                if (cursor != null) setTaskPages((pages) => [...pages, cursor]);
              }}
              className="min-h-14 justify-center border-t border-border-subtle px-4 py-3 active:opacity-70"
            >
              <Text textRole="body" className="text-primary-text">
                More active tasks
              </Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              navigation.navigate("SettingsBotNotes", {
                environmentId,
                botId,
                projectId,
                ...(canWrite ? {} : { history: true }),
              })
            }
            className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
          >
            <Text textRole="body" className="min-w-0 flex-1 text-primary-text">
              {canWrite ? "Edit" : "History"}
            </Text>
            <Chevron />
          </Pressable>
        </>
      )}
    </SettingsSection>
  );
}
