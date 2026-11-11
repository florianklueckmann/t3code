import {
  MCP_CONNECTION_OAUTH_CALLBACK_PATH,
  McpConnectionOAuthError,
  McpConnectionOAuthSignedOutReason,
  type McpConnectionId,
  type McpConnectionOAuthCancelInput,
  type McpConnectionOAuthCompleteInput,
  type McpConnectionOAuthFailure,
  type McpConnectionOAuthStartInput,
  type McpConnectionOAuthStartResult,
  type McpConnectionOAuthState,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";
import { isLoopbackHost } from "../startupAccess.ts";

const FLOW_LIFETIME_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT = Duration.seconds(30);
const recordName = (id: McpConnectionId) => `mcp-oauth-${id}`;

const ClientAuth = Schema.Literals(["none", "client_secret_basic", "client_secret_post"]);
type ClientAuth = typeof ClientAuth.Type;

/** One connection's grant, kept in the server secret store. It never leaves the server. */
const StoredGrant = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("connected"),
    connectedAt: Schema.Number,
    issuer: Schema.String,
    resource: Schema.String,
    tokenEndpoint: Schema.String,
    revocationEndpoint: Schema.optionalKey(Schema.String),
    clientId: Schema.String,
    clientAuth: ClientAuth,
    /** Issued by dynamic registration. A preregistered app's secret stays in settings. */
    registeredSecret: Schema.optionalKey(Schema.String),
    accessToken: Schema.String,
    refreshToken: Schema.optionalKey(Schema.String),
    obtainedAt: Schema.Number,
    expiresAt: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    state: Schema.Literal("signed-out"),
    reason: McpConnectionOAuthSignedOutReason,
  }),
]);
type StoredGrant = typeof StoredGrant.Type;
type ConnectedGrant = Extract<StoredGrant, { readonly state: "connected" }>;
const decodeGrant = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredGrant));
const encodeGrant = Schema.encodeEffect(Schema.fromJsonString(StoredGrant));

const TokenResponse = Schema.Struct({
  access_token: Schema.String.check(Schema.isMinLength(1)),
  token_type: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  refresh_token: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
});
const decodeTokenResponse = Schema.decodeUnknownOption(TokenResponse);
const decodeTokenError = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }));

const ResourceMetadata = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  scopes_supported: Schema.optionalKey(Schema.Array(Schema.String)),
});
const decodeResourceMetadata = Schema.decodeUnknownOption(ResourceMetadata);

const ServerMetadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optionalKey(Schema.String),
  revocation_endpoint: Schema.optionalKey(Schema.String),
  code_challenge_methods_supported: Schema.optionalKey(Schema.Array(Schema.String)),
  token_endpoint_auth_methods_supported: Schema.optionalKey(Schema.Array(Schema.String)),
  authorization_response_iss_parameter_supported: Schema.optionalKey(Schema.Boolean),
});
type ServerMetadata = typeof ServerMetadata.Type;
const decodeServerMetadata = Schema.decodeUnknownOption(ServerMetadata);

const Registration = Schema.Struct({
  client_id: Schema.String.check(Schema.isMinLength(1)),
  client_secret: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  token_endpoint_auth_method: Schema.optionalKey(Schema.String),
});
const decodeRegistration = Schema.decodeUnknownOption(Registration);

interface Client {
  readonly id: string;
  readonly auth: ClientAuth;
  readonly registeredSecret?: string;
}

interface Discovery {
  readonly resource: string;
  readonly issuer: string;
  readonly issRequired: boolean;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly registrationEndpoint?: string;
  readonly authMethods?: ReadonlyArray<string>;
  readonly scope?: string;
}

interface Flow {
  readonly connectionId: McpConnectionId;
  readonly flowId: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
  readonly discovery: Discovery;
  readonly client: Client;
  used: boolean;
}

type TokenResult =
  | { readonly _tag: "tokens"; readonly tokens: typeof TokenResponse.Type }
  | { readonly _tag: "refused"; readonly error: string };

const fail = (reason: McpConnectionOAuthFailure, connectionId?: McpConnectionId) =>
  new McpConnectionOAuthError({
    reason,
    ...(connectionId === undefined ? {} : { connectionId }),
  });

