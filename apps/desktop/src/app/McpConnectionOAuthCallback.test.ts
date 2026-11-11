// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Tests exercise the real native loopback listener without a real service.
import * as NodeHttp from "node:http";
import { describe, expect, it } from "vite-plus/test";
import {
  cancelMcpConnectionOAuthCallback,
  mcpConnectionOAuthRequest,
  receiveMcpConnectionOAuthCallback,
} from "./McpConnectionOAuthCallback.ts";

async function freePort() {
  const server = NodeHttp.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function request(redirectUri: string, origin = "https://auth.mail.test") {
  const url = new URL(`${origin}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: "t3-mail",
    redirect_uri: redirectUri,
    state: "state-1",
    code_challenge_method: "S256",
    code_challenge: "b".repeat(43),
  }).toString();
  return url.toString();
}

const loopback = (port: number) => `http://127.0.0.1:${port}/oauth/mcp-connections/callback`;

describe("desktop MCP connection sign-in listener", () => {
  it("returns the response for its own sign-in and refuses another one", async () => {
    const redirectUri = loopback(await freePort());
    const expected = `${redirectUri}?code=code-1&state=state-1&iss=https%3A%2F%2Fauth.mail.test`;
    const received = await receiveMcpConnectionOAuthCallback(request(redirectUri), async () => {
      expect((await fetch(`${redirectUri}?code=code-2&state=other`)).status).toBe(400);
      const response = await fetch(expected);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("code-1");
      return true;
    });
    expect(received).toBe(expected);
  });

  it("cancels and releases the port", async () => {
    const redirectUri = loopback(await freePort());
    await expect(
      receiveMcpConnectionOAuthCallback(request(redirectUri), async () => {
        cancelMcpConnectionOAuthCallback(request(redirectUri));
        return true;
      }),
    ).rejects.toThrow("cancelled");
    const again = `${redirectUri}?error=access_denied&state=state-1`;
    expect(
      await receiveMcpConnectionOAuthCallback(request(redirectUri), async () => {
        await fetch(again);
        return true;
      }),
    ).toBe(again);
  });

  it.each([
    ["a non-loopback redirect", request("http://studio.lan:1457/oauth/mcp-connections/callback")],
    ["another callback path", request("http://127.0.0.1:1457/auth/callback")],
    ["a non-web sign-in page", request(loopback(1457), "file://")],
  ])("refuses %s", (_, authorizationUrl) => {
    expect(() => mcpConnectionOAuthRequest(authorizationUrl)).toThrow(
      "Invalid MCP connection sign-in request.",
    );
  });
});
