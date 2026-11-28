// @effect-diagnostics nodeBuiltinImport:off
/** The clients' WebSocket RPCs on a running dev server, for evals that set up what Settings does. */
import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  type AuthEnvironmentScopes,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import * as EnvironmentAuth from "../../apps/server/src/auth/EnvironmentAuth.ts";
import { resolveCliAuthConfig } from "../../apps/server/src/cli/config.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { readPersistedServerRuntimeState } from "../../apps/server/src/serverRuntimeState.ts";
import { SampleError } from "./devServerTools.ts";

export type WsClient = RpcClient.FromGroup<typeof WsRpcGroup, RpcClientError.RpcClientError>;

/** Catalog and grant writes have no MCP tool, so the eval uses the clients' RPCs, as Settings does. */
export const withRpc = Effect.fn("evals.withRpc")(function* <A, E, R>(
  baseDir: string,
  body: (rpc: WsClient) => Effect.Effect<A, E, R>,
  scopes: AuthEnvironmentScopes = [AuthOrchestrationReadScope, AuthSettingsWriteScope],
) {
  const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none(), {
    quietLogs: true,
  });
  return yield* Effect.gen(function* () {
    const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(state)) {
      return yield* Effect.die(new Error(`No running T3 Code server uses ${baseDir}.`));
    }
    const origin = state.value.origin;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* Effect.acquireRelease(
      auth.issueSession({
        label: "eval",
        scopes,
      }),
      (session) => auth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const { ticket } = yield* HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      .execute(
        HttpClientRequest.post(new URL("/api/auth/websocket-ticket", origin).href).pipe(
          HttpClientRequest.bearerToken(issued.token),
          HttpClientRequest.setHeader(
            ORCHESTRATION_PROTOCOL_HEADER,
            String(ORCHESTRATION_PROTOCOL_VERSION),
          ),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ ticket: Schema.String }))),
        Effect.mapError((cause) => new SampleError({ message: `websocket ticket: ${cause}` })),
      );
    const socket = new URL("/ws", origin.replace(/^http/, "ws"));
    socket.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
    socket.searchParams.set("wsTicket", ticket);
    // Built into this scope: `Effect.provide` would close the socket once `make` returns.
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(socket.href)),
        Layer.provide(RpcSerialization.layerJson),
        Layer.provide(NodeWS.layerWebSocketConstructor),
      ),
    );
    const rpc = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
    return yield* body(rpc);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        FetchHttpClient.layer,
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    ),
  );
});