const parseUrl = (raw: string): URL | undefined => (URL.canParse(raw) ? new URL(raw) : undefined);

/** OAuth endpoints and the bearer token stay on https; loopback http is for local services. */
const isSecure = (url: URL) =>
  url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));

/**
 * RFC 9728 3.3 binds metadata to the resource it describes. Same origin, and a path the MCP URL
 * equals or sits under (the MCP TypeScript SDK's rule), so a token for another service never
 * reaches this endpoint.
 */
const resourceCovers = (resource: URL, endpoint: URL) => {
  if (resource.origin !== endpoint.origin || resource.hash !== "") return false;
  if (resource.search !== "" && resource.search !== endpoint.search) return false;
  const base = resource.pathname.endsWith("/") ? resource.pathname : `${resource.pathname}/`;
  return endpoint.pathname === resource.pathname || endpoint.pathname.startsWith(base);
};

const challengeParameter = (challenge: string, name: string) =>
  new RegExp(`(?:^|[\\s,])${name}="([^"]*)"`, "i").exec(challenge)?.[1];

/** RFC 9728 3.1: the path-specific well-known URI first, then the root one. */
const resourceMetadataCandidates = (endpoint: URL) => {
  const path = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/$/, "");
  const root = `${endpoint.origin}/.well-known/oauth-protected-resource`;
  return path === "" ? [root] : [`${root}${path}`, root];
};

