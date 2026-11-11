import { useAtomValue } from "@effect/atom-react";
import {
  botMcpGrantsChange,
  botMcpGrantsSection,
  type McpConnectionStatusText,
} from "@t3tools/client-runtime/mcp-connections";
import type { BotId, EnvironmentId, McpConnectionId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportBotFailure } from "../bots/reportBotFailure";
import { SettingsSection } from "./components/SettingsSection";

const TONE_CLASS: Record<McpConnectionStatusText["tone"], string> = {
  ok: "text-foreground-muted",
  muted: "text-foreground-muted",
  warning: "text-warning-foreground",
  error: "text-danger-foreground",
};

/** The MCP connections a Bot may use; each change saves the whole set apart from the Bot form. */
export function BotMcpGrantsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly botId: BotId;
  readonly formLocked: boolean;
}) {
  const { environmentId, botId } = props;
  const config = useEnvironmentServerConfig(environmentId);
  const bots = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const catalog = useEnvironmentQuery(serverEnvironment.mcpConnections(environmentId));
  const routines = useEnvironmentQuery(
    config?.environment.capabilities.botRoutines === true
      ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} })
      : null,
  );
  const canChange = useAtomValue(serverEnvironment.setBotMcpGrants.permissionAtom(environmentId));
  // Failures surface in this section's own alert.
  const setGrants = useAtomCommand(serverEnvironment.setBotMcpGrants, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const bot = bots.data?.bots.find((entry) => entry.id === botId);
  const grants = bot?.mcpGrants;
  if (bot === undefined || grants === undefined || config === null) return null;
  if (catalog.data === null) {
    return catalog.error === null ? null : (
      <SettingsSection title="MCP connections">
        <Text className="p-4 text-base text-danger-foreground">{catalog.error}</Text>
      </SettingsSection>
    );
  }
  const connections = catalog.data.connections;
  const view = botMcpGrantsSection({
    botId,
    grants,
    catalog: connections,
    providerDriver: config.providers.find(
      (provider) => provider.instanceId === bot.modelSelection.instanceId,
    )?.driver,
    platformOs: config.environment.platform.os,
    environmentLabel: props.environmentLabel,
    routines: routines.data?.tasks ?? null,
    canChange,
    archived: bot.archivedAt !== null,
  });

  const change = async (connectionId: McpConnectionId, granted: boolean) => {
    setBusy(true);
    const result = await setGrants({
      environmentId,
      input: botMcpGrantsChange(botId, grants, connections, { connectionId, granted }),
    });
    setBusy(false);
    // A stale revision is refused; the live Bot list already shows the newer set.
    reportBotFailure("Could not change MCP connections", result);
  };

  return (
    <SettingsSection title="MCP connections">
      {view.rows.map((row, index) => (
        <View
          key={row.id}
          className={
            index === 0
              ? "min-h-14 flex-row items-center gap-3 px-4 py-3"
              : "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
          }
        >
          <View className="min-w-0 flex-1 gap-1">
            <Text textRole="body" className="text-foreground">
              {row.label}
            </Text>
            <Text textRole="footnote" className={TONE_CLASS[row.status.tone]}>
              {row.transport === null
                ? row.status.text
                : `${row.transport === "http" ? "HTTP" : "stdio"} · ${row.status.text}`}
            </Text>
          </View>
          <ThemedSwitch
            accessibilityLabel={row.label}
            value={row.granted}
            disabled={busy || props.formLocked || !view.editable}
            onValueChange={(granted) => void change(row.id, granted)}
          />
        </View>
      ))}
      {view.notes.map((note, index) => (
        <Text
          key={note.text}
          textRole="footnote"
          className={`px-4 py-3 ${TONE_CLASS[note.tone]}${
            view.rows.length + index === 0 ? "" : " border-t border-border-subtle"
          }`}
        >
          {note.text}
        </Text>
      ))}
    </SettingsSection>
  );
}
