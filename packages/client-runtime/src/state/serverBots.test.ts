import { describe, expect, it } from "@effect/vitest";
import {
  BotId,
  type BotListResult,
  type BotTaskListInput,
  EnvironmentId,
  ThreadId,
  BotTaskId,
  ProjectId,
  ProviderInstanceId,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const CONFIG = {
  environment: { capabilities: { bots: true } },
  providers: [],
} as unknown as ServerConfig;

const THREAD = "bot-work:same-id";

const makeHarness = Effect.gen(function* () {
  const environments = yield* Effect.forEach(["first", "second", "unsupported"], (name) =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make(name);
      const config =
        name === "unsupported"
          ? {
              ...CONFIG,
              environment: {
                ...CONFIG.environment,
                capabilities: { ...CONFIG.environment.capabilities, bots: false },
              },
            }
          : CONFIG;
      const bots = yield* SubscriptionRef.make<BotListResult>({
        bots: [
          {
            id: BotId.make("same-bot-id"),
            name,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            learningPolicy: "after_adoption",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            archivedAt: null,
            pendingLearning: 0,
            projects: [],
          },
        ],
      });
      const client = {
        [WS_METHODS.botsSubscribe]: () => {
          if (name === "unsupported") throw new Error("Unsupported Bot lookup");
          return SubscriptionRef.changes(bots);
        },
        [WS_METHODS.botsSubscribeTasks]: (input: BotTaskListInput) => {
          if (input.workThreadId === undefined) throw new Error("Unfiltered work-thread lookup");
          return Stream.succeed({
            tasks:
              input.workThreadId === THREAD
                ? [
                    {
                      id: BotTaskId.make("same-task-id"),
                      botId: BotId.make("same-bot-id"),
                      projectId: ProjectId.make("project"),
                      homeThreadId: ThreadId.make("home"),
                      workThreadId: ThreadId.make(THREAD),
                      origin: "direct",
                      title: "Prepare",
                      scheduledTaskId: null,
                      occurrenceDueAt: null,
                      sessionAt: null,
                      runtimeMode: "full-access",
                      status: "completed",
                      detail: null,
                      createdAt: "2026-01-01T00:00:00.000Z",
                      updatedAt: "2026-01-01T00:00:00.000Z",
                      completedAt: "2026-01-01T00:00:00.000Z",
                    },
                  ]
                : [],
          });
        },
      } as unknown as WsRpcProtocolClient;
      const session: RpcSession = {
        client,
        initialConfig: Effect.succeed(config),
        subscribeServerConfig: () => Stream.never,
        ready: Effect.void,
        probe: Effect.void,
        inboundFrames: Effect.succeed(0),
        closed: Effect.never,
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: name,
          httpBaseUrl: `https://${name}.test`,
          wsBaseUrl: `wss://${name}.test`,
        }),
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      return { environmentId, bots, supervisor, config };
    }),
  );
  const environment = (id: EnvironmentId) => {
    const found = environments.find((entry) => entry.environmentId === id);
    if (found === undefined) throw new Error("Unexpected environment lookup");
    return found;
  };
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
        entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          new Map(),
        ),
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        run: (id, effect) =>
          Effect.provideService(
            effect,
            EnvironmentSupervisor.EnvironmentSupervisor,
            environment(id).supervisor,
          ),
        followStream: (id, stream) =>
          Stream.provideService(
            stream,
            EnvironmentSupervisor.EnvironmentSupervisor,
            environment(id).supervisor,
          ),
      }),
      Layer.mock(Persistence.EnvironmentCacheStore)({
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
      }),
    ),
  );
  const config = Atom.family((id: EnvironmentId) => Atom.make(environment(id).config));
  const atoms = createServerEnvironmentAtoms(runtime, { initialConfigValueAtom: config });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { atoms, registry, environments, config };
});

describe("work-thread Bot identity", () => {
  it.effect("scopes identity to its environment and follows archived or missing Bots", () =>
    Effect.gen(function* () {
      const { atoms, registry, environments } = yield* makeHarness;
      for (const { environmentId, bots } of environments.filter(
        (entry) => entry.environmentId !== "unsupported",
      )) {
        const atom = atoms.workThreadBot({ environmentId, id: THREAD });
        yield* Effect.acquireRelease(
          Effect.sync(() => registry.mount(atom)),
          (unmount) => Effect.sync(unmount),
        );
        const identity = yield* AtomRegistry.toStream(registry, atom).pipe(
          Stream.filter((bot) => bot !== null),
          Stream.runHead,
        );
        expect(Option.getOrThrow(identity)?.name).toBe(environmentId);
        const active = yield* SubscriptionRef.get(bots);
        for (const next of [
          { bots: active.bots.map((bot) => ({ ...bot, archivedAt: "2026-01-02T00:00:00.000Z" })) },
          { bots: [] },
        ]) {
          yield* SubscriptionRef.set(bots, next);
          yield* AtomRegistry.toStream(registry, atom).pipe(
            Stream.filter((bot) => bot === null),
            Stream.runHead,
          );
          yield* SubscriptionRef.set(bots, active);
          yield* AtomRegistry.toStream(registry, atom).pipe(
            Stream.filter((bot) => bot !== null),
            Stream.runHead,
          );
        }
      }
    }).pipe(Effect.scoped),
  );

  it.effect("does not look up Bot data for ordinary threads or unsupported environments", () =>
    Effect.gen(function* () {
      const { atoms, registry } = yield* makeHarness;
      expect(
        registry.get(
          atoms.workThreadBot({ environmentId: EnvironmentId.make("unavailable"), id: "ordinary" }),
        ),
      ).toBeNull();
      expect(
        registry.get(
          atoms.workThreadBot({ environmentId: EnvironmentId.make("unsupported"), id: THREAD }),
        ),
      ).toBeNull();
    }).pipe(Effect.scoped),
  );
});
