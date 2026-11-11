import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotError,
  McpConnectionId,
  type McpConnectionOAuth,
  type McpConnectionTransport,
  SecretProviderId,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BotService from "../bots/BotService.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpConnectionDelivery from "./McpConnectionDelivery.ts";
import * as McpConnections from "./McpConnections.ts";

const decodeServerSettingsPatch = Schema.decodeUnknownEffect(ServerSettingsPatch);

const layerSettings = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provide(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provide(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-mcp-connections-test-" })),
  ),
);

// The secret provider is the external dependency: it records every read it is asked for.
const harness = Effect.gen(function* () {
  const secrets = new Map<string, string>();
  const reads: string[] = [];
  const invalidated: string[] = [];
  // A read of a held reference waits on its effect before answering.
  const holds = new Map<string, Effect.Effect<void>>();
  const resolver = SecretResolver.SecretResolver.of({
    read: (references) =>
      Effect.forEach(references, ({ reference }) =>
        (holds.get(reference) ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              reads.push(reference);
              return secrets.get(reference);
            }),
          ),
        ),
      ),
    invalidate: (references) =>
      Effect.sync(() => {
        for (const { reference } of references ?? []) invalidated.push(reference);
      }),
    label: (provider) => Effect.succeed(provider),
  });
  // Grants live in the Bot database; the catalog only asks it to forget a removed connection.
  const grantCleanup = { forgotten: [] as string[], failNext: false };
  const bots = Layer.mock(BotService.BotService)({
    forgetMcpConnection: (connectionId) =>
      Effect.suspend(() => {
        if (!grantCleanup.failNext)
          return Effect.sync(() => grantCleanup.forgotten.push(connectionId));
        grantCleanup.failNext = false;
        return Effect.fail(new BotError({ message: "injected Bot database failure" }));
      }),
  });
  const connections = yield* McpConnections.McpConnections.pipe(
    Effect.provide(
      McpConnections.layer.pipe(
        Layer.provide(Layer.succeed(SecretResolver.SecretResolver, resolver)),
        Layer.provide(bots),
      ),
    ),
  );
  const delivery = yield* McpConnectionDelivery.McpConnectionDelivery.pipe(
    Effect.provide(
      McpConnectionDelivery.layer.pipe(
        Layer.provide(Layer.succeed(SecretResolver.SecretResolver, resolver)),
      ),
    ),
  );
  return { connections, delivery, secrets, reads, invalidated, holds, grantCleanup };
});

