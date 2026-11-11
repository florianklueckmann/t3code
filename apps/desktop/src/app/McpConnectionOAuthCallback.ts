import { MCP_CONNECTION_OAUTH_CALLBACK_PATH } from "@t3tools/contracts";
import {
  cancelLoopbackAuthCallback,
  receiveLoopbackAuthCallback,
} from "@t3tools/shared/loopbackAuthCallback";

const INVALID = "Invalid MCP connection sign-in request.";

function single(url: URL, key: string) {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1 || !values[0]) throw new Error(INVALID);
  return values[0];
}

/**
 * A sign-in an environment started for this computer's loopback origin. The environment may be
 * remote, so only an http(s) page opens, and only a loopback callback port is bound.
 */
export function mcpConnectionOAuthRequest(authorizationUrl: string) {
  const url = new URL(authorizationUrl);
  if (
    authorizationUrl.length > 16_384 ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error(INVALID);
  const redirectUri = single(url, "redirect_uri");
  const redirect = new URL(redirectUri);
  const state = single(url, "state");
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    redirect.port === "" ||
    redirect.pathname !== MCP_CONNECTION_OAUTH_CALLBACK_PATH ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    state.length > 512
  )
    throw new Error(INVALID);
  return { authorizationUrl: url.toString(), redirectUri, state };
}

function acceptCallback(value: string, redirectUri: string, state: string) {
  const callback = new URL(value);
  const expected = new URL(redirectUri);
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  if (
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.hash ||
    callback.searchParams.getAll("state").join() !== state ||
    codes.length + errors.length !== 1
  )
    throw new Error("This response does not belong to the active sign-in.");
  return callback.toString();
}

export function cancelMcpConnectionOAuthCallback(authorizationUrl: string) {
  cancelLoopbackAuthCallback(mcpConnectionOAuthRequest(authorizationUrl).state);
}

/** Opens the sign-in and returns the browser's response for the environment to finish. */
export function receiveMcpConnectionOAuthCallback(
  authorizationUrl: string,
  openBrowser: (url: string) => Promise<boolean>,
) {
  const request = mcpConnectionOAuthRequest(authorizationUrl);
  return receiveLoopbackAuthCallback(
    {
      ...request,
      accept: (url) => acceptCallback(url, request.redirectUri, request.state),
      portInUseMessage: "The sign-in port is in use on this computer.",
      // The environment keeps a sign-in for ten minutes.
      expiresInMs: 600_000,
    },
    openBrowser,
  );
}
