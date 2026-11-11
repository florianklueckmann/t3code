import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  botMcpGrantsChange,
  emptyMcpConnectionDraft,
  MCP_CONNECTIONS_NOTICE,
  mcpConnectionDisconnectMessage,
  mcpConnectionDraft,
  mcpConnectionOAuthCallback,
  mcpConnectionRemovalMessage,
  mcpConnectionStatusText,
  mcpConnectionUsage,
  mcpConnectionUsedByText,
  planMcpConnectionSave,
  type McpConnectionDraft,
  type McpConnectionStatusText,
  type McpConnectionUsage,
} from "@t3tools/client-runtime/mcp-connections";
import {
  configuredSecretSources,
  secretRequestReference,
} from "@t3tools/client-runtime/secret-request";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isSecretReference,
  MCP_CONNECTION_LABEL_MAX_LENGTH,
  MCP_CONNECTION_OAUTH_CALLBACK_PATH,
  McpConnectionId,
  resolveEnvironmentMachineKind,
  type BotId,
  type EnvironmentId,
  type McpConnectionDefinition,
  type McpConnectionSummary,
  type SecretProviderId,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import Constants from "expo-constants";
import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SecretTextInput } from "../../components/ui/SecretTextInput";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportBotFailure as reportFailure } from "../bots/reportBotFailure";
import { McpConnectionSignInRows, useMcpConnectionSignIn } from "./McpConnectionSignIn";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { FormField, SelectRow } from "./components/SettingsFormRows";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

export type McpConnectionRoutes = {
  SettingsMcpConnectionEdit: {
    readonly environmentId: EnvironmentId;
    readonly connectionId?: McpConnectionId;
    /** Opened from a Bot's settings: a new connection is granted to that Bot. */
    readonly grantToBotId?: BotId;
  };
};

export function SettingsMcpConnectionsRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { availableTargets, selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="MCP connections" menus={[environmentMenu]}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm text-foreground-muted">{MCP_CONNECTIONS_NOTICE}</Text>
        {selectedTargets.length > 0 ? (
          selectedTargets.map((environment) => (
            <SettingsSection
              key={environment.environmentId}
              title={environment.label}
              titleIcon={
                <EnvironmentMachineSymbol
                  kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                  size={16}
                  tintColorClassName={
                    Platform.OS === "android" ? "accent-primary" : "accent-foreground-muted"
                  }
                />
              }
            >
              {environment.serverConfig.environment.capabilities.mcpConnections === true ? (
                <EnvironmentMcpConnections environment={environment} />
              ) : (
                <Text className="p-4 text-base text-foreground-muted">
                  Update T3 Code on this environment to manage MCP connections.
                </Text>
              )}
            </SettingsSection>
          ))
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            {availableTargets.length === 0
              ? "Connect an environment to manage its MCP connections."
              : "No environments match these filters. Change the filter above."}
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function EnvironmentMcpConnections({ environment }: { readonly environment: SettingsTarget }) {
  const environmentId = environment.environmentId;
  const navigation = useNavigation<NativeStackNavigationProp<McpConnectionRoutes>>();
  const definitions = environment.serverConfig.settings.mcpConnections;
  const statuses = useEnvironmentQuery(serverEnvironment.mcpConnections(environmentId));
  const canEdit = useAtomValue(serverEnvironment.createMcpConnection.permissionAtom(environmentId));
  const canRefresh = useAtomValue(
    serverEnvironment.refreshMcpConnections.permissionAtom(environmentId),
  );
  const refresh = useAtomCommand(serverEnvironment.refreshMcpConnections, {
    label: "mcp connections refresh",
  });
  const { usage } = useMcpConnectionUsage(environmentId);
  const oauthSupported =
    environment.serverConfig.environment.capabilities.mcpConnectionsOAuth === true;
  const [refreshing, setRefreshing] = useState(false);
  const entries = Object.entries(definitions) as Array<[McpConnectionId, McpConnectionDefinition]>;
  const summaries = new Map(statuses.data?.connections.map((summary) => [summary.id, summary]));
  return (
    <>
      {entries.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">
          No MCP connections. Add one connection per account.
        </Text>
      ) : (
        entries.map(([id, definition]) => {
          const row = {
            environmentId,
            id,
            definition,
            summary: summaries.get(id),
            statusError: statuses.error,
            usage,
            onPress: () =>
              navigation.navigate("SettingsMcpConnectionEdit", {
                environmentId,
                connectionId: id,
              }),
          };
          return oauthSupported &&
            definition.transport.type === "http" &&
            definition.transport.oauth !== undefined ? (
            <OAuthMcpConnectionRow key={id} {...row} />
          ) : (
            <McpConnectionRow key={id} {...row} oauthStatus={null} />
          );
        })
      )}
      {entries.length > 0 ? (
        <ListActionRow
          label="Refresh credentials"
          loading={refreshing}
          disabled={!canRefresh}
          onPress={async () => {
            setRefreshing(true);
            const result = await refresh({
              environmentId,
              input: { connectionIds: entries.map(([id]) => id) },
            });
            setRefreshing(false);
            reportFailure("Could not refresh MCP connections", result);
          }}
        />
      ) : null}
      <ListActionRow
        label="Add connection"
        disabled={!canEdit}
        onPress={() => navigation.navigate("SettingsMcpConnectionEdit", { environmentId })}
      />
    </>
  );
}

interface McpConnectionRowProps {
  readonly environmentId: EnvironmentId;
  readonly id: McpConnectionId;
  readonly definition: McpConnectionDefinition;
  readonly summary: McpConnectionSummary | undefined;
  readonly statusError: string | null;
  readonly usage: McpConnectionUsage;
  readonly onPress: () => void;
}

function OAuthMcpConnectionRow(props: McpConnectionRowProps) {
  const signIn = useMcpConnectionSignIn({
    environmentId: props.environmentId,
    connectionId: props.id,
    fallback: props.summary?.oauth,
    audience: "catalog",
  });
  return <McpConnectionRow {...props} oauthStatus={signIn.view} />;
}

function McpConnectionRow({
  id,
  definition,
  summary,
  statusError,
  usage,
  onPress,
  oauthStatus,
}: McpConnectionRowProps & { readonly oauthStatus: McpConnectionStatusText | null }) {
  const status =
    oauthStatus ??
    mcpConnectionStatusText(summary?.revision === definition.revision ? summary.status : undefined);
  return (
    <ListActionRow
      label={definition.label}
      description={[
        definition.transport.type === "http" ? "HTTP" : "stdio",
        definition.enabled ? null : "Disabled",
        oauthStatus === null ? (statusError ?? status.text) : status.text,
        mcpConnectionUsedByText(usage, id),
      ]
        .filter((part) => part !== null)
        .join(" · ")}
      onPress={onPress}
    />
  );
}

function useMcpConnectionUsage(environmentId: EnvironmentId) {
  const config = useEnvironmentServerConfig(environmentId);
  const botsSupported = config?.environment.capabilities.bots === true;
  const bots = useEnvironmentQuery(
    botsSupported ? serverEnvironment.botsLive({ environmentId, input: {} }) : null,
  );
  return {
    usage: mcpConnectionUsage({ botsSupported, bots: bots.data?.bots ?? null, error: bots.error }),
    retry: bots.refresh,
  };
}

interface BindingRow {
  readonly key: string;
  readonly name: string;
  readonly value: SettingsSecretValue;
  readonly saved: string | undefined;
  /** Reference text being typed for a secret provider, before it is a valid reference. */
  readonly referenceText: string;
  readonly source: SecretProviderId | null;
}

export function SettingsMcpConnectionEditRouteScreen({
  route,
}: StaticScreenProps<McpConnectionRoutes["SettingsMcpConnectionEdit"]>) {
  const { environmentId, connectionId, grantToBotId } = route.params;
  const catalog = useEnvironmentServerConfig(environmentId)?.settings.mcpConnections;
  const saved = connectionId === undefined ? undefined : catalog?.[connectionId];
  // The revision this form opened on; a concurrent edit makes the save fail instead of losing it.
  const [opened] = useState(saved);
  const [newId] = useState(() => McpConnectionId.make(uuidv4()));
  if (connectionId !== undefined && opened === undefined) {
    return (
      <SettingsScreen title="MCP connection">
        <Text className="p-5 text-base text-foreground-muted">
          This MCP connection no longer exists.
        </Text>
      </SettingsScreen>
    );
  }
  return (
    <McpConnectionEditor
      environmentId={environmentId}
      target={
        connectionId !== undefined && opened !== undefined
          ? { kind: "update", connectionId, saved: opened }
          : { kind: "create", connectionId: newId }
      }
      current={saved}
      {...(grantToBotId === undefined ? {} : { grantToBotId })}
    />
  );
}

function McpConnectionEditor({
  environmentId,
  target,
  current,
  grantToBotId,
}: {
  readonly environmentId: EnvironmentId;
  readonly target:
    | { readonly kind: "create"; readonly connectionId: McpConnectionId }
    | {
        readonly kind: "update";
        readonly connectionId: McpConnectionId;
        readonly saved: McpConnectionDefinition;
      };
  readonly current: McpConnectionDefinition | undefined;
  readonly grantToBotId?: BotId;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const config = useEnvironmentServerConfig(environmentId);
  const sources =
    Constants.expoConfig?.extra?.secretsFeatureEnabled === true && config?.secretReferences
      ? configuredSecretSources(config.settings.secretProviders)
      : [];
  const { usage, retry: retryUsage } = useMcpConnectionUsage(environmentId);
  const removalMessage = mcpConnectionRemovalMessage(usage, target.connectionId);
  const canEdit = useAtomValue(serverEnvironment.createMcpConnection.permissionAtom(environmentId));
  const canRefresh = useAtomValue(
    serverEnvironment.refreshMcpConnections.permissionAtom(environmentId),
  );
  const create = useAtomCommand(serverEnvironment.createMcpConnection, {
    label: "mcp connection create",
  });
  const update = useAtomCommand(serverEnvironment.updateMcpConnection, {
    label: "mcp connection update",
  });
  const remove = useAtomCommand(serverEnvironment.removeMcpConnection, {
    label: "mcp connection remove",
  });
  const refresh = useAtomCommand(serverEnvironment.refreshMcpConnections, {
    label: "mcp connection refresh",
  });
  const statuses = useEnvironmentQuery(serverEnvironment.mcpConnections(environmentId));
  const grantBots = useEnvironmentQuery(
    grantToBotId === undefined ? null : serverEnvironment.botsLive({ environmentId, input: {} }),
  );
  const grantBot = grantBots.data?.bots.find((bot) => bot.id === grantToBotId);
  const setGrants = useAtomCommand(serverEnvironment.setBotMcpGrants, {
    label: "bot set mcp grants",
  });
  const editing = target.kind === "update";
  const oauthSupported = config?.environment.capabilities.mcpConnectionsOAuth === true;
  const initial = editing
    ? mcpConnectionDraft(target.saved)
    : emptyMcpConnectionDraft(oauthSupported);
  const [draft, setDraft] = useState<Omit<McpConnectionDraft, "bindings">>(initial);
  const [bindings, setBindings] = useState<ReadonlyArray<BindingRow>>(() =>
    initial.bindings.map(({ name, value }) => ({
      key: uuidv4(),
      name,
      value,
      saved: typeof value === "string" && value !== "" ? value : undefined,
      referenceText: isSecretReference(value) ? value.reference : "",
      source: isSecretReference(value) ? value.provider : null,
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false);
  const [ownAppOpen, setOwnAppOpen] = useState(false);
  const isHttp = draft.transport === "http";
  const isOAuth = isHttp && draft.auth === "oauth";
  const bindingNoun = isHttp ? "Header" : "Environment variable";
  const setBinding = (key: string, next: Partial<BindingRow>) =>
    setBindings((rows) => rows.map((row) => (row.key === key ? { ...row, ...next } : row)));
  const summary = statuses.data?.connections.find(({ id }) => id === target.connectionId);
  const status =
    current !== undefined && summary?.revision === current.revision ? summary.status : undefined;
  const showAccount = oauthSupported && isOAuth && (created || editing);
  const signIn = useMcpConnectionSignIn({
    environmentId,
    connectionId: target.connectionId,
    fallback: summary?.oauth,
    audience: "catalog",
    active: showAccount,
  });
  const prepared = usePreparedConnection(environmentId);
  const redirectUri = `${
    mcpConnectionOAuthCallback({
      httpBaseUrl: prepared._tag === "Some" ? prepared.value.httpBaseUrl : null,
      canListenOnLoopback: false,
    }).redirectOrigin
  }${MCP_CONNECTION_OAUTH_CALLBACK_PATH}`;
  const connectedAfterCreate = created && signIn.view.connected;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leaves once the server reports the new account connected, which arrives on its own stream
  useEffect(() => {
    if (connectedAfterCreate) navigation.goBack();
  }, [connectedAfterCreate, navigation]);

  const save = async () => {
    const pendingReference = bindings.find(
      (row) => row.source !== null && !isSecretReference(row.value),
    );
    if (pendingReference !== undefined) {
      setError(`Enter a valid secret reference for ${pendingReference.name || bindingNoun}.`);
      return;
    }
    const plan = planMcpConnectionSave(
      { ...draft, bindings: bindings.map(({ name, value }) => ({ name, value })) },
      target,
    );
    if (plan.kind === "invalid") {
      setError(plan.message);
      return;
    }
    setBusy(true);
    const result =
      plan.kind === "create"
        ? await create({ environmentId, input: plan.input })
        : await update({ environmentId, input: plan.input });
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "The request failed.");
      return;
    }
    if (plan.kind === "create" && grantToBotId !== undefined && grantBot?.mcpGrants !== undefined) {
      const granted = await setGrants({
        environmentId,
        input: botMcpGrantsChange(
          grantToBotId,
          grantBot.mcpGrants,
          statuses.data?.connections ?? [],
          { connectionId: plan.input.connectionId, granted: true },
        ),
      });
      reportFailure(`Could not give ${grantBot.name} this connection`, granted);
    }
    if (plan.kind === "create" && isOAuth) {
      setCreated(true);
      await signIn.connect();
      return;
    }
    navigation.goBack();
  };

  if (created) {
    return (
      <SettingsScreen title={draft.label.trim()}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <Text className="px-2 text-sm text-foreground-muted">
            {signIn.view.pendingFlowId !== null
              ? "Finish signing in in the browser. This screen closes once the account is connected."
              : "Sign in to finish adding this connection."}
          </Text>
          <SettingsSection title="Account">
            <McpConnectionSignInRows signIn={signIn} label={draft.label.trim()} />
          </SettingsSection>
          <Button label="Done" tone="secondary" onPress={() => navigation.goBack()} />
        </ScrollView>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title={editing ? target.saved.label : "New MCP connection"}>
      {/* The edge-to-edge Android window does not resize for the keyboard; iOS insets the scroll view instead. */}
      <KeyboardAvoidingView
        automaticOffset
        behavior="padding"
        enabled={Platform.OS === "android"}
        className="flex-1"
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "android" ? "none" : "on-drag"}
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <Text className="px-2 text-sm text-foreground-muted">
            {grantBot === undefined
              ? MCP_CONNECTIONS_NOTICE
              : `${grantBot.name} can use it as soon as you add it.`}
          </Text>
          {editing && !showAccount ? (
            <Text className="px-2 text-sm text-foreground-muted">
              {mcpConnectionStatusText(status).text}
            </Text>
          ) : null}
          {showAccount && current !== undefined ? (
            <SettingsSection title="Account">
              <McpConnectionSignInRows
                signIn={signIn}
                label={current.label}
                disconnectMessage={mcpConnectionDisconnectMessage(usage, target.connectionId)}
              />
            </SettingsSection>
          ) : null}
          <SettingsSection title="Connection">
            <FormField
              label="Name"
              value={draft.label}
              maxLength={MCP_CONNECTION_LABEL_MAX_LENGTH}
              placeholder="Docs (work account)"
              onChange={(label) => setDraft({ ...draft, label })}
            />
            {editing ? (
              <FormField
                label="Transport"
                value={isHttp ? "HTTP" : "Local command (stdio)"}
                disabled
                borderTop
                onChange={() => undefined}
              />
            ) : (
              <SelectRow
                label="Transport"
                value={isHttp ? "HTTP" : "Local command (stdio)"}
                borderTop
                actions={[
                  { id: "http", title: "HTTP" },
                  { id: "stdio", title: "Local command (stdio)" },
                ]}
                onSelect={(next) => {
                  if (next !== "http" && next !== "stdio") return;
                  setDraft({ ...draft, transport: next });
                  setBindings([]);
                }}
              />
            )}
            {isHttp ? (
              <FormField
                label="URL"
                value={draft.url}
                disabled={editing}
                borderTop
                placeholder="https://mcp.example.com/mcp"
                onChange={(url) => setDraft({ ...draft, url })}
              />
            ) : null}
            {isHttp && (oauthSupported || isOAuth) ? (
              editing ? (
                <FormField
                  label="Sign-in"
                  value={isOAuth ? "OAuth" : "Headers"}
                  disabled
                  borderTop
                  onChange={() => undefined}
                />
              ) : (
                <SelectRow
                  label="Sign-in"
                  value={isOAuth ? "Sign in with OAuth" : "Headers or none"}
                  borderTop
                  actions={[
                    { id: "oauth", title: "Sign in with OAuth" },
                    { id: "headers", title: "Headers, such as an API key, or none" },
                  ]}
                  onSelect={(next) => {
                    if (next !== "oauth" && next !== "headers") return;
                    setDraft({ ...draft, auth: next });
                    setBindings([]);
                  }}
                />
              )
            ) : null}
            {isHttp ? null : (
              <>
                <FormField
                  label="Command"
                  value={draft.command}
                  disabled={editing}
                  borderTop
                  placeholder="npx"
                  onChange={(command) => setDraft({ ...draft, command })}
                />
                <FormField
                  label="Arguments, one per line"
                  value={draft.args}
                  disabled={editing}
                  borderTop
                  multiline
                  onChange={(args) => setDraft({ ...draft, args })}
                />
              </>
            )}
          </SettingsSection>
          {editing ? (
            <Text className="px-2 text-sm text-foreground-muted">
              The endpoint is part of the connection's identity. To change it, add a new connection.
            </Text>
          ) : null}
          {isOAuth && !editing ? (
            <SettingsSection title="OAuth app">
              <ListActionRow
                label="Use your own OAuth app"
                description="Only for services that do not let T3 Code register itself."
                onPress={() => setOwnAppOpen((open) => !open)}
              />
              {ownAppOpen ? (
                <>
                  <Text
                    textRole="footnote"
                    className="border-t border-border-subtle px-4 py-3 text-foreground-muted"
                  >
                    Add {redirectUri} as a redirect URI in your app.
                  </Text>
                  <FormField
                    label="Client ID"
                    value={draft.oauthClientId}
                    borderTop
                    onChange={(oauthClientId) => setDraft({ ...draft, oauthClientId })}
                  />
                  <View className="gap-2 border-t border-border-subtle px-4 py-3">
                    <SecretTextInput
                      accessibilityLabel="Client secret"
                      placeholder="Client secret, if the app has one"
                      value={
                        typeof draft.oauthClientSecret === "string" ? draft.oauthClientSecret : ""
                      }
                      editable
                      onChangeText={(oauthClientSecret) =>
                        setDraft({ ...draft, oauthClientSecret })
                      }
                      onSubmitEditing={() => undefined}
                    />
                  </View>
                </>
              ) : null}
            </SettingsSection>
          ) : null}
          {isOAuth && editing && draft.oauthClientId !== "" ? (
            <Text className="px-2 text-sm text-foreground-muted">
              Signs in with your OAuth app {draft.oauthClientId}. To use another app, add a new
              connection.
            </Text>
          ) : null}
          {isOAuth && bindings.length === 0 ? null : (
            <SettingsSection
              title={isOAuth ? "Other headers" : isHttp ? "Headers" : "Environment variables"}
            >
              {bindings.map((row, index) => (
                <View key={row.key} className={index > 0 ? "border-t border-border-subtle" : ""}>
                  <FormField
                    label="Name"
                    value={row.name}
                    placeholder={isHttp ? "Authorization" : "API_TOKEN"}
                    onChange={(name) =>
                      // A saved value belongs to its name; a renamed binding needs a new one.
                      setBinding(
                        row.key,
                        row.saved !== undefined && row.value === row.saved
                          ? { name, value: "", saved: undefined }
                          : { name },
                      )
                    }
                  />
                  {sources.length > 0 || row.source !== null ? (
                    <SelectRow
                      label="Source"
                      value={
                        row.source === null
                          ? "Value"
                          : (sources.find((source) => source.id === row.source)?.label ??
                            row.source)
                      }
                      borderTop
                      actions={[
                        { id: "", title: "Value" },
                        ...sources.map((source) => ({ id: source.id, title: source.label })),
                      ]}
                      onSelect={(id) => {
                        const source = id === "" ? null : (id as SecretProviderId);
                        setBinding(row.key, {
                          source,
                          referenceText: "",
                          value: source === null ? (row.saved ?? "") : "",
                        });
                      }}
                    />
                  ) : null}
                  {row.source === null ? (
                    <View className="gap-2 border-t border-border-subtle px-4 py-3">
                      <SecretTextInput
                        accessibilityLabel={row.name === "" ? `${bindingNoun} value` : row.name}
                        placeholder={
                          row.saved !== undefined && row.value === row.saved
                            ? "Stored secret, enter a new value to replace"
                            : "Value"
                        }
                        value={
                          typeof row.value === "string" && row.value !== row.saved ? row.value : ""
                        }
                        editable
                        onChangeText={(text) =>
                          setBinding(row.key, {
                            value: text === "" && row.saved !== undefined ? row.saved : text,
                          })
                        }
                        onSubmitEditing={() => undefined}
                      />
                    </View>
                  ) : (
                    <FormField
                      label="Reference"
                      value={row.referenceText}
                      borderTop
                      onChange={(referenceText) => {
                        const source = sources.find((candidate) => candidate.id === row.source);
                        setBinding(row.key, {
                          referenceText,
                          value:
                            (source && secretRequestReference(source, referenceText)) ??
                            referenceText,
                        });
                      }}
                    />
                  )}
                  <ListActionRow
                    label={`Remove ${row.name === "" ? bindingNoun.toLowerCase() : row.name}`}
                    tone="danger"
                    onPress={() =>
                      setBindings((rows) => rows.filter((other) => other.key !== row.key))
                    }
                  />
                </View>
              ))}
              <ListActionRow
                label={`Add ${bindingNoun.toLowerCase()}`}
                onPress={() =>
                  setBindings((rows) => [
                    ...rows,
                    {
                      key: uuidv4(),
                      name: "",
                      value: "",
                      saved: undefined,
                      referenceText: "",
                      source: null,
                    },
                  ])
                }
              />
            </SettingsSection>
          )}
          {error !== null ? (
            <Text className="px-2 text-sm text-danger-foreground">{error}</Text>
          ) : null}
          <Button
            label={editing ? "Save changes" : isOAuth ? "Connect" : "Add connection"}
            // A connection added for a Bot waits for that Bot's grants, so it can be granted.
            disabled={!canEdit || (grantToBotId !== undefined && grantBot?.mcpGrants === undefined)}
            loading={busy}
            onPress={() => void save()}
          />
          {editing && current !== undefined ? (
            <SettingsSection title="Actions">
              <ListActionRow
                label="Refresh credentials"
                disabled={!canRefresh || busy}
                onPress={async () => {
                  setBusy(true);
                  const result = await refresh({
                    environmentId,
                    input: { connectionIds: [target.connectionId] },
                  });
                  setBusy(false);
                  reportFailure("Could not refresh connection", result);
                }}
              />
              <ListActionRow
                label={current.enabled ? "Disable" : "Enable"}
                disabled={!canEdit || busy}
                onPress={async () => {
                  setBusy(true);
                  const result = await update({
                    environmentId,
                    input: {
                      connectionId: target.connectionId,
                      expectedRevision: current.revision,
                      enabled: !current.enabled,
                    },
                  });
                  setBusy(false);
                  reportFailure(
                    current.enabled
                      ? "Could not disable connection"
                      : "Could not enable connection",
                    result,
                  );
                  if (result._tag !== "Failure") navigation.goBack();
                }}
              />
              {usage.state === "failed" ? (
                <ListActionRow
                  label="Retry loading Bots"
                  description={`Removal names the Bots that lose this connection. ${usage.error}`}
                  onPress={retryUsage}
                />
              ) : null}
              <ListActionRow
                label="Remove connection"
                tone="danger"
                loading={usage.state === "loading"}
                disabled={!canEdit || busy || removalMessage === null}
                onPress={() => {
                  if (removalMessage === null) return;
                  Dialog.confirm({
                    title: `Remove ${current.label}?`,
                    message: removalMessage,
                    confirmText: "Remove",
                    destructive: true,
                    onConfirm: () =>
                      void remove({
                        environmentId,
                        input: {
                          connectionId: target.connectionId,
                          expectedRevision: current.revision,
                        },
                      }).then((result) => {
                        reportFailure("Could not remove connection", result);
                        if (result._tag !== "Failure") navigation.goBack();
                      }),
                  });
                }}
              />
            </SettingsSection>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SettingsScreen>
  );
}
