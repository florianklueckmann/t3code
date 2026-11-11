// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- The fixture checks PKCE synchronously; Node's fetch decides redirects.
import * as NodeCrypto from "node:crypto";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  McpConnectionId,
  type McpConnectionOAuth as McpConnectionOAuthSetup,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { MockAgent } from "undici";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpConnectionOAuth from "./McpConnectionOAuth.ts";

const BASE = "https://mail.example.test";
const MCP_URL = `${BASE}/mcp`;
const ORIGIN = "https://t3.example.test";
const REDIRECT = `${ORIGIN}/oauth/mcp-connections/callback`;

const layerStores = ServerSettings.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provide(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-mcp-oauth-test-" })),
  ),
);

interface FixtureOptions {
  /** Advertises RFC 9207 `iss` in its metadata. */
  readonly issAdvertised?: boolean;
  /** The resource its metadata names. */
  readonly resource?: string;
  /** A challenge without `resource_metadata`, metadata only at the root well-known URI. */
  readonly bareChallenge?: boolean;
  /** The issuer's path; metadata is then only at the path-appended OpenID URI. */
  readonly tenant?: string;
  readonly registration?: boolean;
  /** Issues access tokens only, as a service without offline access does. */
  readonly refreshTokens?: false;
  readonly authMethods?: ReadonlyArray<string>;
  readonly preregistered?: {
    readonly id: string;
    readonly secret: string;
    readonly method: "client_secret_basic" | "client_secret_post";
  };
}

const s256 = (verifier: string) =>
  NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
const randomId = (prefix: string) =>
  `${prefix}-${NodeCrypto.randomBytes(12).toString("base64url")}`;

