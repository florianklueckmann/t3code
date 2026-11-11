import * as Schema from "effect/Schema";
import { codexAuthorizationRequest, codexCallbackUrl } from "@t3tools/shared/codexAuthHandoff";
import {
  cancelLoopbackAuthCallback,
  receiveLoopbackAuthCallback,
} from "@t3tools/shared/loopbackAuthCallback";

export class CodexAuthCallbackError extends Schema.TaggedError<CodexAuthCallbackError>()(
  "CodexAuthCallbackError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

export function cancelCodexAuthCallback(authorizationUrl: string) {
  cancelLoopbackAuthCallback(codexAuthorizationRequest(authorizationUrl).state);
}

/** Receive an authorization code locally. Credentials and PKCE stay on the target environment. */
export async function receiveCodexAuthCallback(
  authorizationUrl: string,
  openBrowser: (url: string) => Promise<boolean>,
  destination?: (callbackUrl: string) => string,
  signal?: AbortSignal,
) {
  const request = codexAuthorizationRequest(authorizationUrl);
  return receiveLoopbackAuthCallback(
    {
      ...request,
      accept: (url) => codexCallbackUrl(url, request.redirectUri, request.state).toString(),
      portInUseMessage:
        "The ChatGPT callback port is in use on this computer. Close the other sign-in and try again, or paste the redirect URL in T3 Code.",
      expiresInMs: 300_000,
    },
    openBrowser,
    destination,
    signal,
  );
}
