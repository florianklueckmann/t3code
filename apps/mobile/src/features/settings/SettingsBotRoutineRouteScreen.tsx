import { useAtomValue } from "@effect/atom-react";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import {
  botRoutineDraft,
  botRoutineUpsertInput,
  emptyBotRoutineDraft,
  type BotRoutineDraft,
} from "@t3tools/client-runtime/bots";
import { CommandId } from "@t3tools/contracts";
import type {
  BotId,
  BotSummary,
  EnvironmentId,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
} from "@t3tools/contracts";
import { useRef, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportBotFailure } from "../bots/reportBotFailure";
import {
  defaultBotSessionAtMs,
  formatLeadTime,
  leadTimeOptions,
  toggleBotRoutineWeekday,
  withBotRoutineTiming,
} from "./botRoutineDraft";
import { FormField, PickerRow, SelectRow } from "./components/SettingsFormRows";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  formatTimeOfDay,
  repeatLabel,
  timeOfDayFromPicker,
  timeOfDayPickerValue,
  WEEKDAYS,
} from "./scheduledTaskPresentation";

const ROUTINE_TITLE_MAX = 120;
const ROUTINE_PROMPT_MAX = 16_000;

export function SettingsBotRoutineRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly projectId: ProjectId;
  /** Absent for a new routine. */
  readonly taskId?: ScheduledTaskId;
}>) {
  const { environmentId, botId, projectId, taskId } = route.params;
  const config = useEnvironmentServerConfig(environmentId);
  const bots = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const scheduled = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const bot = bots.data?.bots.find((entry) => entry.id === botId);
  const attached =
    bot !== undefined &&
    bot.archivedAt === null &&
    bot.projects.some((project) => project.projectId === projectId && project.detachedAt === null);
  const task =
    taskId === undefined ? null : scheduled.data?.tasks.find((entry) => entry.id === taskId);
  const initialDraft =
    taskId === undefined ? emptyBotRoutineDraft() : task ? botRoutineDraft(task) : null;

  const unavailable =
    config?.environment.capabilities.botRoutines !== true
      ? "Update T3 Code on this environment to use routines."
      : bots.error || scheduled.error
        ? (bots.error ?? scheduled.error)
        : !bots.data || !scheduled.data
          ? null
          : !attached
            ? "This Bot no longer works in this project."
            : task === undefined
              ? "This routine no longer exists."
              : initialDraft === null
                ? "This routine's timing can't be edited here. You can still pause, run or delete it."
                : null;

  const title = taskId === undefined ? "New routine" : "Edit routine";
  if (unavailable === null && bot && initialDraft && task !== undefined) {
    return (
      <BotRoutineForm
        key={taskId ?? "new"}
        environmentId={environmentId}
        bot={bot}
        projectId={projectId}
        task={task}
        initialDraft={initialDraft}
        timeZone={config?.environment.timeZone}
        title={title}
      />
    );
  }
  return (
    <BotRoutineScreen title={title}>
      <Text className="px-2 text-base text-foreground-muted">
        {unavailable ?? "Loading routine…"}
      </Text>
    </BotRoutineScreen>
  );
}

function BotRoutineScreen(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly guardBack?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={props.title} guardBack={props.guardBack}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {props.children}
      </ScrollView>
    </SettingsScreen>
  );
}

