import { useAtomValue } from "@effect/atom-react";
import {
  MCP_CONNECTION_OAUTH_LOOPBACK_ORIGIN,
  mcpConnectionDisconnectMessage,
  mcpConnectionOAuthCallback,
  mcpConnectionOAuthView,
  mcpConnectionUsagePendingText,
  type McpConnectionOAuthCallback,
  type McpConnectionUsage,
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
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { useNowAfter } from "../../hooks/useDeadline";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readPreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const NEW_CONNECTION: McpConnectionOAuthState = {
  credential: { state: "signed-out", reason: "never" },
};

/** A sign-in this client started: the page to reopen and how its response comes back. */
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

const openSignInPage = (url: string) => ensureLocalApi().shell.openExternal(url);

export type McpConnectionSignIn = ReturnType<typeof useMcpConnectionSignIn>;

/** Live sign-in state of one OAuth connection, and the actions on it. */
export function useMcpConnectionSignIn(input: {
  readonly environmentId: EnvironmentId;
  readonly connectionId: McpConnectionId;
  /** The catalog's last state, shown until the live one arrives. */
  readonly fallback: McpConnectionOAuthState | undefined;
  readonly audience: "catalog" | "bot";
  /** False until the connection exists, so nothing subscribes to an id the server lacks. */
  readonly active?: boolean;
}) {
  const { environmentId, connectionId } = input;
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

  const run = async <A, E>(request: () => Promise<AtomCommandResult<A, E>>) => {
    setBusy(true);
    setError(null);
    const result = await request();
    setBusy(false);
    setError(failureMessage(result));
    return result;
  };

  const finish = (flowId: string, callbackUrl: string) =>
    run(() => complete({ environmentId, input: { connectionId, flowId, callbackUrl } }));

  const connect = async () => {
    const bridge = window.desktopBridge;
    const callback = mcpConnectionOAuthCallback({
      httpBaseUrl: readPreparedConnection(environmentId)?.httpBaseUrl ?? null,
      canListenOnLoopback: bridge?.receiveMcpConnectionOAuthCallback !== undefined,
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
    if (callback.mode !== "listener" || bridge === undefined) {
      // A blocked pop-up leaves the "Open sign-in page" button, which is a fresh click.
      void openSignInPage(started.authorizationUrl).catch(() => undefined);
      return;
    }
    try {
      const callbackUrl = await bridge.receiveMcpConnectionOAuthCallback(started.authorizationUrl);
      await finish(started.flowId, callbackUrl);
    } catch {
      // The loopback port was busy or the listener ended; the same address can still be pasted.
      setOwn((current) =>
        current?.flowId === started.flowId ? { ...current, mode: "paste" } : current,
      );
    }
  };

  const cancel = async () => {
    const flowId = view.pendingFlowId;
    if (flowId === null) return;
    if (own?.mode === "listener") {
      void window.desktopBridge
        ?.cancelMcpConnectionOAuthCallback(own.authorizationUrl)
        .catch(() => undefined);
    }
    await run(() => cancelFlow({ environmentId, input: { connectionId, flowId } }));
    setOwn(null);
  };

  const disconnect = () => run(() => disconnectAccount({ environmentId, input: { connectionId } }));

  return {
    connectionId,
    view,
    /** Set while this client's own sign-in waits for the browser. */
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

/** The buttons that move a connection between signed out, signing in and connected. */
export function McpConnectionSignInButtons({
  signIn,
  label,
  disabled = false,
  disconnect,
}: {
  readonly signIn: McpConnectionSignIn;
  readonly label: string;
  readonly disabled?: boolean;
  /** Offers Disconnect, confirmed once `usage` names the Bots that lose the account. */
  readonly disconnect?: { readonly usage: McpConnectionUsage; readonly onRetryUsage: () => void };
}) {
  const [reconnecting, setReconnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const { view } = signIn;
  const off = disabled || signIn.busy || !signIn.canSignIn;
  const disconnectMessage =
    disconnect === undefined
      ? null
      : mcpConnectionDisconnectMessage(disconnect.usage, signIn.connectionId);
  return (
    <>
      {view.pendingFlowId !== null ? (
        <Button size="xs" variant="ghost" disabled={off} onClick={() => void signIn.cancel()}>
          Cancel sign-in
        </Button>
      ) : view.signIn !== null ? (
        <Button
          size="xs"
          variant="outline"
          disabled={off}
          onClick={() =>
            view.reconnectWarning === null ? void signIn.connect() : setReconnecting(true)
          }
        >
          {view.signIn}
        </Button>
      ) : null}
      <AlertDialog open={reconnecting} onOpenChange={setReconnecting}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign in to {label} again?</AlertDialogTitle>
            <AlertDialogDescription>{view.reconnectWarning}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                setReconnecting(false);
                void signIn.connect();
              }}
            >
              Sign in
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {disconnect !== undefined && view.connected ? (
        <>
          <Button size="xs" variant="ghost" disabled={off} onClick={() => setDisconnecting(true)}>
            Disconnect
          </Button>
          <AlertDialog open={disconnecting} onOpenChange={setDisconnecting}>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect {label}?</AlertDialogTitle>
                <AlertDialogDescription>
                  {disconnectMessage ?? mcpConnectionUsagePendingText(disconnect.usage)}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                {disconnect.usage.state === "failed" ? (
                  <Button variant="outline" onClick={disconnect.onRetryUsage}>
                    Retry
                  </Button>
                ) : null}
                <Button
                  variant="destructive"
                  disabled={disconnectMessage === null}
                  onClick={() => {
                    setDisconnecting(false);
                    void signIn.disconnect();
                  }}
                >
                  Disconnect
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </>
      ) : null}
    </>
  );
}

/** What a sign-in needs from the user beyond the buttons: the page to open, a pasted address, errors. */
export function McpConnectionSignInDetails({ signIn }: { readonly signIn: McpConnectionSignIn }) {
  const [pasted, setPasted] = useState("");
  const { own, view } = signIn;
  const failure = signIn.error ?? view.failure;
  if (own === null && failure === null) return null;
  return (
    <div className="grid gap-1.5 text-xs">
      {own !== null ? (
        <>
          <div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void openSignInPage(own.authorizationUrl).catch(() => undefined)}
            >
              <ExternalLinkIcon className="size-3" aria-hidden />
              Open sign-in page
            </Button>
          </div>
          {own.mode === "paste" ? (
            <form
              className="grid gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (pasted.trim() === "") return;
                void signIn.finish(own.flowId, pasted.trim()).then((result) => {
                  if (result._tag === "Success") setPasted("");
                });
              }}
            >
              <p className="text-muted-foreground">
                After you sign in, your browser shows a page that can't load. Copy that page's full
                address and paste it here.
              </p>
              <div className="flex items-center gap-1.5">
                <Input
                  size="sm"
                  aria-label="Address after sign-in"
                  placeholder={`${MCP_CONNECTION_OAUTH_LOOPBACK_ORIGIN}${MCP_CONNECTION_OAUTH_CALLBACK_PATH}?code=…`}
                  value={pasted}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setPasted(event.target.value)}
                />
                <Button size="xs" type="submit" disabled={signIn.busy || pasted.trim() === ""}>
                  Finish sign-in
                </Button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
      {failure === null ? null : (
        <p role="alert" className="text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}