/** The design's synthetic authorization server and MCP resource, as an in-process HttpClient. */
const makeFixture = (options: FixtureOptions = {}) =>
  Effect.gen(function* () {
    const issuer = `${BASE}${options.tenant ?? ""}`;
    const requests: Array<{
      readonly method: string;
      readonly path: string;
      readonly form: URLSearchParams;
      readonly authorization: string | undefined;
    }> = [];
    const clients = new Map<
      string,
      {
        readonly redirectUris: ReadonlyArray<string>;
        readonly secret?: string;
        readonly method?: string;
      }
    >();
    if (options.preregistered !== undefined) {
      clients.set(options.preregistered.id, {
        redirectUris: [REDIRECT],
        secret: options.preregistered.secret,
        method: options.preregistered.method,
      });
    }
    const codes = new Map<
      string,
      {
        clientId: string;
        redirectUri: string;
        challenge: string;
        resource: string;
        subject: string;
        used: boolean;
      }
    >();
    const grants = new Map<string, { subject: string; clientId: string; revoked: boolean }>();
    const refreshTokens = new Map<string, { grantId: string; rotated: boolean }>();
    const accessTokens = new Map<string, string>();
    const issued: Array<string> = [];
    // Holds the next request to a path until released, to order it against other operations.
    let gate:
      | {
          readonly path: string;
          readonly reached: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        }
      | undefined;

    const issue = (grantId: string) => {
      const access = randomId("at");
      accessTokens.set(access, grantId);
      issued.push(access);
      const tokens = { access_token: access, token_type: "Bearer", expires_in: 3600 };
      if (options.refreshTokens === false) return tokens;
      const refresh = randomId("rt");
      refreshTokens.set(refresh, { grantId, rotated: false });
      issued.push(refresh);
      return { ...tokens, refresh_token: refresh };
    };
    const clientOf = (request: HttpClientRequest.HttpClientRequest, form: URLSearchParams) => {
      const basic = request.headers.authorization;
      if (basic?.startsWith("Basic ")) {
        const [id, secret] = Buffer.from(basic.slice(6), "base64").toString().split(":");
        const client = clients.get(decodeURIComponent(id ?? ""));
        return client?.method === "client_secret_basic" &&
          client.secret === decodeURIComponent(secret ?? "")
          ? decodeURIComponent(id ?? "")
          : undefined;
      }
      const id = form.get("client_id") ?? "";
      const client = clients.get(id);
      if (client === undefined) return undefined;
      if (client.secret === undefined) return id;
      return client.method === "client_secret_post" && form.get("client_secret") === client.secret
        ? id
        : undefined;
    };
    const token = (
      request: HttpClientRequest.HttpClientRequest,
      form: URLSearchParams,
    ): readonly [number, unknown] => {
      const clientId = clientOf(request, form);
      if (clientId === undefined) return [401, { error: "invalid_client" }];
      if (form.get("grant_type") === "authorization_code") {
        const entry = codes.get(form.get("code") ?? "");
        if (
          entry === undefined ||
          entry.used ||
          entry.clientId !== clientId ||
          entry.redirectUri !== form.get("redirect_uri") ||
          entry.challenge !== s256(form.get("code_verifier") ?? "") ||
          entry.resource !== form.get("resource")
        ) {
          return [400, { error: "invalid_grant" }];
        }
        entry.used = true;
        const grantId = randomId("grant");
        grants.set(grantId, { subject: entry.subject, clientId, revoked: false });
        return [200, issue(grantId)];
      }
      const entry = refreshTokens.get(form.get("refresh_token") ?? "");
      const grant = entry === undefined ? undefined : grants.get(entry.grantId);
      if (
        entry === undefined ||
        grant === undefined ||
        grant.revoked ||
        grant.clientId !== clientId
      ) {
        return [400, { error: "invalid_grant" }];
      }
      // Reuse of a rotated refresh token revokes the whole grant, as OAuth 2.1 recommends.
      if (entry.rotated || form.get("resource") !== MCP_URL) {
        grant.revoked = true;
        return [400, { error: "invalid_grant" }];
      }
      entry.rotated = true;
      return [200, issue(entry.grantId)];
    };
    const metadataPaths =
      options.tenant === undefined
        ? ["/.well-known/oauth-authorization-server"]
        : [`${options.tenant}/.well-known/openid-configuration`];
    const resourcePath = options.bareChallenge
      ? "/.well-known/oauth-protected-resource"
      : "/.well-known/oauth-protected-resource/mcp";

    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const url = new URL(request.url);
        const text =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const form = new URLSearchParams(text);
        requests.push({
          method: request.method,
          path: url.pathname,
          form,
          authorization: request.headers.authorization,
        });
        const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json", ...headers },
            }),
          );
        // The service has acted; its answer waits, as a slow network would hold it.
        const answerHeld = Effect.gen(function* () {
          const held = gate;
          if (held?.path !== url.pathname) return;
          gate = undefined;
          yield* Deferred.succeed(held.reached, undefined);
          yield* Deferred.await(held.release);
        });
        if (url.pathname === "/mcp") {
          return json(
            401,
            { error: "invalid_token" },
            {
              "www-authenticate": options.bareChallenge
                ? 'Bearer error="invalid_token"'
                : `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="mail.read"`,
            },
          );
        }
        if (url.pathname === resourcePath) {
          return json(200, {
            resource: options.resource ?? MCP_URL,
            authorization_servers: [issuer],
            scopes_supported: ["mail.read", "mail.send"],
          });
        }
        if (metadataPaths.includes(url.pathname)) {
          return json(200, {
            issuer,
            authorization_endpoint: `${BASE}/authorize`,
            token_endpoint: `${BASE}/token`,
            ...(options.registration === false
              ? {}
              : { registration_endpoint: `${BASE}/register` }),
            revocation_endpoint: `${BASE}/revoke`,
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: options.authMethods ?? ["none"],
            authorization_response_iss_parameter_supported: options.issAdvertised ?? true,
          });
        }
        if (url.pathname === "/register") {
          const registration = JSON.parse(text) as { redirect_uris: ReadonlyArray<string> };
          const clientId = randomId("client");
          clients.set(clientId, { redirectUris: registration.redirect_uris });
          yield* answerHeld;
          return json(201, { client_id: clientId, token_endpoint_auth_method: "none" });
        }
        if (url.pathname === "/token") {
          const [status, body] = token(request, form);
          yield* answerHeld;
          return json(status, body);
        }
        if (url.pathname === "/revoke") {
          if (clientOf(request, form) === undefined) return json(401, { error: "invalid_client" });
          const token = form.get("token") ?? "";
          const refresh = refreshTokens.get(token);
          // An already rotated refresh token is no longer valid, so revoking it changes nothing.
          const grantId =
            refresh?.rotated === true ? undefined : (refresh?.grantId ?? accessTokens.get(token));
          const grant = grantId === undefined ? undefined : grants.get(grantId);
          if (grant !== undefined) grant.revoked = true;
          return json(200, {});
        }
        return json(404, {});
      }),
    );

    /** The browser: signs in as `subject` and returns where the service redirects. */
    const authorize = (
      authorizationUrl: string,
      subject: string,
      response: { readonly iss?: "omit" | "wrong"; readonly deny?: boolean } = {},
    ) => {
      const params = new URL(authorizationUrl).searchParams;
      const registered = clients.get(params.get("client_id") ?? "");
      const redirectUri = params.get("redirect_uri") ?? "";
      assert.isDefined(registered);
      assert.include(registered?.redirectUris ?? [], redirectUri);
      assert.equal(params.get("code_challenge_method"), "S256");
      assert.equal(params.get("resource"), options.resource ?? MCP_URL);
      const target = new URL(redirectUri);
      target.searchParams.set("state", params.get("state") ?? "");
      if (response.deny) {
        target.searchParams.set("error", "access_denied");
      } else {
        const code = randomId("code");
        issued.push(code);
        codes.set(code, {
          clientId: params.get("client_id") ?? "",
          redirectUri,
          challenge: params.get("code_challenge") ?? "",
          resource: params.get("resource") ?? "",
          subject,
          used: false,
        });
        target.searchParams.set("code", code);
      }
      if (response.iss !== "omit") {
        target.searchParams.set(
          "iss",
          response.iss === "wrong" ? "https://evil.example.test" : issuer,
        );
      }
      return target.toString();
    };

    const holdNext = (path: "/register" | "/token") =>
      Effect.gen(function* () {
        const next = {
          path,
          reached: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        gate = next;
        return next;
      });

    const subjectOf = (accessToken: string) => {
      const grant = grants.get(accessTokens.get(accessToken) ?? "");
      return grant === undefined || grant.revoked ? undefined : grant.subject;
    };

    return {
      client,
      requests,
      issued,
      authorize,
      holdNext,
      subjectOf,
      revokeEverything: () => {
        for (const grant of grants.values()) grant.revoked = true;
      },
      paths: () => requests.map(({ path }) => path),
      tokenRequests: (grantType: string) =>
        requests.filter(
          ({ path, form }) => path === "/token" && form.get("grant_type") === grantType,
        ),
    };
  });

