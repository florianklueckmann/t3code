import { useAtomValue } from "@effect/atom-react";
import {
  MCP_CONNECTION_OAUTH_LOOPBACK_ORIGIN,
  mcpConnectionOAuthCallback,
  mcpConnectionOAuthView,
  type McpConnectionOAuthCallback,
} from "@t3tools/client-runtime/mcp-connections";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  MCP_CONNECTION_OAUTH_CALLBACK_PATH,
  type EnvironmentId,
  type McpConnectionId,
  type McpConnectionOAuthState,
} from "@t3tools/contracts";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { Linking, Platform, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useNowAfter } from "../../lib/clock";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { FormField } from "./components/SettingsFormRows";

const NEW_CONNECTION: McpConnectionOAuthState = {
  credential: { state: "signed-out", reason: "never" },
};

const TONE_CLASS = {
  ok: "text-foreground-muted",
  muted: "text-foreground-muted",
  warning: "text-warning-foreground",
  error: "text-danger-foreground",
} as const;

interface OwnSignIn {
  readonly flowId: string;
  readonly authorizationUrl: string;
  readonly mode: McpConnectionOAuthCallback["mode"];
}

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
}

/**
 * The in-app sheet closes itself once the account connects. A pasted sign-in opens in the system
 * browser instead, where the address of the page that cannot load is easy to copy.
 */
const openSignInPage = (own: OwnSignIn) =>
  own.mode === "paste"
    ? Linking.openURL(own.authorizationUrl)
    : WebBrowser.openBrowserAsync(own.authorizationUrl).then(() => undefined);

type McpConnectionSignIn = ReturnType<typeof useMcpConnectionSignIn>;

/** Live sign-in state of one OAuth connection, and the actions on it. */
export function useMcpConnectionSignIn(input: {
  readonly environmentId: EnvironmentId;
  readonly connectionId: McpConnectionId;
  readonly fallback: McpConnectionOAuthState | undefined;
  readonly audience: "catalog" | "bot";
  /** False until the connection exists, so nothing subscribes to an id the server lacks. */
  readonly active?: boolean;
}) {
  const { environmentId, connectionId } = input;
  const prepared = usePreparedConnection(environmentId);
  const live = useEnvironmentQuery(
    input.active === false
      ? null
      : serverEnvironment.mcpConnectionOAuthState({ environmentId, input: { connectionId } }),
  );
  const options = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startMcpConnectionOAuth, options);
  const complete = useAtomCommand(serverEnvironment.completeMcpConnectionOAuth, options);
  const cancelFlow = useAtomCommand(serverEnvironment.cancelMcpConnectionOAuth, options);
  const disconnectAccount = useAtomCommand(serverEnvironment.disconnectMcpConnectionOAuth, options);
  const canSignIn = useAtomValue(
    serverEnvironment.startMcpConnectionOAuth.permissionAtom(environmentId),
  );
  const [own, setOwn] = useState<OwnSignIn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = live.data ?? input.fallback ?? NEW_CONNECTION;
  // The server sends nothing when a sign-in expires, so the view re-reads the clock then.
  const now = useNowAfter(
    state.signIn?.state === "pending" ? Date.parse(state.signIn.expiresAt) : null,
  );
  const view = mcpConnectionOAuthView(state, now, input.audience);
  const signedInFromSheet = view.connected && own?.mode === "environment";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the in-app browser sheet is native UI that closes once the server reports the account connected
  useEffect(() => {
    if (signedInFromSheet && Platform.OS === "ios") {
      void WebBrowser.dismissBrowser().catch(() => undefined);
    }
  }, [signedInFromSheet]);

  const run = async <A, E>(request: () => Promise<AtomCommandResult<A, E>>) => {
    setBusy(true);
    setError(null);
    const result = await request();
    setBusy(false);
    setError(failureMessage(result));
    return result;
  };

  const connect = async () => {
    const callback = mcpConnectionOAuthCallback({
      httpBaseUrl: prepared._tag === "Some" ? prepared.value.httpBaseUrl : null,
      canListenOnLoopback: false,
    });
    const result = await run(() =>
      start({ environmentId, input: { connectionId, redirectOrigin: callback.redirectOrigin } }),
    );
    if (result._tag === "Failure") return;
    const started: OwnSignIn = {
      flowId: result.value.flowId,
      authorizationUrl: result.value.authorizationUrl,
      mode: callback.mode,
    };
    setOwn(started);
    await openSignInPage(started).catch(() => setError("Could not open the sign-in page."));
  };

  const cancel = async () => {
    if (view.pendingFlowId === null) return;
    const flowId = view.pendingFlowId;
    await run(() => cancelFlow({ environmentId, input: { connectionId, flowId } }));
    setOwn(null);
  };

  const finish = (flowId: string, callbackUrl: string) =>
    run(() => complete({ environmentId, input: { connectionId, flowId, callbackUrl } }));

  const disconnect = () => run(() => disconnectAccount({ environmentId, input: { connectionId } }));

  return {
    view,
    own: own !== null && own.flowId === view.pendingFlowId ? own : null,
    busy,
    error: error ?? live.error,
    canSignIn,
    connect,
    cancel,
    finish,
    disconnect,
  };
}

