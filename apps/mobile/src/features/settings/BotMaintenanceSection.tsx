import { useAtomValue } from "@effect/atom-react";
import {
  BOT_MAINTENANCE_DESCRIPTION,
  botMaintenanceRunLabel,
  botMaintenanceStatusLabel,
  canRunBotMaintenance,
  canToggleBotMaintenance,
} from "@t3tools/client-runtime/bots";
import type { BotId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportBotFailure } from "../bots/reportBotFailure";
import { SettingsSection } from "./components/SettingsSection";

/** Maintenance for one project context; it saves apart from the Bot form. */
export function BotMaintenanceSection(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly formLocked: boolean;
  readonly runSupported: boolean;
}) {
  const { environmentId, botId, projectId } = props;
  const scope = { botId, projectId };
  const query = useEnvironmentQuery(
    serverEnvironment.botMaintenance({ environmentId, input: scope }),
  );
  // Failures surface in this section's own alert.
  const configure = useAtomCommand(serverEnvironment.configureBotMaintenance, {
    reportFailure: false,
  });
  const canConfigure = useAtomValue(
    serverEnvironment.configureBotMaintenance.permissionAtom(environmentId),
  );
  const runCommand = useAtomCommand(serverEnvironment.runBotMaintenance, {
    reportFailure: false,
  });
  const canRunCommand = useAtomValue(
    serverEnvironment.runBotMaintenance.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const view = query.data;
  if (view === null) return null;
  const runDisabled = running || !canRunCommand || !canRunBotMaintenance(view);

  const run = async () => {
    setRunning(true);
    setLastRun(null);
    const result = await runCommand({ environmentId, input: scope });
    setRunning(false);
    query.refresh();
    if (result._tag === "Success") setLastRun(botMaintenanceRunLabel(result.value));
    else reportBotFailure("Maintenance didn't run", result);
  };

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    const result = await configure({
      environmentId,
      input: { ...scope, baseRevision: view.revision, enabled },
    });
    setBusy(false);
    query.refresh();
    if (result._tag === "Failure") reportBotFailure("Could not change maintenance", result);
    else if (result.value._tag === "conflict")
      Dialog.alert(
        "Maintenance changed elsewhere",
        "Check the current setting, then change it again if you still want to.",
      );
  };

  return (
    <SettingsSection title={props.title}>
      <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text textRole="body" className="text-foreground">
            Maintenance
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            {BOT_MAINTENANCE_DESCRIPTION}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            {botMaintenanceStatusLabel(view)}
          </Text>
        </View>
        <ThemedSwitch
          accessibilityLabel="Maintenance"
          value={view.enabled}
          disabled={busy || !canConfigure || !canToggleBotMaintenance(view, props.formLocked)}
          onValueChange={(enabled) => void toggle(enabled)}
        />
      </View>
      {props.runSupported ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: runDisabled, busy: running }}
          disabled={runDisabled}
          onPress={() => void run()}
          className="min-h-14 gap-1 border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
        >
          <Text textRole="body" className="text-foreground">
            {running ? "Running…" : "Run now"}
          </Text>
          {lastRun !== null ? (
            <Text textRole="footnote" className="text-foreground-muted">
              {lastRun}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
    </SettingsSection>
  );
}