function BotRoutineForm(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: BotSummary;
  readonly projectId: ProjectId;
  /** The live routine being edited; null for a new one. */
  readonly task: ScheduledTask | null;
  readonly initialDraft: BotRoutineDraft;
  readonly timeZone: string | undefined;
  readonly title: string;
}) {
  const { environmentId, task } = props;
  const navigation = useNavigation();
  const [baseline] = useState(props.initialDraft);
  const [draft, setDraftState] = useState(props.initialDraft);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState<"date" | "time" | "timeOfDay" | null>(null);
  // A retried create returns the same routine instead of adding a second one.
  const [commandId] = useState(() => CommandId.make(uuidv4()));
  const submissionPending = useRef(false);
  // Set once the save lands, so the removal guard lets the editor close.
  const saved = useRef(false);
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask, { reportFailure: false });
  const hasChanges = JSON.stringify(draft) !== JSON.stringify(baseline);
  const preventRemove = hasChanges || saving;

  usePreventRemove(preventRemove, ({ data }) => {
    if (saved.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (saving) {
      Dialog.alert("Saving routine", "Wait for the routine to finish saving before leaving.");
      return;
    }
    Dialog.alert("Discard changes?", "Your unsaved changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard changes",
        style: "destructive",
        onPress: () => navigation.dispatch(data.action),
      },
    ]);
  });

  const setDraft = (next: BotRoutineDraft) => {
    if (saving) return;
    setError(null);
    setDraftState(next);
  };

  const save = async () => {
    if (submissionPending.current || !canOperate) return;
    const result = botRoutineUpsertInput(
      draft,
      {
        botId: props.bot.id,
        projectId: props.projectId,
        modelSelection: props.bot.modelSelection,
        ...(task ? { id: task.id, enabled: task.enabled } : { commandId }),
      },
      Date.now(),
    );
    if ("error" in result) {
      setError(result.error);
      return;
    }
    submissionPending.current = true;
    setSaving(true);
    const response = await upsert({ environmentId, input: result.input });
    submissionPending.current = false;
    setSaving(false);
    if (response._tag === "Failure") {
      reportBotFailure("Could not save routine", response);
      return;
    }
    saved.current = true;
    if (navigation.isFocused()) navigation.goBack();
  };

  return (
    <BotRoutineScreen title={props.title} guardBack={preventRemove}>
      <View
        className="gap-5"
        pointerEvents={saving ? "none" : "auto"}
        accessibilityElementsHidden={saving}
        importantForAccessibility={saving ? "no-hide-descendants" : "auto"}
      >
        <SettingsSection title={props.bot.name}>
          <FormField
            label="Name"
            value={draft.title}
            placeholder="Routine name"
            maxLength={ROUTINE_TITLE_MAX}
            disabled={saving}
            onChange={(title) => setDraft({ ...draft, title })}
          />
          <FormField
            label="Brief"
            value={draft.prompt}
            placeholder="What should the Bot do on each run?"
            multiline
            maxLength={ROUTINE_PROMPT_MAX}
            borderTop
            disabled={saving}
            onChange={(prompt) => setDraft({ ...draft, prompt })}
          />
        </SettingsSection>
        <SettingsSection
          title="Changes"
          footer={
            draft.allowChanges
              ? "The Bot is instructed to carry out the edits or messages requested in the brief."
              : "The Bot is instructed to report results and propose changes without editing files or data or sending messages."
          }
        >
          <View className="px-4 py-3">
            <SegmentedControl
              variant="card"
              options={[
                { value: "none", label: "No changes" },
                { value: "allow", label: "Changes allowed" },
              ]}
              selected={draft.allowChanges ? "allow" : "none"}
              onSelect={(value) => setDraft({ ...draft, allowChanges: value === "allow" })}
            />
          </View>
        </SettingsSection>
        <SettingsSection
          title="Timing"
          footer={
            draft.timing === "session"
              ? "Runs once. If the event has already started when the run is due, it is skipped."
              : props.timeZone
                ? `Runs at this time in ${props.timeZone}, the environment's time zone.`
                : "Runs at this time in the environment's time zone, which may differ from your phone's."
          }
        >
          <View className="px-4 py-3">
            <SegmentedControl
              variant="card"
              options={[
                { value: "session", label: "Before an event" },
                { value: "recurring", label: "Recurring" },
              ]}
              selected={draft.timing}
              onSelect={(timing) => {
                setPicker(null);
                setDraft(withBotRoutineTiming(draft, timing));
              }}
            />
          </View>
          {draft.timing === "session" ? (
            <>
              {(["date", "time"] as const).map((field) => {
                const sessionAt = draft.sessionAtMs === null ? null : new Date(draft.sessionAtMs);
                const label =
                  sessionAt === null
                    ? "Choose"
                    : field === "date"
                      ? sessionAt.toLocaleDateString([], {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      : sessionAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                return (
                  <View key={field}>
                    <PickerRow
                      label={field === "date" ? "Event date" : "Event time"}
                      value={label}
                      borderTop
                      disabled={saving}
                      onPress={() => {
                        if (draft.sessionAtMs === null) {
                          setDraft({ ...draft, sessionAtMs: defaultBotSessionAtMs(Date.now()) });
                        }
                        setPicker((open) => (open === field ? null : field));
                      }}
                    />
                    {picker === field && sessionAt !== null ? (
                      <DateTimePicker
                        value={sessionAt}
                        mode={field}
                        display={Platform.OS === "ios" ? "spinner" : "default"}
                        onDismiss={() => setPicker(null)}
                        onValueChange={(_, selected) => {
                          // Android shows a dialog that closes on pick; iOS stays inline.
                          if (Platform.OS === "android") setPicker(null);
                          setDraft({ ...draft, sessionAtMs: selected.getTime() });
                        }}
                      />
                    ) : null}
                  </View>
                );
              })}
              <SelectRow
                label="Run"
                value={
                  draft.leadMinutes === 0
                    ? "When it starts"
                    : `${formatLeadTime(draft.leadMinutes)} before`
                }
                borderTop
                actions={
                  saving
                    ? []
                    : leadTimeOptions(draft.leadMinutes).map((minutes) => ({
                        id: String(minutes),
                        title:
                          minutes === 0 ? "When it starts" : `${formatLeadTime(minutes)} before`,
                        state: minutes === draft.leadMinutes ? ("on" as const) : undefined,
                      }))
                }
                onSelect={(id) => {
                  const leadMinutes = Number(id);
                  if (Number.isInteger(leadMinutes)) setDraft({ ...draft, leadMinutes });
                }}
              />
            </>
          ) : (
            <>
              <PickerRow
                label="Time"
                value={formatTimeOfDay(draft.timeOfDay)}
                borderTop
                disabled={saving}
                onPress={() => setPicker((open) => (open === "timeOfDay" ? null : "timeOfDay"))}
              />
              {picker === "timeOfDay" ? (
                <DateTimePicker
                  value={timeOfDayPickerValue(draft.timeOfDay)}
                  mode="time"
                  display={Platform.OS === "ios" ? "spinner" : "default"}
                  onDismiss={() => setPicker(null)}
                  onValueChange={(_, selected) => {
                    if (Platform.OS === "android") setPicker(null);
                    setDraft({ ...draft, timeOfDay: timeOfDayFromPicker(selected) });
                  }}
                />
              ) : null}
              <SelectRow
                label="Repeat"
                value={draft.weekdays.length === 0 ? "Every day" : repeatLabel(draft.weekdays)}
                borderTop
                actions={
                  saving
                    ? []
                    : [
                        {
                          id: "every_day",
                          title: "Every day",
                          state: draft.weekdays.length === 0 ? ("on" as const) : undefined,
                        },
                        {
                          id: "weekdays",
                          title: "Weekdays",
                          state:
                            repeatLabel(draft.weekdays) === "Weekdays"
                              ? ("on" as const)
                              : undefined,
                        },
                        ...WEEKDAYS.map((day) => ({
                          id: String(day.index),
                          title: day.label,
                          attributes: { keepsMenuPresented: true },
                          state:
                            draft.weekdays.length === 0 || draft.weekdays.includes(day.index)
                              ? ("on" as const)
                              : undefined,
                        })),
                      ]
                }
                onSelect={(id) => {
                  const weekdays =
                    id === "every_day"
                      ? []
                      : id === "weekdays"
                        ? [1, 2, 3, 4, 5]
                        : WEEKDAYS.some((day) => String(day.index) === id)
                          ? toggleBotRoutineWeekday(draft.weekdays, Number(id))
                          : draft.weekdays;
                  setDraft({ ...draft, weekdays });
                }}
              />
            </>
          )}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          Each run starts a task in a new work thread in this project, without approval prompts.
          Changes allowed runs in Full access; No changes can read and report but not change
          anything.
        </Text>
        {error !== null ? (
          <Text className="px-2 text-sm text-danger-foreground">{error}</Text>
        ) : null}
      </View>
      <Button
        tone="primary"
        fullWidth
        loading={saving}
        disabled={!canOperate}
        onPress={() => void save()}
        label={saving ? "Saving…" : task ? "Save changes" : "Add routine"}
      />
    </BotRoutineScreen>
  );
}
