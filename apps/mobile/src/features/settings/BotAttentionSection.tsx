import { useAtomValue } from "@effect/atom-react";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import {
  BOT_ALERT_LIMIT_OPTIONS,
  BOT_ALERTS_DESCRIPTION,
  BOT_REMIT_DESCRIPTION,
  botAlertsStatusLabel,
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
import * as Dialog from "../../components/ui/Dialog";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportBotFailure } from "../bots/reportBotFailure";
import { PickerRow, SelectRow } from "./components/SettingsFormRows";
import { SettingsSection } from "./components/SettingsSection";
import {
  formatTimeOfDay,
  timeOfDayFromPicker,
  timeOfDayPickerValue,
} from "./scheduledTaskPresentation";

type Edge = "start" | "end";

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
  // The iOS spinner reports every step, so a time saves when the picker closes.
  const [picking, setPicking] = useState<{ readonly edge: Edge; readonly time: string } | null>(
    null,
  );
  // The remit saves when editing ends, so each keystroke is not a save.
  const [editing, setEditing] = useState<string | null>(null);
  const view = query.data;
  if (view === null) return null;
  const disabled = busy || !canConfigure || props.formLocked || !view.writable;
  const quiet = view.quietHours;

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
    if (result._tag === "Failure") reportBotFailure("Could not change the Bot's alerts", result);
    else if (result.value._tag === "conflict")
      Dialog.alert(
        "Alerts changed elsewhere",
        "Check the current settings, then change them again if you still want to.",
      );
  };
  const pick = (next: { readonly edge: Edge; readonly time: string } | null) => {
    setPicking(next);
    props.onDraftChange(next !== null && quiet !== null && next.time !== quiet[next.edge]);
  };
  const closePicker = (next: { readonly edge: Edge; readonly time: string } | null) => {
    pick(null);
    if (next === null || quiet === null || next.time === quiet[next.edge]) return;
    const hours = { ...quiet, [next.edge]: next.time };
    if (hours.start === hours.end)
      Dialog.alert("Quiet hours need a span", "Pick an end time different from the start.");
    else void save({ quietHours: hours });
  };
  const edit = (remit: string | null) => {
    setEditing(remit);
    props.onDraftChange(remit !== null && remit.trim() !== view.remit);
  };
  const finishEditing = () => {
    const remit = editing?.trim() ?? view.remit;
    edit(null);
    if (remit !== view.remit) void save({ remit });
  };
  const timeRow = (edge: Edge, label: string) =>
    quiet === null ? null : (
      <PickerRow
        label={label}
        value={formatTimeOfDay(picking?.edge === edge ? picking.time : quiet[edge])}
        borderTop
        disabled={disabled}
        onPress={() =>
          picking?.edge === edge ? closePicker(picking) : pick({ edge, time: quiet[edge] })
        }
      />
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
      <SelectRow
        label="Alerts per day"
        value={String(view.dailyLimit)}
        borderTop
        actions={
          disabled
            ? []
            : BOT_ALERT_LIMIT_OPTIONS.map((limit) => ({
                id: String(limit),
                title: String(limit),
              }))
        }
        onSelect={(id) => {
          if (Number(id) !== view.dailyLimit) void save({ dailyLimit: Number(id) });
        }}
      />
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
          value={editing ?? view.remit}
          onFocus={() => edit(view.remit)}
          onChangeText={edit}
          onBlur={finishEditing}
          readOnly={disabled}
          maxLength={BOT_REMIT_MAX_LENGTH}
          multiline
          scrollEnabled
          textAlignVertical="top"
          className="max-h-40 min-h-20 font-sans text-base text-foreground"
        />
      </View>
      {picking === null ? null : (
        <DateTimePicker
          value={timeOfDayPickerValue(picking.time)}
          mode="time"
          display={Platform.OS === "ios" ? "spinner" : "default"}
          onDismiss={() => pick(null)}
          onValueChange={(_, selected) => {
            const next = { edge: picking.edge, time: timeOfDayFromPicker(selected) };
            if (Platform.OS === "android") closePicker(next);
            else pick(next);
          }}
        />
      )}
    </SettingsSection>
  );
}
