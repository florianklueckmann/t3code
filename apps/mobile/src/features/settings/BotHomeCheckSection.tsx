import { useAtomValue } from "@effect/atom-react";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import {
  BOT_HOME_CHECK_DESCRIPTION,
  botHomeCheckLastLabel,
  botHomeCheckStatusLabel,
  canToggleBotHomeCheck,
} from "@t3tools/client-runtime/bots";
import type { BotId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
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

/** The daily Home check for one project context; it saves apart from the Bot form. */
export function BotHomeCheckSection(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly formLocked: boolean;
}) {
  const { environmentId, botId, projectId } = props;
  const scope = { botId, projectId };
  const query = useEnvironmentQuery(
    serverEnvironment.botHomeCheck({ environmentId, input: scope }),
  );
  // Failures surface in this section's own alert.
  const configure = useAtomCommand(serverEnvironment.configureBotHomeCheck, {
    reportFailure: false,
  });
  const canConfigure = useAtomValue(
    serverEnvironment.configureBotHomeCheck.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  // The iOS spinner reports every step, so its time saves when the picker closes.
  const [picking, setPicking] = useState<string | null>(null);
  const view = query.data;
  if (view === null) return null;
  const last = botHomeCheckLastLabel(view);

  const save = async (change: { readonly enabled: boolean; readonly timeOfDay?: string }) => {
    setBusy(true);
    const result = await configure({
      environmentId,
      input: { ...scope, baseRevision: view.revision, ...change },
    });
    setBusy(false);
    query.refresh();
    if (result._tag === "Failure") reportBotFailure("Could not change the Home check", result);
    else if (result.value._tag === "conflict")
      Dialog.alert(
        "Home check changed elsewhere",
        "Check the current setting, then change it again if you still want to.",
      );
  };
  const closePicker = (timeOfDay: string | null) => {
    setPicking(null);
    if (timeOfDay !== null && timeOfDay !== view.timeOfDay)
      void save({ enabled: view.enabled, timeOfDay });
  };

  return (
    <SettingsSection title={props.title}>
      <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text textRole="body" className="text-foreground">
            Daily Home check
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            {BOT_HOME_CHECK_DESCRIPTION}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            {botHomeCheckStatusLabel(picking === null ? view : { ...view, timeOfDay: picking })}
          </Text>
          {last === null ? null : (
            <Text textRole="footnote" className="text-foreground-muted">
              {last}
            </Text>
          )}
        </View>
        <ThemedSwitch
          accessibilityLabel="Daily Home check"
          value={view.enabled}
          disabled={busy || !canConfigure || !canToggleBotHomeCheck(view, props.formLocked)}
          onValueChange={(enabled) => void save({ enabled })}
        />
      </View>
      <PickerRow
        label="Check at"
        value={formatTimeOfDay(picking ?? view.timeOfDay)}
        borderTop
        disabled={busy || !canConfigure || props.formLocked || !view.writable}
        onPress={() => (picking === null ? setPicking(view.timeOfDay) : closePicker(picking))}
      />
      {picking === null ? null : (
        <DateTimePicker
          value={timeOfDayPickerValue(picking)}
          mode="time"
          display={Platform.OS === "ios" ? "spinner" : "default"}
          onDismiss={() => setPicking(null)}
          onValueChange={(_, selected) => {
            const timeOfDay = timeOfDayFromPicker(selected);
            if (Platform.OS === "android") closePicker(timeOfDay);
            else setPicking(timeOfDay);
          }}
        />
      )}
    </SettingsSection>
  );
}
