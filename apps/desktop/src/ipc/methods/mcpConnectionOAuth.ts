import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CodexAuthCallbackError } from "../../app/CodexAuthCallback.ts";
import {
  cancelMcpConnectionOAuthCallback,
  receiveMcpConnectionOAuthCallback,
} from "../../app/McpConnectionOAuthCallback.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const Request = Schema.String.check(Schema.isMaxLength(16_384));

export const receiveMcpConnectionOAuthCallbackMethod = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECEIVE_MCP_CONNECTION_OAUTH_CALLBACK_CHANNEL,
  payload: Request,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.mcpConnectionOAuth.receive")(function* (authorizationUrl) {
    const shell = yield* ElectronShell.ElectronShell;
    const windows = yield* ElectronWindow.ElectronWindow;
    const context = yield* Effect.context<ElectronShell.ElectronShell>();
    const runPromise = Effect.runPromiseWith(context);
    const callbackUrl = yield* Effect.tryPromise({
      try: () =>
        receiveMcpConnectionOAuthCallback(authorizationUrl, (url) =>
          runPromise(shell.openExternal(url)),
        ),
      catch: () =>
        new CodexAuthCallbackError({
          detail: "Could not receive the sign-in on this computer. Paste the address instead.",
        }),
    });
    const window = yield* windows.currentMainOrFirst;
    if (Option.isSome(window)) yield* windows.reveal(window.value);
    return callbackUrl;
  }),
});

export const cancelMcpConnectionOAuthCallbackMethod = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CANCEL_MCP_CONNECTION_OAUTH_CALLBACK_CHANNEL,
  payload: Request,
  result: Schema.Void,
  handler: (authorizationUrl) =>
    Effect.try({
      try: () => cancelMcpConnectionOAuthCallback(authorizationUrl),
      catch: () => new CodexAuthCallbackError({ detail: "Invalid sign-in request." }),
    }),
});
