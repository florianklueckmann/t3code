import {
  MCP_CONNECTION_OAUTH_CALLBACK_PATH,
  mcpConnectionOAuthFailureMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { renderConnectionSignInPage } from "../auth/mcpOAuthHtml.ts";
import * as McpConnectionOAuth from "./McpConnectionOAuth.ts";

const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/**
 * Unauthenticated, like any OAuth client's redirect URI: the flow's single-use `state` and its
 * server-held PKCE verifier protect it. The page never echoes the code or the service's text.
 */
export const layerOAuthCallbackRoute = HttpRouter.add(
  "GET",
  MCP_CONNECTION_OAUTH_CALLBACK_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const oauth = yield* McpConnectionOAuth.McpConnectionOAuth;
    const queryStart = request.url.indexOf("?");
    const failure = yield* oauth
      .completeCallback(queryStart === -1 ? "" : request.url.slice(queryStart + 1))
      .pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(mcpConnectionOAuthFailureMessage(error.reason))),
      );
    return HttpServerResponse.text(renderConnectionSignInPage(failure), {
      status: failure === undefined ? 200 : 400,
      contentType: "text/html; charset=utf-8",
      headers: PAGE_HEADERS,
    });
  }),
);