/** RFC 8414 and OpenID Connect discovery, including the path-appended OpenID form for tenants. */
const serverMetadataCandidates = (issuer: URL) => {
  const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  return path === ""
    ? [
        `${issuer.origin}/.well-known/oauth-authorization-server`,
        `${issuer.origin}/.well-known/openid-configuration`,
      ]
    : [
        `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
        `${issuer.origin}/.well-known/openid-configuration${path}`,
        `${issuer.origin}${path}/.well-known/openid-configuration`,
      ];
};

/** With a secret, the server's listed method; RFC 8414 defaults to HTTP Basic. */
const secretAuth = (methods: ReadonlyArray<string> | undefined): ClientAuth =>
  methods !== undefined &&
  !methods.includes("client_secret_basic") &&
  methods.includes("client_secret_post")
    ? "client_secret_post"
    : "client_secret_basic";

const formEncode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");

/**
 * Signs MCP connections in with OAuth and keeps their tokens. Every change to one connection's
 * credential runs under that connection's lock, so a refresh, a sign-in finishing and a disconnect
 * never interleave: after Disconnect returns, nothing started earlier can restore the grant.
 */
export class McpConnectionOAuth extends Context.Service<
  McpConnectionOAuth,
  {
    readonly start: (
      input: McpConnectionOAuthStartInput,
    ) => Effect.Effect<McpConnectionOAuthStartResult, McpConnectionOAuthError>;
    readonly complete: (
      input: McpConnectionOAuthCompleteInput,
    ) => Effect.Effect<McpConnectionOAuthState, McpConnectionOAuthError>;
    /** The callback route's entry: the flow is the one its `state` names. */
    readonly completeCallback: (query: string) => Effect.Effect<void, McpConnectionOAuthError>;
    readonly cancel: (
      input: McpConnectionOAuthCancelInput,
    ) => Effect.Effect<McpConnectionOAuthState, McpConnectionOAuthError>;
    readonly disconnect: (
      connectionId: McpConnectionId,
    ) => Effect.Effect<McpConnectionOAuthState, McpConnectionOAuthError>;
    /** Signs out and deletes the grant of a connection being removed. */
    readonly forget: (
      connectionId: McpConnectionId,
    ) => Effect.Effect<void, McpConnectionOAuthError>;
    readonly state: (
      connectionId: McpConnectionId,
    ) => Effect.Effect<McpConnectionOAuthState, McpConnectionOAuthError>;
    readonly subscribe: (
      connectionId: McpConnectionId,
    ) => Stream.Stream<McpConnectionOAuthState, McpConnectionOAuthError>;
    /**
     * The token a load sends, refreshed first when less than half its lifetime is left or it was
     * marked stale. None when the connection has no usable token now; its load goes without it.
     */
    readonly accessToken: (
      connectionId: McpConnectionId,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
    /** The provider saw the token refused, so the next load refreshes before using it. */
    readonly markStale: (
      connectionId: McpConnectionId,
      source: "startup" | "call",
    ) => Effect.Effect<void>;
  }
>()("t3/mcpConnections/McpConnectionOAuth") {}

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const resolver = yield* SecretResolver.SecretResolver;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const digester = yield* Digest.Digest;
  const http = yield* HttpClient.HttpClient;
  const changes = yield* PubSub.unbounded<McpConnectionId>();

  const flows = new Map<McpConnectionId, Flow>();
  const failures = new Map<
    McpConnectionId,
    { readonly flowId: string; readonly reason: McpConnectionOAuthFailure }
  >();
  const stale = new Map<McpConnectionId, number>();
  /** Counts each connection's sign-outs: a start that saw an earlier count never installs. */
  const signOuts = new Map<McpConnectionId, number>();
  const locks = new Map<McpConnectionId, Semaphore.Semaphore>();
  const locked =
    (id: McpConnectionId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      let lock = locks.get(id);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(id, lock);
      }
      return lock.withPermits(1)(effect);
    };
  const changed = (id: McpConnectionId) => PubSub.publish(changes, id).pipe(Effect.asVoid);

  const randomText = (bytes: number) =>
    random.randomBytes(bytes).pipe(
      Effect.orDie,
      Effect.map((value) => Buffer.from(value).toString("base64url")),
    );

  const readGrant = (id: McpConnectionId) =>
    store.get(recordName(id)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.undefined,
          onSome: (bytes) => decodeGrant(new TextDecoder().decode(bytes)),
        }),
      ),
      Effect.mapError((cause) => new McpConnectionOAuthError({ reason: "unavailable", cause })),
    );
  const writeGrant = (id: McpConnectionId, grant: StoredGrant) =>
    encodeGrant(grant).pipe(
      Effect.flatMap((text) => store.set(recordName(id), new TextEncoder().encode(text))),
      Effect.mapError((cause) => new McpConnectionOAuthError({ reason: "unavailable", cause })),
    );

  /**
   * Requests to the service. Errors keep only the host: requests can carry codes and tokens, which
   * is also why a redirect fails instead of resending them to a URL nothing here checked.
   */
  const send = (request: HttpClientRequest.HttpClientRequest) =>
    http.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.tapError((error) =>
        Effect.logWarning("MCP connection OAuth request failed.", {
          host: parseUrl(request.url)?.host,
          error: error._tag,
        }),
      ),
      Effect.mapError(() => fail("unavailable")),
    );
  const jsonOf = (response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(Effect.orElseSucceed((): unknown => undefined));
  const getJson = (url: string) =>
    send(HttpClientRequest.get(url, { acceptJson: true })).pipe(
      Effect.flatMap((response) => (response.status === 200 ? jsonOf(response) : Effect.undefined)),
    );

  const firstMetadata = Effect.fn("McpConnectionOAuth.firstMetadata")(function* <A>(
    candidates: ReadonlyArray<string>,
    decode: (value: unknown) => Option.Option<A>,
  ) {
    for (const candidate of candidates) {
      const metadata = decode(yield* getJson(candidate));
      if (Option.isSome(metadata)) return metadata;
    }
    return Option.none<A>();
  });

  /** MCP authorization discovery. Nothing is registered or authorized before it all validates. */
  const discover = Effect.fn("McpConnectionOAuth.discover")(function* (endpointText: string) {
    const endpoint = parseUrl(endpointText);
    if (endpoint === undefined || !isSecure(endpoint)) return yield* fail("insecure");
    const probe = yield* send(
      HttpClientRequest.post(endpoint.toString()).pipe(
        HttpClientRequest.setHeaders({ accept: "application/json, text/event-stream" }),
        HttpClientRequest.bodyJsonUnsafe({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "T3 Code", version: "1" },
          },
        }),
      ),
    );
    const challenge = probe.status === 401 ? (probe.headers["www-authenticate"] ?? "") : "";
    const challenged = challengeParameter(challenge, "resource_metadata");
    const challengedUrl = challenged === undefined ? undefined : parseUrl(challenged);
    if (challengedUrl !== undefined && !isSecure(challengedUrl)) return yield* fail("insecure");
    const resourceMetadata = yield* firstMetadata(
      challengedUrl === undefined
        ? resourceMetadataCandidates(endpoint)
        : [challengedUrl.toString()],
      decodeResourceMetadata,
    );
    if (Option.isNone(resourceMetadata)) return yield* fail("discovery");
    const resource = parseUrl(resourceMetadata.value.resource);
    if (resource === undefined || !resourceCovers(resource, endpoint)) {
      return yield* fail("resource-mismatch");
    }
    const issuerText = resourceMetadata.value.authorization_servers[0]!;
    const issuer = parseUrl(issuerText);
    if (issuer === undefined) return yield* fail("discovery");
    if (!isSecure(issuer)) return yield* fail("insecure");
    const server = yield* firstMetadata(serverMetadataCandidates(issuer), (value) =>
      Option.filter(decodeServerMetadata(value), (metadata) => metadata.issuer === issuerText),
    );
    if (Option.isNone(server)) return yield* fail("discovery");
    const metadata: ServerMetadata = server.value;
    if (!(metadata.code_challenge_methods_supported ?? []).includes("S256")) {
      return yield* fail("discovery");
    }
    const endpoints = [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.registration_endpoint,
      metadata.revocation_endpoint,
    ].flatMap((value) => (value === undefined ? [] : [parseUrl(value)]));
    if (endpoints.some((url) => url === undefined)) return yield* fail("discovery");
    if (endpoints.some((url) => !isSecure(url!))) return yield* fail("insecure");
    const scope =
      challengeParameter(challenge, "scope") ?? resourceMetadata.value.scopes_supported?.join(" ");
    return {
      resource: resourceMetadata.value.resource,
      issuer: issuerText,
      issRequired: metadata.authorization_response_iss_parameter_supported === true,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      ...(metadata.revocation_endpoint === undefined
        ? {}
        : { revocationEndpoint: metadata.revocation_endpoint }),
      ...(metadata.registration_endpoint === undefined
        ? {}
        : { registrationEndpoint: metadata.registration_endpoint }),
      ...(metadata.token_endpoint_auth_methods_supported === undefined
        ? {}
        : { authMethods: metadata.token_endpoint_auth_methods_supported }),
      ...(scope === undefined || scope.trim() === "" ? {} : { scope }),
    } satisfies Discovery;
  });

  const register = Effect.fn("McpConnectionOAuth.register")(function* (
    discovery: Discovery,
    redirectUri: string,
  ) {
    if (discovery.registrationEndpoint === undefined) {
      return yield* fail("registration-unsupported");
    }
    const response = yield* send(
      HttpClientRequest.post(discovery.registrationEndpoint).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          client_name: "T3 Code",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      ),
    );
    const registration =
      response.status === 200 || response.status === 201
        ? decodeRegistration(yield* jsonOf(response))
        : Option.none();
    if (Option.isNone(registration)) return yield* fail("registration-failed");
    const { client_id, client_secret, token_endpoint_auth_method } = registration.value;
    return client_secret === undefined
      ? ({ id: client_id, auth: "none" } satisfies Client)
      : ({
          id: client_id,
          auth:
            token_endpoint_auth_method === "client_secret_post"
              ? "client_secret_post"
              : "client_secret_basic",
          registeredSecret: client_secret,
        } satisfies Client);
  });

  const oauthSetup = Effect.fn("McpConnectionOAuth.oauthSetup")(function* (id: McpConnectionId) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => fail("unavailable", id)),
    );
    const definition = current.mcpConnections[id];
    if (definition === undefined) return yield* fail("not-found", id);
    const transport = definition.transport;
    if (transport.type !== "http" || transport.oauth === undefined) {
      return yield* fail("not-oauth", id);
    }
    return { url: transport.url, oauth: transport.oauth };
  });

  /** A preregistered app's secret is read from its setting at each use, so it can rotate. */
  const clientSecret = (id: McpConnectionId, client: Client) =>
    client.auth === "none"
      ? Effect.undefined
      : client.registeredSecret !== undefined
        ? Effect.succeed(client.registeredSecret)
        : oauthSetup(id).pipe(
            Effect.flatMap(({ oauth }) =>
              oauth.client?.secret === undefined
                ? Effect.fail(fail("unavailable", id))
                : requireSettingsSecret(resolver, oauth.client.secret).pipe(
                    Effect.mapError(() => fail("unavailable", id)),
                  ),
            ),
          );

  /** A form POST to a token or revocation endpoint, authenticated as `client`. */
  const clientPost = Effect.fn("McpConnectionOAuth.clientPost")(function* (
    id: McpConnectionId,
    endpoint: string,
    client: Client,
    params: Readonly<Record<string, string>>,
  ) {
    const secret = yield* clientSecret(id, client);
    const request = HttpClientRequest.post(endpoint, { acceptJson: true });
    if (client.auth === "client_secret_basic" && secret !== undefined) {
      const credentials = Buffer.from(`${formEncode(client.id)}:${formEncode(secret)}`);
      return yield* send(
        HttpClientRequest.bodyUrlParams(
          HttpClientRequest.setHeader(
            request,
            "authorization",
            `Basic ${credentials.toString("base64")}`,
          ),
          params,
        ),
      );
    }
    return yield* send(
      HttpClientRequest.bodyUrlParams(request, {
        ...params,
        client_id: client.id,
        ...(client.auth === "client_secret_post" && secret !== undefined
          ? { client_secret: secret }
          : {}),
      }),
    );
  });

  /** A refusal is a result, not an error: `invalid_grant` signs the connection out. */
  const tokenRequest = Effect.fn("McpConnectionOAuth.tokenRequest")(function* (
    id: McpConnectionId,
    endpoint: string,
    client: Client,
    params: Readonly<Record<string, string>>,
  ) {
    const response = yield* clientPost(id, endpoint, client, params);
    const json = yield* jsonOf(response);
    const tokens = response.status === 200 ? decodeTokenResponse(json) : Option.none();
    if (Option.isSome(tokens) && (tokens.value.token_type ?? "bearer").toLowerCase() === "bearer") {
      return { _tag: "tokens", tokens: tokens.value } as TokenResult;
    }
    const error = Option.match(decodeTokenError(json), {
      onNone: () => `http_${response.status}`,
      onSome: (body) => body.error,
    });
    return { _tag: "refused", error } as TokenResult;
  });

  const grantClient = (grant: ConnectedGrant): Client => ({
    id: grant.clientId,
    auth: grant.clientAuth,
    ...(grant.registeredSecret === undefined ? {} : { registeredSecret: grant.registeredSecret }),
  });

  /** RFC 7009, best effort: the local sign-out stands whatever the service answers. */
  const revoke = (id: McpConnectionId, grant: ConnectedGrant) =>
    grant.revocationEndpoint === undefined
      ? Effect.void
      : clientPost(
          id,
          grant.revocationEndpoint,
          grantClient(grant),
          grant.refreshToken === undefined
            ? { token: grant.accessToken, token_type_hint: "access_token" }
            : { token: grant.refreshToken, token_type_hint: "refresh_token" },
        ).pipe(Effect.ignore);

  const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

  const state = Effect.fn("McpConnectionOAuth.state")(function* (id: McpConnectionId) {
    const grant = yield* readGrant(id);
    const now = yield* Clock.currentTimeMillis;
    const flow = flows.get(id);
    const failure = failures.get(id);
    const signIn: McpConnectionOAuthState["signIn"] =
      flow !== undefined
        ? flow.expiresAt > now
          ? { state: "pending", flowId: flow.flowId, expiresAt: isoOf(flow.expiresAt) }
          : { state: "failed", flowId: flow.flowId, reason: "sign-in-ended" }
        : failure === undefined
          ? undefined
          : { state: "failed", flowId: failure.flowId, reason: failure.reason };
    return {
      credential:
        grant?.state === "connected"
          ? { state: "connected", connectedAt: isoOf(grant.connectedAt) }
          : { state: "signed-out", reason: grant?.reason ?? "never" },
      ...(signIn === undefined ? {} : { signIn }),
    } satisfies McpConnectionOAuthState;
  });

  const start = Effect.fn("McpConnectionOAuth.start")(function* (
    input: McpConnectionOAuthStartInput,
  ) {
    const id = input.connectionId;
    const signOutsAtStart = signOuts.get(id) ?? 0;
    const { url, oauth } = yield* oauthSetup(id);
    const origin = parseUrl(input.redirectOrigin);
    if (
      origin === undefined ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== "" ||
      origin.username !== "" ||
      !isSecure(origin)
    ) {
      return yield* fail("redirect-invalid", id);
    }
    const redirectUri = `${origin.origin}${MCP_CONNECTION_OAUTH_CALLBACK_PATH}`;
    const discovery = yield* discover(url);
    const client: Client =
      oauth.client === undefined
        ? yield* register(discovery, redirectUri)
        : {
            id: oauth.client.id,
            auth: oauth.client.secret === undefined ? "none" : secretAuth(discovery.authMethods),
          };
    const verifier = yield* randomText(32);
    const challenge = Buffer.from(
      yield* digester.digest(Digest.sha256, new TextEncoder().encode(verifier)).pipe(Effect.orDie),
    ).toString("base64url");
    const flow: Flow = {
      connectionId: id,
      flowId: yield* randomText(16),
      state: yield* randomText(24),
      verifier,
      redirectUri,
      expiresAt: (yield* Clock.currentTimeMillis) + FLOW_LIFETIME_MS,
      discovery,
      client,
      used: false,
    };
    const scope = oauth.scopes.length > 0 ? oauth.scopes.join(" ") : discovery.scope;
    const authorizationUrl = new URL(discovery.authorizationEndpoint);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: client.id,
      redirect_uri: redirectUri,
      ...(scope === undefined ? {} : { scope }),
      state: flow.state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: discovery.resource,
    })) {
      authorizationUrl.searchParams.set(name, value);
    }
    // Discovery and registration can outlast a disconnect or removal, which then wins.
    yield* oauthSetup(id);
    if ((signOuts.get(id) ?? 0) !== signOutsAtStart) return yield* fail("sign-in-ended", id);
    // One sign-in per connection: a new start ends the previous one.
    flows.set(id, flow);
    failures.delete(id);
    yield* changed(id);
    return {
      flowId: flow.flowId,
      authorizationUrl: authorizationUrl.toString(),
      redirectUri,
      expiresAt: isoOf(flow.expiresAt),
    } satisfies McpConnectionOAuthStartResult;
  });

  const endFlow = Effect.fn("McpConnectionOAuth.endFlow")(function* (
    flow: Flow,
    reason: McpConnectionOAuthFailure,
  ) {
    if (flows.get(flow.connectionId) === flow) {
      flows.delete(flow.connectionId);
      failures.set(flow.connectionId, { flowId: flow.flowId, reason });
      yield* changed(flow.connectionId);
    }
    return yield* fail(reason, flow.connectionId);
  });

  /** Checks the response against its flow, then exchanges the code once. */
  const finish = Effect.fn("McpConnectionOAuth.finish")(function* (
    flow: Flow,
    callbackUrl: string,
  ) {
    const id = flow.connectionId;
    if (flow.used) return yield* fail("sign-in-ended", id);
    if ((yield* Clock.currentTimeMillis) >= flow.expiresAt) {
      return yield* endFlow(flow, "sign-in-ended");
    }
    const callback = parseUrl(callbackUrl);
    const expected = new URL(flow.redirectUri);
    if (
      callback === undefined ||
      callback.origin !== expected.origin ||
      callback.pathname !== expected.pathname
    ) {
      return yield* fail("callback-invalid", id);
    }
    const params = callback.searchParams;
    if (["state", "code", "iss", "error"].some((name) => params.getAll(name).length > 1)) {
      return yield* fail("callback-invalid", id);
    }
    if (params.get("state") !== flow.state) return yield* fail("callback-invalid", id);
    // RFC 9207: a server that advertises `iss` must send it, on errors too.
    const iss = params.get("iss");
    if (
      (iss === null && flow.discovery.issRequired) ||
      (iss !== null && iss !== flow.discovery.issuer)
    ) {
      return yield* fail("callback-invalid", id);
    }
    flow.used = true;
    if (params.has("error")) return yield* endFlow(flow, "declined");
    const code = params.get("code");
    if (code === null || code === "") return yield* endFlow(flow, "callback-invalid");
    const result = yield* tokenRequest(id, flow.discovery.tokenEndpoint, flow.client, {
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
      resource: flow.discovery.resource,
    }).pipe(Effect.catch((error) => endFlow(flow, error.reason)));
    if (result._tag === "refused") return yield* endFlow(flow, "exchange-failed");
    const now = yield* Clock.currentTimeMillis;
    const tokens = result.tokens;
    const grant: ConnectedGrant = {
      state: "connected",
      connectedAt: now,
      issuer: flow.discovery.issuer,
      resource: flow.discovery.resource,
      tokenEndpoint: flow.discovery.tokenEndpoint,
      ...(flow.discovery.revocationEndpoint === undefined
        ? {}
        : { revocationEndpoint: flow.discovery.revocationEndpoint }),
      clientId: flow.client.id,
      clientAuth: flow.client.auth,
      ...(flow.client.registeredSecret === undefined
        ? {}
        : { registeredSecret: flow.client.registeredSecret }),
      accessToken: tokens.access_token,
      ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
      obtainedAt: now,
      ...(tokens.expires_in === undefined ? {} : { expiresAt: now + tokens.expires_in * 1000 }),
    };
    // Publish only while this is still the connection's sign-in: a cancel, disconnect, removal or
    // newer start since the exchange began wins, and the tokens it got are given back.
    const published = yield* locked(id)(
      Effect.gen(function* () {
        if (flows.get(id) !== flow) return false;
        yield* writeGrant(id, grant);
        flows.delete(id);
        failures.delete(id);
        stale.delete(id);
        return true;
      }),
    );
    if (!published) {
      yield* revoke(id, grant);
      return yield* fail("sign-in-ended", id);
    }
    yield* changed(id);
    return yield* state(id);
  });

  const complete = Effect.fn("McpConnectionOAuth.complete")(function* (
    input: McpConnectionOAuthCompleteInput,
  ) {
    const flow = flows.get(input.connectionId);
    if (flow === undefined || flow.flowId !== input.flowId) {
      return yield* fail("sign-in-ended", input.connectionId);
    }
    return yield* finish(flow, input.callbackUrl);
  });

  const completeCallback = Effect.fn("McpConnectionOAuth.completeCallback")(function* (
    query: string,
  ) {
    const params = new URLSearchParams(query);
    const flowState = params.get("state");
    const flow = [...flows.values()].find((candidate) => candidate.state === flowState);
    if (flow === undefined) return yield* fail("sign-in-ended");
    // The browser reached this route on whatever host the proxy shows; the flow fixes the URI.
    yield* finish(flow, `${flow.redirectUri}?${params.toString()}`);
  });

  const cancel = Effect.fn("McpConnectionOAuth.cancel")(function* (
    input: McpConnectionOAuthCancelInput,
  ) {
    const flow = flows.get(input.connectionId);
    if (flow?.flowId === input.flowId) {
      flows.delete(input.connectionId);
      yield* changed(input.connectionId);
    }
    return yield* state(input.connectionId);
  });

  /** Ends any sign-in and revokes at the service, then marks the grant disconnected or deletes it. */
  const signOut = Effect.fn("McpConnectionOAuth.signOut")(function* (
    id: McpConnectionId,
    outcome: "disconnected" | "forget",
  ) {
    signOuts.set(id, (signOuts.get(id) ?? 0) + 1);
    flows.delete(id);
    failures.delete(id);
    yield* locked(id)(
      Effect.gen(function* () {
        const grant = yield* readGrant(id);
        if (grant?.state === "connected") yield* revoke(id, grant);
        stale.delete(id);
        if (outcome === "forget") {
          yield* store
            .remove(recordName(id))
            .pipe(
              Effect.mapError(
                (cause) => new McpConnectionOAuthError({ reason: "unavailable", cause }),
              ),
            );
        } else if (grant?.state === "connected") {
          yield* writeGrant(id, { state: "signed-out", reason: "disconnected" });
        }
      }),
    );
    yield* changed(id);
  });

  const disconnect = (id: McpConnectionId) =>
    signOut(id, "disconnected").pipe(Effect.andThen(state(id)));

  const forget = (id: McpConnectionId) => signOut(id, "forget");

  const subscribe = (id: McpConnectionId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so a change during the first read is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(state(id)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changedId) => changedId === id),
            Stream.mapEffect(() => state(id)),
          ),
        );
      }),
    );

  const signOutAs = (id: McpConnectionId, reason: McpConnectionOAuthSignedOutReason) =>
    writeGrant(id, { state: "signed-out", reason }).pipe(
      Effect.andThen(Effect.sync(() => stale.delete(id))),
      Effect.andThen(changed(id)),
    );

  const usableToken = Effect.fn("McpConnectionOAuth.usableToken")(function* (id: McpConnectionId) {
    const grant = yield* readGrant(id);
    if (grant?.state !== "connected") return Option.none<string>();
    const now = yield* Clock.currentTimeMillis;
    const isStale = stale.has(id);
    const expired = grant.expiresAt !== undefined && now >= grant.expiresAt;
    const halfLife =
      grant.expiresAt !== undefined &&
      now >= grant.obtainedAt + (grant.expiresAt - grant.obtainedAt) / 2;
    if (!isStale && !halfLife) return Option.some(grant.accessToken);
    if (grant.refreshToken === undefined) {
      if (!isStale && !expired) return Option.some(grant.accessToken);
      // Given back now: once signed out, nothing holds the token to revoke it later.
      yield* revoke(id, grant);
      yield* signOutAs(id, "expired");
      return Option.none<string>();
    }
    const result = yield* tokenRequest(id, grant.tokenEndpoint, grantClient(grant), {
      grant_type: "refresh_token",
      refresh_token: grant.refreshToken,
      resource: grant.resource,
    }).pipe(Effect.option);
    if (Option.isSome(result) && result.value._tag === "tokens") {
      const tokens = result.value.tokens;
      const refreshedAt = yield* Clock.currentTimeMillis;
      const { expiresAt: _previousExpiry, ...rest } = grant;
      // Stored before the token is used: a rotated refresh token is the only one that works now.
      yield* writeGrant(id, {
        ...rest,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? grant.refreshToken,
        obtainedAt: refreshedAt,
        ...(tokens.expires_in === undefined
          ? {}
          : { expiresAt: refreshedAt + tokens.expires_in * 1000 }),
      });
      stale.delete(id);
      return Option.some(tokens.access_token);
    }
    if (
      Option.isSome(result) &&
      result.value._tag === "refused" &&
      result.value.error === "invalid_grant"
    ) {
      yield* signOutAs(id, expired ? "expired" : "revoked");
      return Option.none<string>();
    }
    // The service or the network failed: a token that may still work is better than none.
    return isStale || expired ? Option.none<string>() : Option.some(grant.accessToken);
  });

  const accessToken = (id: McpConnectionId) =>
    locked(id)(usableToken(id)).pipe(
      Effect.map(Option.map(Redacted.make)),
      Effect.catch((error) =>
        Effect.logWarning("Could not read an MCP connection's OAuth token.", {
          connectionId: id,
          reason: error.reason,
        }).pipe(Effect.as(Option.none<Redacted.Redacted<string>>())),
      ),
    );

  const markStale = Effect.fn("McpConnectionOAuth.markStale")(function* (
    id: McpConnectionId,
    source: "startup" | "call",
  ) {
    const count = (stale.get(id) ?? 0) + 1;
    stale.set(id, count);
    yield* Effect.logInfo("An MCP connection's OAuth token was refused; refreshing at next load.", {
      connectionId: id,
      source,
      count,
    });
  });

  return McpConnectionOAuth.of({
    start,
    complete,
    completeCallback,
    cancel,
    disconnect,
    forget,
    state,
    subscribe,
    accessToken,
    markStale,
  });
});

export const layer = Layer.effect(McpConnectionOAuth, make);