/** Status, actions and the paste field of one OAuth connection, as settings list rows. */
export function McpConnectionSignInRows({
  signIn,
  label,
  disabled = false,
  disconnectMessage,
}: {
  readonly signIn: McpConnectionSignIn;
  readonly label: string;
  readonly disabled?: boolean;
  /** Offers Disconnect, confirmed with this message. */
  readonly disconnectMessage?: string;
}) {
  const [pasted, setPasted] = useState("");
  const { view, own } = signIn;
  const failure = signIn.error ?? view.failure;
  const off = disabled || signIn.busy || !signIn.canSignIn;
  return (
    <>
      <View className="gap-1 px-4 py-3">
        <Text
          accessibilityLiveRegion="polite"
          textRole="footnote"
          className={TONE_CLASS[view.tone]}
        >
          {view.text}
        </Text>
        {failure === null ? null : (
          <Text accessibilityRole="alert" textRole="footnote" className="text-danger-foreground">
            {failure}
          </Text>
        )}
      </View>
      {view.pendingFlowId !== null ? (
        <>
          {own === null ? null : (
            <ListActionRow
              label="Open sign-in page"
              disabled={disabled}
              onPress={() => void openSignInPage(own).catch(() => undefined)}
            />
          )}
          {own?.mode === "paste" ? (
            <>
              <Text
                textRole="footnote"
                className="border-t border-border-subtle px-4 py-3 text-foreground-muted"
              >
                After you sign in, the browser shows a page that can't load. Copy that page's full
                address and paste it here.
              </Text>
              <FormField
                label="Address"
                value={pasted}
                placeholder={`${MCP_CONNECTION_OAUTH_LOOPBACK_ORIGIN}${MCP_CONNECTION_OAUTH_CALLBACK_PATH}?code=…`}
                borderTop
                onChange={setPasted}
              />
              <ListActionRow
                label="Finish sign-in"
                loading={signIn.busy}
                disabled={disabled || pasted.trim() === ""}
                onPress={() =>
                  void signIn.finish(own.flowId, pasted.trim()).then((result) => {
                    if (result._tag === "Success") setPasted("");
                  })
                }
              />
            </>
          ) : null}
          <ListActionRow
            label="Cancel sign-in"
            disabled={off}
            onPress={() => void signIn.cancel()}
          />
        </>
      ) : view.signIn !== null ? (
        <ListActionRow
          label={view.signIn}
          loading={signIn.busy}
          disabled={off}
          onPress={() => void signIn.connect()}
        />
      ) : null}
      {disconnectMessage !== undefined && view.connected ? (
        <ListActionRow
          label="Disconnect"
          tone="danger"
          disabled={off}
          onPress={() =>
            Dialog.confirm({
              title: `Disconnect ${label}?`,
              message: disconnectMessage,
              confirmText: "Disconnect",
              destructive: true,
              onConfirm: () => void signIn.disconnect(),
            })
          }
        />
      ) : null}
    </>
  );
}
