import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  botMcpGrantsChange,
  botMcpGrantsSection,
  codexMcpServerNames,
  latestBotMcpGrants,
  type McpConnectionStatusText,
} from "@t3tools/client-runtime/mcp-connections";
import type {
  BotId,
  BotMcpGrants,
  EnvironmentId,
  McpConnectionId,
  McpConnectionOAuthState,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportBotFailure } from "../bots/reportBotFailure";
import { useNowAfter } from "../../lib/clock";
import { SettingsSection } from "./components/SettingsSection";
import { McpConnectionSignInRows, useMcpConnectionSignIn } from "./McpConnectionSignIn";
import type { McpConnectionRoutes } from "./SettingsMcpConnectionsRouteScreen";

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
  const navigation = useNavigation<NativeStackNavigationProp<McpConnectionRoutes>>();
  const config = useEnvironmentServerConfig(environmentId);
  const bots = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const catalog = useEnvironmentQuery(serverEnvironment.mcpConnections(environmentId));
  const routines = useEnvironmentQuery(
    config?.environment.capabilities.botRoutines === true
      ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} })
      : null,
  );
  const canChange = useAtomValue(serverEnvironment.setBotMcpGrants.permissionAtom(environmentId));
  const canAdd = useAtomValue(serverEnvironment.createMcpConnection.permissionAtom(environmentId));
  // Failures surface in this section's own alert.
  const setGrants = useAtomCommand(serverEnvironment.setBotMcpGrants, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState<BotMcpGrants | null>(null);
  const now = useNowAfter(null);
  const bot = bots.data?.bots.find((entry) => entry.id === botId);
  if (bot?.mcpGrants === undefined || config === null) return null;
  const grants = latestBotMcpGrants(bot.mcpGrants, acknowledged);
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
    codexMcpServerNames: codexMcpServerNames(config.providers),
    catalog: connections,
    providerDriver: config.providers.find(
      (provider) => provider.instanceId === bot.modelSelection.instanceId,
    )?.driver,
    platformOs: config.environment.platform.os,
    environmentLabel: props.environmentLabel,
    routines: routines.data?.tasks ?? null,
    canChange,
    archived: bot.archivedAt !== null,
    now,
  });
  const oauthSupported = config.environment.capabilities.mcpConnectionsOAuth === true;
  const disabled = busy || props.formLocked || !view.editable;

  const change = async (next: Parameters<typeof botMcpGrantsChange>[3]) => {
    setBusy(true);
    const result = await setGrants({
      environmentId,
      input: botMcpGrantsChange(botId, grants, connections, next),
    });
    setBusy(false);
    if (result._tag === "Success") setAcknowledged(result.value.mcpGrants ?? null);
    // Another client's change is refused; the live Bot list then shows the newer set.
    reportBotFailure("Could not change MCP connections", result);
  };

  return (
    <SettingsSection title="MCP connections">
      {view.rows.map((row, index) => {
        const oauth = oauthSupported ? row.oauth : null;
        return (
          <View key={row.id} className={index === 0 ? "" : "border-t border-border-subtle"}>
            <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
              <View className="min-w-0 flex-1 gap-1">
                <Text textRole="body" className="text-foreground">
                  {row.label}
                </Text>
                <Text
                  textRole="footnote"
                  className={oauth === null ? TONE_CLASS[row.status.tone] : "text-foreground-muted"}
                >
                  {row.transport === null
                    ? row.status.text
                    : oauth !== null
                      ? "HTTP · OAuth"
                      : `${row.transport === "http" ? "HTTP" : "stdio"} · ${row.status.text}`}
                </Text>
              </View>
              <ThemedSwitch
                accessibilityLabel={row.label}
                value={row.granted}
                disabled={disabled}
                onValueChange={(granted) => void change({ connectionId: row.id, granted })}
              />
            </View>
            {oauth === null ? null : (
              <BotMcpGrantSignIn
                environmentId={environmentId}
                connectionId={row.id}
                label={row.label}
                fallback={oauth}
                disabled={props.formLocked}
              />
            )}
          </View>
        );
      })}
      {view.ownServers === null ? null : (
        <View
          className={
            view.rows.length === 0
              ? "min-h-14 flex-row items-center gap-3 px-4 py-3"
              : "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
          }
        >
          <View className="min-w-0 flex-1 gap-1">
            <Text textRole="body" className="text-foreground">
              {view.ownServers.label}
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              {view.ownServers.description}
            </Text>
          </View>
          <ThemedSwitch
            accessibilityLabel={view.ownServers.label}
            accessibilityHint={view.ownServers.description}
            value={view.ownServers.on}
            disabled={disabled}
            onValueChange={(on) => void change({ ownCodexMcpServers: on })}
          />
        </View>
      )}
      <View
        className={
          view.rows.length === 0 && view.ownServers === null ? "" : "border-t border-border-subtle"
        }
      >
        <ListActionRow
          label="Add connection"
          disabled={disabled || !canAdd}
          onPress={() =>
            navigation.navigate("SettingsMcpConnectionEdit", { environmentId, grantToBotId: botId })
          }
        />
      </View>
      {view.notes.map((note) => (
        <Text
          key={note.text}
          textRole="footnote"
          className={`border-t border-border-subtle px-4 py-3 ${TONE_CLASS[note.tone]}`}
        >
          {note.text}
        </Text>
      ))}
    </SettingsSection>
  );
}

/** An OAuth connection's live state in a Bot's settings, with a way back in when signed out. */
function BotMcpGrantSignIn(props: {
  readonly environmentId: EnvironmentId;
  readonly connectionId: McpConnectionId;
  readonly label: string;
  readonly fallback: McpConnectionOAuthState;
  readonly disabled: boolean;
}) {
  const signIn = useMcpConnectionSignIn({
    environmentId: props.environmentId,
    connectionId: props.connectionId,
    fallback: props.fallback,
    audience: "bot",
  });
  return <McpConnectionSignInRows signIn={signIn} label={props.label} disabled={props.disabled} />;
}