const connectionA = McpConnectionId.make("3a3a3a3a-0000-4000-8000-00000000003a");
const connectionB = McpConnectionId.make("3b3b3b3b-0000-4000-8000-00000000003b");

const defineConnection = (id: McpConnectionId, oauth: McpConnectionOAuthSetup = { scopes: [] }) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateMcpConnections((current) =>
      Effect.succeed({
        mcpConnections: {
          ...current.mcpConnections,
          [id]: {
            label: "Mail",
            enabled: true,
            revision: 1,
            authentication: { type: "bindings" },
            transport: { type: "http", url: MCP_URL, httpHeaders: {}, oauth },
          },
        },
        retiredMcpConnectionIds: current.retiredMcpConnectionIds,
      }),
    );
  });

const resolver = SecretResolver.SecretResolver.of({
  read: () => Effect.die("no secret references in these tests"),
  invalidate: () => Effect.void,
  label: (provider) => Effect.succeed(provider),
});

const makeService = (fixture: { readonly client: HttpClient.HttpClient }) =>
  McpConnectionOAuth.McpConnectionOAuth.pipe(
    Effect.provide(
      McpConnectionOAuth.layer.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, fixture.client)),
        Layer.provide(Layer.succeed(SecretResolver.SecretResolver, resolver)),
      ),
    ),
  );

/** Signs `id` in as `subject` through a server-mode callback. */
const connect = (
  oauth: McpConnectionOAuth.McpConnectionOAuth["Service"],
  fixture: Effect.Success<ReturnType<typeof makeFixture>>,
  id: McpConnectionId,
  subject: string,
) =>
  Effect.gen(function* () {
    const started = yield* oauth.start({ connectionId: id, redirectOrigin: ORIGIN });
    const callback = new URL(fixture.authorize(started.authorizationUrl, subject));
    yield* oauth.completeCallback(callback.search.slice(1));
    return started;
  });

const tokenOf = (token: Option.Option<Redacted.Redacted<string>>) =>
  Option.getOrUndefined(Option.map(token, Redacted.value));