const accountA = McpConnectionId.make("1a1a1a1a-0000-4000-8000-00000000001a");
const accountB = McpConnectionId.make("1b1b1b1b-0000-4000-8000-00000000001b");
const local = McpConnectionId.make("1c1c1c1c-0000-4000-8000-00000000001c");
const oauthMail = McpConnectionId.make("2a2a2a2a-0000-4000-8000-00000000002a");
const personal = SecretProviderId.make("personal");
const tokenB = { provider: personal, reference: "op://Private/Docs/token-b" };
const http = (authorization: string | typeof tokenB): McpConnectionTransport => ({
  type: "http",
  url: "https://mcp.example.test/mcp",
  httpHeaders: { Authorization: authorization },
});
const SENTINEL = "sk-sentinel-never-echoed";
const oauthHttp = (
  oauth: McpConnectionOAuth = { scopes: ["mail.read"] },
): McpConnectionTransport & { readonly type: "http" } => ({
  type: "http",
  url: "https://mail.example.test/mcp",
  httpHeaders: { "X-Tenant": "home" },
  oauth,
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("MCP connections", (it) => {
  it.effect(
    "keeps same-URL accounts distinct and saves only valid edits of the current revision",
    () =>
      Effect.gen(function* () {
        const { connections, reads, grantCleanup } = yield* harness;
        const created = yield* connections.create({
          connectionId: accountA,
          label: "Work",
          enabled: true,
          transport: http("Bearer account-a"),
        });
        assert.deepEqual(created, {
          id: accountA,
          label: "Work",
          enabled: true,
          revision: 1,
          transport: "http",
          status: { state: "ready" },
        });
        yield* connections.create({
          connectionId: accountB,
          label: "Personal",
          enabled: true,
          transport: http(tokenB),
        });
        yield* connections.create({
          connectionId: local,
          label: "Local",
          enabled: false,
          transport: {
            type: "stdio",
            command: "mcp-server",
            args: ["--token-file", "/home/user/.token"],
            env: { API_KEY: "upper", api_key: "lower" },
          },
        });
        // Listing never asks a secret provider; an unread reference is reported as unchecked.
        assert.deepEqual(
          (yield* connections.list).connections.map(({ id, status }) => [id, status.state]),
          [
            [accountA, "ready"],
            [accountB, "unchecked"],
            [local, "ready"],
          ],
        );
        assert.deepEqual(reads, []);

        // A retried create is the same definition; a different one under that id is refused.
        assert.deepEqual(
          yield* connections.create({
            connectionId: accountA,
            label: "Work",
            enabled: true,
            transport: http("Bearer account-a"),
          }),
          created,
        );
        assert.equal((yield* connections.list).connections.length, 3);
        assert.equal(
          (yield* connections
            .create({ connectionId: accountB, label: "Other", enabled: true, transport: http("x") })
            .pipe(Effect.flip)).reason,
          "id-unavailable",
        );
        assert.equal(
          (yield* connections
            .create({
              connectionId: accountA,
              label: "Work",
              enabled: true,
              transport: http(`Bearer ${SENTINEL}`),
            })
            .pipe(Effect.flip)).reason,
          "id-unavailable",
        );

        // Two edits of revision 1: exactly one saves, the other sees the conflict.
        const [first, second] = yield* Effect.all(
          [
            connections.update({ connectionId: accountA, expectedRevision: 1, label: "One" }),
            connections.update({ connectionId: accountA, expectedRevision: 1, label: "Two" }),
          ],
          { concurrency: "unbounded", mode: "result" },
        );
        const outcomes = [first, second].map((result) =>
          result._tag === "Success"
            ? "saved"
            : `${result.failure.reason}:${result.failure.currentRevision}`,
        );
        assert.sameMembers(outcomes, ["saved", "revision-conflict:2"]);

        for (const [bindings, reason] of [
          [{ Authorization: "a", authorization: "b" }, "binding-name-duplicate"],
          [{ "X-Token": "a\r\nInjected: b" }, "binding-value-invalid"],
          [{ "Bad Header": "x" }, "binding-name-invalid"],
          [{ Authorization: "" }, "binding-value-empty"],
        ] as const) {
          const error = yield* connections
            .update({ connectionId: accountA, expectedRevision: 2, bindings })
            .pipe(Effect.flip);
          assert.equal(error.problem?.reason, reason);
        }
        for (const [transport, reason] of [
          [
            { type: "http", url: `https://user:${SENTINEL}@mcp.example.test`, httpHeaders: {} },
            "url-credentials",
          ],
          [
            {
              type: "http",
              url: `https://mcp.example.test/mcp?api_key=${SENTINEL}`,
              httpHeaders: {},
            },
            "url-credentials",
          ],
          [
            { type: "stdio", command: "mcp-server", args: [`--api-key=${SENTINEL}`], env: {} },
            "argument-secret",
          ],
          [
            { type: "stdio", command: "mcp-server", args: ["--token", SENTINEL], env: {} },
            "argument-secret",
          ],
          [
            {
              type: "stdio",
              command: "mcp-server",
              args: ["--endpoint", `https://mcp.example.test/mcp?api_key=${SENTINEL}`],
              env: {},
            },
            "argument-secret",
          ],
          [
            {
              type: "stdio",
              command: "mcp-server",
              args: [`--endpoint=https://mcp.example.test/mcp?api_key=${SENTINEL}`],
              env: {},
            },
            "argument-secret",
          ],
          [
            { type: "stdio", command: "mcp-server", args: [], env: { "BAD-NAME": "x" } },
            "binding-name-invalid",
          ],
          [
            { ...oauthHttp(), httpHeaders: { authorization: SENTINEL } },
            "oauth-authorization-binding",
          ],
          [oauthHttp({ scopes: ["mail.read", "two words"] }), "oauth-scope-invalid"],
          [oauthHttp({ scopes: [], client: { id: "" } }), "oauth-client-invalid"],
          [
            oauthHttp({ scopes: [], client: { id: "app", secret: `${SENTINEL}\nx` } }),
            "oauth-client-invalid",
          ],
        ] as const) {
          const error = yield* connections
            .create({
              connectionId: McpConnectionId.make("1d1d1d1d-0000-4000-8000-00000000001d"),
              label: "Refused",
              enabled: true,
              transport,
            })
            .pipe(Effect.flip);
          assert.equal(error.problem?.reason, reason);
          assert.notInclude(`${error.message}${JSON.stringify(error)}`, SENTINEL);
        }
        assert.equal(
          (yield* connections.list).connections.find(({ id }) => id === accountA)?.revision,
          2,
        );

        // Removal is revision-checked, idempotent on retry, and retires the id for good.
        assert.equal(
          (yield* connections
            .remove({ connectionId: accountA, expectedRevision: 1 })
            .pipe(Effect.flip)).reason,
          "revision-conflict",
        );
        // A lost grant cleanup fails the removal after retiring the id; the retry repeats it.
        grantCleanup.failNext = true;
        assert.equal(
          (yield* connections
            .remove({ connectionId: accountA, expectedRevision: 2 })
            .pipe(Effect.flip)).reason,
          "settings-unavailable",
        );
        assert.deepEqual(grantCleanup.forgotten, []);
        yield* connections.remove({ connectionId: accountA, expectedRevision: 2 });
        yield* connections.remove({ connectionId: accountA, expectedRevision: 2 });
        assert.deepEqual(grantCleanup.forgotten, [accountA, accountA]);
        assert.equal(
          (yield* connections
            .create({
              connectionId: accountA,
              label: "Work",
              enabled: true,
              transport: http("Bearer account-a"),
            })
            .pipe(Effect.flip)).reason,
          "id-unavailable",
        );

        // The OAuth setup is part of what a retried create must match, and stays fixed after.
        const mail = { connectionId: oauthMail, label: "Mail", enabled: true } as const;
        const oauthCreated = yield* connections.create({ ...mail, transport: oauthHttp() });
        assert.deepEqual(
          yield* connections.create({ ...mail, transport: oauthHttp() }),
          oauthCreated,
        );
        for (const oauth of [
          { scopes: ["mail.send"] },
          { scopes: ["mail.read"], client: { id: "app-id" } },
        ]) {
          assert.equal(
            (yield* connections.create({ ...mail, transport: oauthHttp(oauth) }).pipe(Effect.flip))
              .reason,
            "id-unavailable",
          );
        }
        assert.deepEqual(
          (yield* connections
            .update({
              connectionId: oauthMail,
              expectedRevision: 1,
              bindings: { AUTHORIZATION: SENTINEL },
            })
            .pipe(Effect.flip)).problem,
          { reason: "oauth-authorization-binding", binding: "AUTHORIZATION" },
        );
        yield* connections.update({
          connectionId: oauthMail,
          expectedRevision: 1,
          bindings: { "X-Tenant": "work" },
        });
        const settings = yield* ServerSettings.ServerSettingsService;
        assert.deepEqual((yield* settings.getSettings).mcpConnections[oauthMail]?.transport, {
          ...oauthHttp(),
          httpHeaders: { "X-Tenant": "work" },
        });
      }).pipe(Effect.provide(layerSettings)),
  );

  it.effect(
    "delivers granted connections with credentials read now, and nothing to fall back on",
    () =>
      Effect.gen(function* () {
        const { connections, delivery, secrets, reads } = yield* harness;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* decodeServerSettingsPatch({
          secretProviders: {
            personal: { kind: "one_password", label: "Personal", config: { account: "my" } },
          },
        }).pipe(Effect.flatMap(settings.updateSettings));
        yield* connections.create({
          connectionId: accountA,
          label: "Work mail",
          enabled: true,
          transport: http("Bearer account-a"),
        });
        yield* connections.create({
          connectionId: accountB,
          label: "Private mail",
          enabled: true,
          transport: {
            type: "stdio",
            command: "mail-mcp",
            args: ["--stdio"],
            env: { TOKEN: tokenB },
          },
        });
        const retired = McpConnectionId.make("1e1e1e1e-0000-4000-8000-00000000001e");
        yield* connections.create({
          connectionId: retired,
          label: "Old",
          enabled: true,
          transport: http("Bearer old"),
        });
        yield* connections.remove({ connectionId: retired, expectedRevision: 1 });
        yield* connections.create({
          connectionId: local,
          label: "Off",
          enabled: false,
          transport: {
            type: "stdio",
            command: "off-mcp",
            args: [],
            env: { TOKEN: { provider: personal, reference: "op://Private/Off/token" } },
          },
        });

        // An unreadable secret fails the whole load, naming the connection and binding only.
        const unreadable = yield* delivery.resolve([accountA, accountB]).pipe(Effect.flip);
        assert.deepEqual(
          [unreadable.reason, unreadable.connectionId, unreadable.label, unreadable.problem],
          ["invalid", accountB, "Private mail", { reason: "binding-unresolved", binding: "TOKEN" }],
        );

        secrets.set(tokenB.reference, "token-b-1");
        // Disabled and removed connections are left out; the disabled one's secret is never read.
        const first = yield* delivery.resolve([accountB, retired, local, accountA, accountB]);
        assert.notInclude(reads, "op://Private/Off/token");
        assert.deepEqual(
          first.connections.map(({ id, label, transport }) =>
            transport.type === "stdio"
              ? [id, label, transport.command, transport.args, Redacted.value(transport.env)]
              : [id, label, transport.url, Redacted.value(transport.headers)],
          ),
          [
            [
              accountA,
              "Work mail",
              "https://mcp.example.test/mcp",
              { Authorization: "Bearer account-a" },
            ],
            [accountB, "Private mail", "mail-mcp", ["--stdio"], { TOKEN: "token-b-1" }],
          ],
        );
        assert.notInclude(first.identity, "token-b-1");
        assert.equal((yield* delivery.resolve([accountA, accountB])).identity, first.identity);
        // A rotated secret or a rename changes the identity, so the next load reloads.
        secrets.set(tokenB.reference, "token-b-2");
        const rotated = yield* delivery.resolve([accountA, accountB]);
        assert.notEqual(rotated.identity, first.identity);
        yield* connections.update({
          connectionId: accountA,
          expectedRevision: 1,
          label: "Job mail",
        });
        assert.notEqual((yield* delivery.resolve([accountA, accountB])).identity, rotated.identity);

        const unknown = McpConnectionId.make("1f1f1f1f-0000-4000-8000-00000000001f");
        assert.equal(
          (yield* delivery.resolve([accountA, unknown]).pipe(Effect.flip)).reason,
          "missing",
        );
      }).pipe(Effect.provide(layerSettings)),
  );

  it.effect("re-reads bindings only on refresh and refuses unreadable or removed ones", () =>
    Effect.gen(function* () {
      const { connections, secrets, reads, invalidated } = yield* harness;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* decodeServerSettingsPatch({
        secretProviders: {
          personal: { kind: "one_password", label: "Personal", config: { account: "my" } },
        },
      }).pipe(Effect.flatMap(settings.updateSettings));
      yield* connections.create({
        connectionId: accountB,
        label: "Personal",
        enabled: true,
        transport: http(tokenB),
      });

      const refreshed = yield* connections.refresh({ connectionIds: [accountB] });
      assert.deepEqual(refreshed.connections[0]?.status, {
        state: "blocked",
        problem: { reason: "binding-unresolved", binding: "Authorization" },
      });
      assert.deepEqual(invalidated, [tokenB.reference]);

      // Unlocking alone changes nothing until the user refreshes; the failure is not retried.
      secrets.set(tokenB.reference, "Bearer account-b");
      const readsBeforeList = reads.length;
      assert.equal((yield* connections.list).connections[0]?.status.state, "blocked");
      assert.equal(reads.length, readsBeforeList);
      assert.deepEqual(
        (yield* connections.refresh({ connectionIds: [accountB] })).connections[0]?.status,
        {
          state: "ready",
        },
      );

      secrets.set(tokenB.reference, "Bearer account-b\r\nX-Injected: 1");
      assert.deepEqual(
        (yield* connections.refresh({ connectionIds: [accountB] })).connections[0]?.status,
        {
          state: "blocked",
          problem: { reason: "binding-value-invalid", binding: "Authorization" },
        },
      );

      // Removing the secret provider unsets the binding as a new revision that is refused.
      yield* settings.updateSettings({ secretProviders: { [personal]: null } });
      const [removed] = (yield* connections.list).connections;
      assert.deepEqual(removed, {
        id: accountB,
        label: "Personal",
        enabled: true,
        revision: 2,
        transport: "http",
        status: {
          state: "blocked",
          problem: { reason: "binding-value-empty", binding: "Authorization" },
        },
      });
      assert.equal(
        (yield* connections
          .update({ connectionId: accountB, expectedRevision: 1, enabled: false })
          .pipe(Effect.flip)).reason,
        "revision-conflict",
      );
      // Disabling a connection whose binding is broken stays possible.
      assert.equal(
        (yield* connections.update({ connectionId: accountB, expectedRevision: 2, enabled: false }))
          .enabled,
        false,
      );
    }).pipe(Effect.provide(layerSettings)),
  );

  it.effect("keeps a newer revision's check when an older refresh finishes late", () =>
    Effect.gen(function* () {
      const { connections, secrets, holds } = yield* harness;
      const rotated = { ...tokenB, reference: "op://Private/Docs/token-b-rotated" };
      secrets.set(tokenB.reference, "Bearer account-b");
      secrets.set(rotated.reference, "Bearer account-b-rotated");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      holds.set(
        tokenB.reference,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      yield* connections.create({
        connectionId: accountB,
        label: "Personal",
        enabled: true,
        transport: http(tokenB),
      });

      const oldRefresh = yield* connections
        .refresh({ connectionIds: [accountB] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* connections.update({
        connectionId: accountB,
        expectedRevision: 1,
        bindings: { Authorization: rotated },
      });
      const fresh = (yield* connections.refresh({ connectionIds: [accountB] })).connections[0];
      assert.equal(fresh?.revision, 2);
      assert.equal(fresh?.status.state, "ready");

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(oldRefresh);
      const current = (yield* connections.list).connections[0];
      assert.equal(current?.revision, 2);
      assert.equal(current?.status.state, "ready");
    }).pipe(Effect.provide(layerSettings)),
  );
});
