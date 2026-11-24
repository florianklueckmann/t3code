import { useAtomValue } from "@effect/atom-react";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import {
  BOT_ALERTS_DESCRIPTION,
  BOT_REMIT_DESCRIPTION,
  botAlertsStatusLabel,
  parseBotAlertDailyLimit,
} from "@t3tools/client-runtime/bots";
import {
  BOT_ALERT_DEFAULT_QUIET_HOURS,
  BOT_REMIT_MAX_LENGTH,
  type BotAttentionView,
  type BotId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Platform, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportBotFailure } from "../bots/reportBotFailure";
import { PickerRow } from "./components/SettingsFormRows";
import { SettingsSection } from "./components/SettingsSection";
import {
  formatTimeOfDay,
  timeOfDayFromPicker,
  timeOfDayPickerValue,
} from "./scheduledTaskPresentation";

type Edge = "start" | "end";
type TimeDraft = { readonly edge: Edge; readonly time: string };

/** A Bot's alert budget and remit; each control saves apart from the Bot form. */
export function BotAttentionSection(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly formLocked: boolean;
  /** True while a picked time or the remit being edited differs from the saved one. */
  readonly onDraftChange: (unsaved: boolean) => void;
}) {
  const { environmentId, botId } = props;
  const query = useEnvironmentQuery(
    serverEnvironment.botAttention({ environmentId, input: { botId } }),
  );
  // Failures surface in this section's own alert.
  const configure = useAtomCommand(serverEnvironment.configureBotAttention, {
    reportFailure: false,
  });
  const canConfigure = useAtomValue(
    serverEnvironment.configureBotAttention.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<TimeDraft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  const view = query.data;
  if (view === null) return null;
  const disabled = busy || !canConfigure || props.formLocked || !view.writable;
  const quiet = view.quietHours;
  const remit = editing ?? view.remit;
  const limitText = limitDraft ?? String(view.dailyLimit);
  const remitChanged = remit.trim() !== view.remit;

  const save = async (
    change: Partial<Pick<BotAttentionView, "dailyLimit" | "quietHours" | "remit">>,
  ) => {
    setBusy(true);
    const result = await configure({
      environmentId,
      input: {
        botId,
        baseRevision: view.revision,
        dailyLimit: change.dailyLimit ?? view.dailyLimit,
        quietHours: change.quietHours === undefined ? view.quietHours : change.quietHours,
        remit: change.remit ?? view.remit,
      },
    });
    setBusy(false);
    query.refresh();
    if (result._tag === "Failure") {
      reportBotFailure("Could not change the Bot's alerts", result);
      return false;
    }
    if (result.value._tag === "conflict") {
      Dialog.alert(
        "Alerts changed elsewhere",
        "Check the current settings, then change them again if you still want to.",
      );
      return false;
    }
    return true;
  };
  const timeChanged = (next: TimeDraft | null) =>
    next !== null && quiet !== null && next.time !== quiet[next.edge];
  const limitChanged = (draft: string | null) =>
    draft !== null && draft.trim() !== String(view.dailyLimit);
  const pick = (next: TimeDraft | null) => {
    setPicking(next);
    props.onDraftChange(remitChanged || timeChanged(next) || limitChanged(limitDraft));
  };
  const editLimit = (draft: string | null) => {
    setLimitDraft(draft);
    props.onDraftChange(remitChanged || timeChanged(picking) || limitChanged(draft));
  };
  const saveLimit = async () => {
    const limit = parseBotAlertDailyLimit(limitText);
    if (disabled || limit === null) return;
    if (limit === view.dailyLimit || (await save({ dailyLimit: limit }))) editLimit(null);
  };
  const closePicker = (next: TimeDraft | null) => {
    pick(null);
    if (next === null || quiet === null || next.time === quiet[next.edge]) return;
    const hours = { ...quiet, [next.edge]: next.time };
    if (hours.start === hours.end)
      Dialog.alert("Quiet hours need a span", "Pick an end time different from the start.");
    else void save({ quietHours: hours });
  };
  const edit = (remit: string | null) => {
    setEditing(remit);
    props.onDraftChange(
      timeChanged(picking) ||
        limitChanged(limitDraft) ||
        (remit !== null && remit.trim() !== view.remit),
    );
  };
  const saveRemit = async () => {
    if (!disabled && remitChanged && (await save({ remit: remit.trim() }))) edit(null);
  };
  const timeRow = (edge: Edge, label: string) =>
    quiet === null ? null : (
      <>
        <PickerRow
          label={label}
          value={formatTimeOfDay(picking?.edge === edge ? picking.time : quiet[edge])}
          borderTop
          disabled={disabled}
          onPress={() =>
            picking?.edge === edge ? closePicker(picking) : pick({ edge, time: quiet[edge] })
          }
        />
        {picking?.edge === edge ? (
          <View className="px-4 pb-3">
            <DateTimePicker
              value={timeOfDayPickerValue(picking.time)}
              mode="time"
              display={Platform.OS === "ios" ? "compact" : "default"}
              disabled={disabled}
              onDismiss={() => pick(null)}
              onValueChange={(_, selected) => {
                const next = { edge, time: timeOfDayFromPicker(selected) };
                if (Platform.OS === "android") closePicker(next);
                else pick(next);
              }}
            />
          </View>
        ) : null}
      </>
    );

  return (
    <SettingsSection title="Alerts">
      <View className="min-h-14 gap-1 px-4 py-3">
        <Text textRole="footnote" className="text-foreground-muted">
          {BOT_ALERTS_DESCRIPTION}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {botAlertsStatusLabel(view)}
        </Text>
      </View>
      <View className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3">
        <Text textRole="body" className="min-w-0 flex-1 text-foreground">
          Alerts per day
        </Text>
        <TextInput
          accessibilityLabel="Alerts per day"
          value={limitText}
          onChangeText={editLimit}
          readOnly={disabled}
          keyboardType="number-pad"
          returnKeyType="done"
          selectTextOnFocus
          onSubmitEditing={() => void saveLimit()}
          className="min-w-12 text-right font-sans text-base text-foreground"
        />
        {limitChanged(limitDraft) ? (
          <Button
            label="Save"
            accessibilityLabel="Save alerts per day"
            size="compact"
            disabled={disabled || parseBotAlertDailyLimit(limitText) === null}
            onPress={() => void saveLimit()}
          />
        ) : null}
      </View>
      <View className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3">
        <Text textRole="body" className="min-w-0 flex-1 text-foreground">
          Quiet hours (server time)
        </Text>
        <ThemedSwitch
          accessibilityLabel="Quiet hours"
          value={quiet !== null}
          disabled={disabled}
          onValueChange={(on) =>
            void save({ quietHours: on ? BOT_ALERT_DEFAULT_QUIET_HOURS : null })
          }
        />
      </View>
      {timeRow("start", "From")}
      {timeRow("end", "To")}
      <View className="gap-2 border-t border-border-subtle px-4 py-3">
        <Text className="text-sm text-foreground-muted">Remit</Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {BOT_REMIT_DESCRIPTION}
        </Text>
        <TextInput
          accessibilityLabel="Remit"
          placeholder="e.g. Only school deadlines and bills need me."
          value={remit}
          onChangeText={edit}
          readOnly={disabled}
          maxLength={BOT_REMIT_MAX_LENGTH}
          multiline
          scrollEnabled
          textAlignVertical="top"
          className="max-h-40 min-h-20 font-sans text-base text-foreground"
        />
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          <Text textRole="footnote" className="text-foreground-muted">
            {`${remit.length} / ${BOT_REMIT_MAX_LENGTH}`}
          </Text>
          <Button
            label="Save changes"
            accessibilityLabel="Save remit changes"
            size="compact"
            disabled={disabled || !remitChanged}
            onPress={() => void saveRemit()}
          />
        </View>
      </View>
    </SettingsSection>
  );
}