/** Runs `test` with every log line it writes captured as text. */
const withCapturedLogs = <A, E, R>(
  test: (logs: ReadonlyArray<string>) => Effect.Effect<A, E, R>,
) => {
  const logs: Array<string> = [];
  return test(logs).pipe(
    Effect.provide(
      Logger.layer([Logger.make(({ message }) => void logs.push(JSON.stringify(message)))], {
        mergeWithExisting: false,
      }),
    ),
  );
};

it.layer(Layer.mergeAll(NodeServices.layer, NodeCryptoLayer.layer))(
  "MCP connection OAuth",
  (it) => {
    it.effect(
      "signs in once with PKCE and a resource indicator and refuses every other response",
      () =>
        withCapturedLogs((logs) =>
          Effect.gen(function* () {
            const fixture = yield* makeFixture();
            yield* defineConnection(connectionA);
            const oauth = yield* makeService(fixture);

            const started = yield* oauth.start({
              connectionId: connectionA,
              redirectOrigin: ORIGIN,
            });
            assert.equal(started.redirectUri, REDIRECT);
            const authorization = new URL(started.authorizationUrl).searchParams;
            // No scopes configured: the challenge's scope.
            assert.equal(authorization.get("scope"), "mail.read");
            assert.deepEqual((yield* oauth.state(connectionA)).signIn, {
              state: "pending",
              flowId: started.flowId,
              expiresAt: started.expiresAt,
            });

            const callback = fixture.authorize(started.authorizationUrl, "alice");
            const complete = (callbackUrl: string, flowId = started.flowId) =>
              oauth.complete({ connectionId: connectionA, flowId, callbackUrl }).pipe(
                Effect.flip,
                Effect.map((error) => error.reason),
              );
            const tampered = (edit: (url: URL) => void) => {
              const url = new URL(callback);
              edit(url);
              return url.toString();
            };
            assert.equal(yield* complete(callback, "another-flow"), "sign-in-ended");
            assert.equal(
              yield* complete(tampered((url) => url.searchParams.set("state", "forged"))),
              "callback-invalid",
            );
            assert.equal(
              yield* complete(
                tampered((url) => url.searchParams.set("iss", "https://evil.example.test")),
              ),
              "callback-invalid",
            );
            assert.equal(
              yield* complete(tampered((url) => url.searchParams.append("state", "forged"))),
              "callback-invalid",
            );
            assert.equal(
              yield* complete(tampered((url) => (url.pathname = "/elsewhere"))),
              "callback-invalid",
            );
            assert.deepEqual(fixture.tokenRequests("authorization_code"), []);

            const connected = yield* oauth.complete({
              connectionId: connectionA,
              flowId: started.flowId,
              callbackUrl: callback,
            });
            assert.equal(connected.credential.state, "connected");
            assert.isUndefined(connected.signIn);
            const [exchange] = fixture.tokenRequests("authorization_code");
            assert.equal(exchange?.form.get("resource"), MCP_URL);
            assert.isNotNull(exchange?.form.get("code_verifier"));
            const token = tokenOf(yield* oauth.accessToken(connectionA));
            assert.equal(fixture.subjectOf(token ?? ""), "alice");
            assert.equal(yield* complete(callback), "sign-in-ended");

            // A cancelled sign-in and an expired one cannot finish.
            const cancelled = yield* oauth.start({
              connectionId: connectionA,
              redirectOrigin: ORIGIN,
            });
            const cancelledCallback = fixture.authorize(cancelled.authorizationUrl, "mallory");
            yield* oauth.cancel({ connectionId: connectionA, flowId: cancelled.flowId });
            assert.equal(yield* complete(cancelledCallback, cancelled.flowId), "sign-in-ended");
            const expired = yield* oauth.start({
              connectionId: connectionA,
              redirectOrigin: ORIGIN,
            });
            const expiredCallback = fixture.authorize(expired.authorizationUrl, "mallory");
            yield* TestClock.adjust("11 minutes");
            assert.equal(yield* complete(expiredCallback, expired.flowId), "sign-in-ended");
            assert.deepEqual((yield* oauth.state(connectionA)).signIn, {
              state: "failed",
              flowId: expired.flowId,
              reason: "sign-in-ended",
            });
            // Still alice's grant: none of the refused responses replaced it.
            assert.equal(
              fixture.subjectOf(tokenOf(yield* oauth.accessToken(connectionA)) ?? ""),
              "alice",
            );

            for (const redirectOrigin of [
              "http://t3.example.test",
              "https://t3.example.test/path",
            ]) {
              assert.equal(
                (yield* oauth
                  .start({ connectionId: connectionA, redirectOrigin })
                  .pipe(Effect.flip)).reason,
                "redirect-invalid",
              );
            }
            // Codes and tokens never reach a log line.
            for (const value of fixture.issued) {
              for (const line of logs) assert.notInclude(line, value);
            }
          }),
        ).pipe(Effect.provide(layerStores)),
    );

    it.effect("requires iss when the service advertises it, on error responses too", () =>
      Effect.gen(function* () {
        const rows = [
          { advertised: true, iss: "omit", deny: false, outcome: "callback-invalid" },
          { advertised: true, iss: "match", deny: false, outcome: "connected" },
          { advertised: false, iss: "omit", deny: false, outcome: "connected" },
          { advertised: false, iss: "wrong", deny: false, outcome: "callback-invalid" },
          { advertised: true, iss: "omit", deny: true, outcome: "callback-invalid" },
          { advertised: true, iss: "match", deny: true, outcome: "declined" },
        ] as const;
        for (const row of rows) {
          const fixture = yield* makeFixture({ issAdvertised: row.advertised });
          yield* defineConnection(connectionA);
          const oauth = yield* makeService(fixture);
          const started = yield* oauth.start({ connectionId: connectionA, redirectOrigin: ORIGIN });
          const callbackUrl = fixture.authorize(started.authorizationUrl, "alice", {
            ...(row.iss === "match" ? {} : { iss: row.iss }),
            deny: row.deny,
          });
          const outcome = yield* oauth
            .complete({ connectionId: connectionA, flowId: started.flowId, callbackUrl })
            .pipe(
              Effect.map((state) => state.credential.state),
              Effect.catch((error) => Effect.succeed(error.reason)),
            );
          assert.equal(outcome, row.outcome, JSON.stringify(row));
          if (row.outcome === "callback-invalid") {
            assert.deepEqual(fixture.tokenRequests("authorization_code"), []);
          }
        }
      }).pipe(Effect.provide(layerStores)),
    );

    it.effect("binds the resource metadata to the connection's endpoint before registering", () =>
      Effect.gen(function* () {
        yield* defineConnection(connectionA);
        for (const resource of ["https://other.example.test/mcp", `${BASE}/other`]) {
          const fixture = yield* makeFixture({ resource });
          const oauth = yield* makeService(fixture);
          const error = yield* oauth
            .start({ connectionId: connectionA, redirectOrigin: ORIGIN })
            .pipe(Effect.flip);
          assert.equal(error.reason, "resource-mismatch");
          assert.notInclude(fixture.paths(), "/register");
          assert.notInclude(fixture.paths(), "/token");
          assert.isUndefined((yield* oauth.state(connectionA)).signIn);
        }
        // A resource the endpoint sits under is the same service, and is what the grant carries.
        const fixture = yield* makeFixture({ resource: `${BASE}/` });
        const oauth = yield* makeService(fixture);
        yield* connect(oauth, fixture, connectionA, "alice");
        assert.equal(
          fixture.tokenRequests("authorization_code")[0]?.form.get("resource"),
          `${BASE}/`,
        );
      }).pipe(Effect.provide(layerStores)),
    );

    it.effect("finds metadata without a challenge and at a tenant issuer's OpenID path", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ bareChallenge: true, tenant: "/tenant" });
        yield* defineConnection(connectionA, { scopes: ["mail.read", "offline_access"] });
        const oauth = yield* makeService(fixture);
        const started = yield* oauth.start({ connectionId: connectionA, redirectOrigin: ORIGIN });
        assert.deepEqual(fixture.paths().slice(0, 7), [
          "/mcp",
          "/.well-known/oauth-protected-resource/mcp",
          "/.well-known/oauth-protected-resource",
          "/.well-known/oauth-authorization-server/tenant",
          "/.well-known/openid-configuration/tenant",
          "/tenant/.well-known/openid-configuration",
          "/register",
        ]);
        assert.equal(
          new URL(started.authorizationUrl).searchParams.get("scope"),
          "mail.read offline_access",
        );
        // Without a challenge scope or configured scopes, the resource's own list.
        yield* defineConnection(connectionB);
        const fallback = yield* oauth.start({ connectionId: connectionB, redirectOrigin: ORIGIN });
        assert.equal(
          new URL(fallback.authorizationUrl).searchParams.get("scope"),
          "mail.read mail.send",
        );
      }).pipe(Effect.provide(layerStores)),
    );

    it.effect("uses a preregistered app for sign-in, refresh and revocation", () =>
      Effect.gen(function* () {
        for (const method of ["client_secret_basic", "client_secret_post"] as const) {
          const app = { id: "mail-app", secret: "app-secret", method };
          const fixture = yield* makeFixture({
            registration: false,
            authMethods: [method],
            preregistered: app,
          });
          yield* defineConnection(connectionA, {
            scopes: [],
            client: { id: app.id, secret: app.secret },
          });
          const oauth = yield* makeService(fixture);
          yield* connect(oauth, fixture, connectionA, "alice");
          yield* TestClock.adjust("31 minutes");
          const token = tokenOf(yield* oauth.accessToken(connectionA));
          assert.equal(fixture.subjectOf(token ?? ""), "alice", method);
          yield* oauth.disconnect(connectionA);
          assert.isUndefined(fixture.subjectOf(token ?? ""), method);
          const authenticated = fixture.requests.filter(({ path }) =>
            ["/token", "/revoke"].includes(path),
          );
          assert.deepEqual(
            authenticated.map(({ path, form, authorization }) => [
              path,
              method === "client_secret_basic"
                ? authorization?.startsWith("Basic ")
                : form.get("client_secret") === app.secret,
            ]),
            [
              ["/token", true],
              ["/token", true],
              ["/revoke", true],
            ],
            method,
          );
          assert.notInclude(fixture.paths(), "/register");
        }
        // Without a client ID, a service that cannot register apps is named.
        const fixture = yield* makeFixture({ registration: false });
        yield* defineConnection(connectionB);
        const oauth = yield* makeService(fixture);
        assert.equal(
          (yield* oauth
            .start({ connectionId: connectionB, redirectOrigin: ORIGIN })
            .pipe(Effect.flip)).reason,
          "registration-unsupported",
        );
      }).pipe(Effect.provide(layerStores)),
    );

    it.effect("never follows a redirect that would carry a code or secret elsewhere", () =>
      Effect.gen(function* () {
        // Node's own fetch, so its redirect handling is what is tested; no request leaves.
        const agent = new MockAgent();
        agent.disableNetConnect();
        yield* Effect.addFinalizer(() => Effect.promise(() => agent.close()));
        const service = agent.get(BASE);
        const asJson = { headers: { "content-type": "application/json" } };
        service.intercept({ path: "/mcp", method: "POST" }).reply(401, "", {
          headers: { "www-authenticate": `Bearer resource_metadata="${BASE}/resource"` },
        });
        service
          .intercept({ path: "/resource" })
          .reply(200, { resource: MCP_URL, authorization_servers: [BASE] }, asJson);
        service.intercept({ path: "/.well-known/oauth-authorization-server" }).reply(
          200,
          {
            issuer: BASE,
            authorization_endpoint: `${BASE}/authorize`,
            token_endpoint: `${BASE}/token`,
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
          },
          asJson,
        );
        service.intercept({ path: "/token", method: "POST" }).reply(307, "", {
          headers: { location: "http://collector.example.test/capture" },
        });
        const captured: Array<unknown> = [];
        agent
          .get("http://collector.example.test")
          .intercept({ path: "/capture", method: "POST" })
          .reply(200, ({ body }) => {
            captured.push(body);
            return { access_token: "collected", token_type: "Bearer" };
          });
        yield* defineConnection(connectionA, {
          scopes: [],
          client: { id: "mail-app", secret: "app-secret" },
        });
        const oauth = yield* McpConnectionOAuth.McpConnectionOAuth.pipe(
          Effect.provide(
            McpConnectionOAuth.layer.pipe(
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(Layer.succeed(SecretResolver.SecretResolver, resolver)),
            ),
          ),
          Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
            globalThis.fetch(input, Object.assign({}, init, { dispatcher: agent })),
          ),
        );
        const started = yield* oauth.start({ connectionId: connectionA, redirectOrigin: ORIGIN });
        const callback = new URL(REDIRECT);
        callback.search = new URLSearchParams({
          state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
          code: "issued-code",
        }).toString();
        const failed = yield* oauth
          .complete({
            connectionId: connectionA,
            flowId: started.flowId,
            callbackUrl: callback.toString(),
          })
          .pipe(Effect.flip);
        assert.equal(failed.reason, "unavailable");
        assert.deepEqual(captured, []);
        assert.equal((yield* oauth.state(connectionA)).credential.state, "signed-out");
      }).pipe(Effect.provide(layerStores)),
    );

    it.effect("refreshes once per due token and signs out when the service ends the grant", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* defineConnection(connectionA);
        const oauth = yield* makeService(fixture);
        yield* connect(oauth, fixture, connectionA, "alice");
        const first = tokenOf(yield* oauth.accessToken(connectionA));
        yield* TestClock.adjust("29 minutes");
        assert.equal(tokenOf(yield* oauth.accessToken(connectionA)), first);
        assert.equal(fixture.tokenRequests("refresh_token").length, 0);

        // Past half its lifetime: two loads at once share one refresh, as a reused refresh
        // token would end the grant.
        yield* TestClock.adjust("2 minutes");
        const [a, b] = yield* Effect.all(
          [oauth.accessToken(connectionA), oauth.accessToken(connectionA)],
          { concurrency: "unbounded" },
        );
        assert.equal(fixture.tokenRequests("refresh_token").length, 1);
        assert.equal(tokenOf(a), tokenOf(b));
        assert.notEqual(tokenOf(a), first);
        assert.equal(fixture.subjectOf(tokenOf(a) ?? ""), "alice");

        // A refused token forces exactly one refresh.
        yield* oauth.markStale(connectionA, "call");
        const third = tokenOf(yield* oauth.accessToken(connectionA));
        assert.equal(tokenOf(yield* oauth.accessToken(connectionA)), third);
        assert.equal(fixture.tokenRequests("refresh_token").length, 2);

        fixture.revokeEverything();
        yield* oauth.markStale(connectionA, "startup");
        assert.isTrue(Option.isNone(yield* oauth.accessToken(connectionA)));
        assert.deepEqual((yield* oauth.state(connectionA)).credential, {
          state: "signed-out",
          reason: "revoked",
        });
        assert.isTrue(Option.isNone(yield* oauth.accessToken(connectionA)));
        assert.equal(fixture.tokenRequests("refresh_token").length, 3);

        // A refused token that cannot be refreshed is given back before it is dropped.
        const accessOnly = yield* makeFixture({ refreshTokens: false });
        const withoutRefresh = yield* makeService(accessOnly);
        yield* connect(withoutRefresh, accessOnly, connectionA, "alice");
        const lone = tokenOf(yield* withoutRefresh.accessToken(connectionA));
        assert.equal(accessOnly.subjectOf(lone ?? ""), "alice");
        yield* withoutRefresh.markStale(connectionA, "startup");
        assert.isTrue(Option.isNone(yield* withoutRefresh.accessToken(connectionA)));
        assert.deepEqual((yield* withoutRefresh.state(connectionA)).credential, {
          state: "signed-out",
          reason: "expired",
        });
        assert.isUndefined(accessOnly.subjectOf(lone ?? ""));
      }).pipe(Effect.provide(layerStores)),
    );

    it.effect("lets a disconnect or cancel win over a refresh or exchange already under way", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* defineConnection(connectionA);
        const oauth = yield* makeService(fixture);
        yield* connect(oauth, fixture, connectionA, "alice");

        // Disconnect while a load's refresh waits on the service.
        yield* TestClock.adjust("31 minutes");
        const refreshGate = yield* fixture.holdNext("/token");
        const load = yield* Effect.forkChild(oauth.accessToken(connectionA));
        yield* Deferred.await(refreshGate.reached);
        const disconnect = yield* Effect.forkChild(oauth.disconnect(connectionA));
        yield* Deferred.succeed(refreshGate.release, undefined);
        const loaded = tokenOf(yield* Fiber.join(load));
        assert.deepEqual((yield* Fiber.join(disconnect)).credential, {
          state: "signed-out",
          reason: "disconnected",
        });
        // The rotated grant was revoked and nothing restores it.
        assert.isUndefined(fixture.subjectOf(loaded ?? ""));
        assert.isTrue(Option.isNone(yield* oauth.accessToken(connectionA)));
        assert.deepEqual((yield* oauth.state(connectionA)).credential, {
          state: "signed-out",
          reason: "disconnected",
        });

        // Cancel, disconnect or a newer start while the code exchange runs: it is not published.
        for (const interrupt of ["cancel", "disconnect", "restart"] as const) {
          const started = yield* oauth.start({ connectionId: connectionA, redirectOrigin: ORIGIN });
          const callbackUrl = fixture.authorize(started.authorizationUrl, "mallory");
          const exchangeGate = yield* fixture.holdNext("/token");
          const exchange = yield* Effect.forkChild(
            oauth.complete({ connectionId: connectionA, flowId: started.flowId, callbackUrl }),
          );
          yield* Deferred.await(exchangeGate.reached);
          if (interrupt === "cancel") {
            yield* oauth.cancel({ connectionId: connectionA, flowId: started.flowId });
          } else if (interrupt === "disconnect") {
            yield* oauth.disconnect(connectionA);
          } else {
            yield* oauth.start({ connectionId: connectionA, redirectOrigin: ORIGIN });
          }
          yield* Deferred.succeed(exchangeGate.release, undefined);
          assert.equal((yield* Fiber.join(exchange).pipe(Effect.flip)).reason, "sign-in-ended");
          assert.equal((yield* oauth.state(connectionA)).credential.state, "signed-out", interrupt);
          assert.isTrue(Option.isNone(yield* oauth.accessToken(connectionA)), interrupt);
          // The tokens that exchange got were given back.
          assert.equal(fixture.requests.at(-1)?.path, "/revoke", interrupt);
        }

        // A disconnect or removal while a start still registers: that sign-in never begins.
        for (const signOut of ["disconnect", "forget"] as const) {
          const registerGate = yield* fixture.holdNext("/register");
          const starting = yield* Effect.forkChild(
            oauth.start({ connectionId: connectionA, redirectOrigin: ORIGIN }),
          );
          yield* Deferred.await(registerGate.reached);
          yield* signOut === "disconnect"
            ? oauth.disconnect(connectionA)
            : oauth.forget(connectionA);
          yield* Deferred.succeed(registerGate.release, undefined);
          assert.equal((yield* Fiber.join(starting).pipe(Effect.flip)).reason, "sign-in-ended");
          assert.isUndefined((yield* oauth.state(connectionA)).signIn, signOut);
        }
      }).pipe(Effect.provide(layerStores)),
    );

    it.effect(
      "keeps grants and drops sign-ins across a restart; disconnect and removal converge",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeFixture();
          yield* defineConnection(connectionA);
          const before = yield* makeService(fixture);
          yield* connect(before, fixture, connectionA, "alice");
          const pending = yield* before.start({
            connectionId: connectionA,
            redirectOrigin: ORIGIN,
          });
          const callbackUrl = fixture.authorize(pending.authorizationUrl, "mallory");

          const after = yield* makeService(fixture);
          const restarted = yield* after.state(connectionA);
          assert.equal(restarted.credential.state, "connected");
          assert.isUndefined(restarted.signIn);
          assert.equal(
            (yield* after
              .complete({ connectionId: connectionA, flowId: pending.flowId, callbackUrl })
              .pipe(Effect.flip)).reason,
            "sign-in-ended",
          );
          const token = tokenOf(yield* after.accessToken(connectionA));
          assert.equal(fixture.subjectOf(token ?? ""), "alice");

          yield* after.disconnect(connectionA);
          assert.isUndefined(fixture.subjectOf(token ?? ""));
          const revocations = () => fixture.paths().filter((path) => path === "/revoke").length;
          assert.equal(revocations(), 1);
          yield* after.disconnect(connectionA);
          assert.equal(revocations(), 1);
          assert.deepEqual((yield* after.state(connectionA)).credential, {
            state: "signed-out",
            reason: "disconnected",
          });
          yield* after.forget(connectionA);
          assert.deepEqual((yield* after.state(connectionA)).credential, {
            state: "signed-out",
            reason: "never",
          });
          const store = yield* ServerSecretStore.ServerSecretStore;
          assert.isTrue(Option.isNone(yield* store.get(`mcp-oauth-${connectionA}`)));
        }).pipe(Effect.provide(layerStores)),
    );
  },
);
