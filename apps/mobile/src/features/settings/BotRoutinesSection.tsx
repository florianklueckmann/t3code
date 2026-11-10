import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  botRoutineDraft,
  botRoutinesFor,
  describeBotRoutineTiming,
} from "@t3tools/client-runtime/bots";
import type {
  BotId,
  EnvironmentId,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotTaskRow } from "../bots/BotTaskRow";
import { reportBotFailure } from "../bots/reportBotFailure";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { formatBotInstant } from "./botRoutineDraft";
import { SettingsSection } from "./components/SettingsSection";

type BotRoutineRoutes = {
  SettingsBotRoutine: {
    readonly environmentId: EnvironmentId;
    readonly botId: BotId;
    readonly projectId: ProjectId;
    readonly taskId?: ScheduledTaskId;
  };
};

const RECENT_TASKS_SHOWN = 5;

function routineStatus(task: ScheduledTask): string {
  return [
    task.enabled ? null : "Paused",
    task.enabled && task.nextRunAt ? `Next ${formatBotInstant(task.nextRunAt)}` : null,
    task.lastRunStatus === "running"
      ? "Running"
      : task.lastRunStatus === "succeeded" && task.lastRunAt
        ? `Last ran ${formatBotInstant(task.lastRunAt)}`
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A Bot's routines and recent tasks in one attached project. */
export function BotRoutinesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly timeZone: string | undefined;
  readonly disabled: boolean;
}) {
  const { environmentId, botId, projectId } = props;
  const navigation = useNavigation<NativeStackNavigationProp<BotRoutineRoutes>>();
  const selectDetail = useSelectWorkspaceDetail();
  const scheduled = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const tasks = useEnvironmentQuery(
    serverEnvironment.botTasksLive({ environmentId, input: { botId, projectId } }),
  );
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, { reportFailure: false });
  const routines = botRoutinesFor(scheduled.data?.tasks ?? [], botId, projectId);
  const recentTasks = (tasks.data?.tasks ?? []).slice(0, RECENT_TASKS_SHOWN);
  const actionsDisabled = props.disabled || !canOperate;

  const openRoutine = (taskId?: ScheduledTaskId) =>
    navigation.navigate("SettingsBotRoutine", {
      environmentId,
      botId,
      projectId,
      ...(taskId === undefined ? {} : { taskId }),
    });

  const act = async (task: ScheduledTask, action: "toggle" | "run" | "delete") => {
    const input = { id: task.id };
    const result =
      action === "toggle"
        ? await setEnabled({ environmentId, input: { ...input, enabled: !task.enabled } })
        : action === "run"
          ? await runNow({ environmentId, input })
          : await remove({ environmentId, input });
    reportBotFailure(
      action === "toggle"
        ? task.enabled
          ? "Could not pause routine"
          : "Could not resume routine"
        : action === "run"
          ? "Could not run routine"
          : "Could not delete routine",
      result,
    );
  };

  return (
    <>
      <SettingsSection
        title={`Routines · ${props.projectTitle}`}
        footer="Each run starts a new work thread without approval prompts. Changes allowed runs in Full access; No changes can read and report but not change anything."
      >
        {scheduled.error ? (
          <Text className="p-4 text-base text-danger-foreground">{scheduled.error}</Text>
        ) : !scheduled.data ? (
          <Text className="p-4 text-base text-foreground-muted">Loading routines…</Text>
        ) : (
          routines.map((task, index) => {
            const editable = botRoutineDraft(task) !== null;
            const status = routineStatus(task);
            return (
              <View
                key={task.id}
                className={
                  index === 0
                    ? "flex-row items-start gap-1 px-4 py-3"
                    : "flex-row items-start gap-1 border-t border-border-subtle px-4 py-3"
                }
              >
                <View className="min-w-0 flex-1 gap-1">
                  <Text textRole="body" className="text-foreground" numberOfLines={1}>
                    {task.title}
                  </Text>
                  <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                    {describeBotRoutineTiming(task, formatBotInstant, props.timeZone)}
                    {task.bot?.allowChanges ? " · Changes allowed" : " · No changes"}
                  </Text>
                  {status ? (
                    <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                      {status}
                    </Text>
                  ) : null}
                  {task.lastRunStatus === "failed" && task.lastRunError ? (
                    <Text className="text-sm text-danger-foreground" numberOfLines={2}>
                      Last run failed: {task.lastRunError}
                    </Text>
                  ) : null}
                </View>
                <Menu
                  actions={[
                    ...(editable
                      ? [{ id: "edit", title: "Edit", attributes: { disabled: actionsDisabled } }]
                      : []),
                    {
                      id: "toggle",
                      title: task.enabled ? "Pause" : "Resume",
                      attributes: { disabled: actionsDisabled },
                    },
                    { id: "run", title: "Run now", attributes: { disabled: actionsDisabled } },
                    {
                      id: "delete",
                      title: "Delete",
                      attributes: { destructive: true, disabled: actionsDisabled },
                    },
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    const action = nativeEvent.event;
                    if (action === "edit") {
                      openRoutine(task.id);
                    } else if (action === "delete") {
                      Dialog.alert("Delete routine?", task.title, [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Delete",
                          style: "destructive",
                          onPress: () => void act(task, "delete"),
                        },
                      ]);
                    } else if (action === "toggle" || action === "run") {
                      void act(task, action);
                    }
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Actions for ${task.title}`}
                    className="h-11 w-11 items-center justify-center"
                  >
                    <SymbolView
                      name="ellipsis"
                      size={18}
                      tintColorClassName="accent-icon"
                      type="monochrome"
                    />
                  </Pressable>
                </Menu>
              </View>
            );
          })
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: actionsDisabled }}
          disabled={actionsDisabled}
          onPress={() => openRoutine()}
          className={
            routines.length === 0 && scheduled.data && !scheduled.error
              ? "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70 disabled:opacity-50"
              : "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
          }
        >
          <Text textRole="body" className="min-w-0 flex-1 text-foreground">
            Add routine
          </Text>
          <SymbolView name="plus" size={16} tintColorClassName="accent-icon" />
        </Pressable>
      </SettingsSection>
      {recentTasks.length > 0 ? (
        <SettingsSection title={`Recent tasks · ${props.projectTitle}`}>
          {recentTasks.map((task, index) => (
            <BotTaskRow
              key={task.id}
              environmentId={environmentId}
              task={task}
              showDetail
              borderTop={index > 0}
              onOpen={(threadId) =>
                selectDetail({
                  name: "Thread",
                  params: { environmentId: String(environmentId), threadId: String(threadId) },
                })
              }
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}
