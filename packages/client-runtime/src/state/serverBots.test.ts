import { describe, expect, it } from "@effect/vitest";
import {
  BotId,
  type BotListResult,
  type BotTaskListInput,
  type BotTaskResult,
  type BotTaskResultInput,
  type BotContinuationScope,
  RunId,
  EnvironmentId,
  ThreadId,
  BotTaskId,
  ProjectId,
  ProviderInstanceId,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

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
  environment: {
    capabilities: { bots: true, botTaskResults: true, botContinuation: true, botMaintenance: true },
  },
  providers: [],
} as unknown as ServerConfig;

const THREAD = "bot-work:same-id";

const makeHarness = Effect.gen(function* () {
  const environments = yield* Effect.forEach(["first", "second", "unsupported", "legacy"], (name) =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make(name);
      const config: ServerConfig =
        name === "unsupported" || name === "legacy"
          ? {
              ...CONFIG,
              environment: {
                ...CONFIG.environment,
                capabilities: (() => {
                  const {
                    botTaskResults: _resultSupport,
                    botContinuation: _noteSupport,
                    botMaintenance: _maintenanceSupport,
                    ...capabilities
                  } = CONFIG.environment.capabilities;
                  return { ...capabilities, bots: name !== "unsupported" };
                })(),
              },
            }
          : CONFIG;
      const resultReads = yield* Ref.make<ReadonlyArray<BotTaskResultInput>>([]);
      const failResults = yield* Ref.make(false);
      const taskGate = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
      const failTasks = yield* Ref.make(false);
      const continuationReads = yield* Ref.make<ReadonlyArray<string>>([]);
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
        [WS_METHODS.botsGetContinuation]: (input: BotContinuationScope) =>
          Ref.update(continuationReads, (all) => [
            ...all,
            `get:${input.botId}:${input.projectId}`,
          ]).pipe(
            Effect.andThen(SubscriptionRef.get(bots)),
            Effect.map((state) => ({
              ...input,
              homeThreadId: ThreadId.make(`home-${environmentId}`),
              revision: null,
              note: { requests: [], waiting: [], decided: [], context: [] },
              updatedBy: null,
              updatedAt: null,
              restoredFrom: null,
              coverage: null,
              basis: null,
              writable: state.bots.some(
                (bot) =>
                  bot.id === input.botId &&
                  bot.archivedAt === null &&
                  bot.projects.some(
                    (project) =>
                      project.projectId === input.projectId && project.detachedAt === null,
                  ),
              ),
              newerInputs: { count: 0, firstOrdinal: null, lastOrdinal: null },
              sources: [],
              moreSources: 0,
              activeTasks: [],
              moreActiveTasks: 0,
            })),
          ),
        [WS_METHODS.botsListContinuationRevisions]: (input: BotContinuationScope) =>
          Ref.update(continuationReads, (all) => [
            ...all,
            `history:${input.botId}:${input.projectId}`,
          ]).pipe(Effect.as({ revisions: [] })),
        [WS_METHODS.botsGetMaintenance]: (input: BotContinuationScope) =>
          Ref.update(continuationReads, (all) => [
            ...all,
            `maintenance:${input.botId}:${input.projectId}`,
          ]).pipe(
            Effect.as({
              ...input,
              homeThreadId: ThreadId.make(`home-${environmentId}`),
              revision: 0,
              enabled: false,
              startedAt: null,
              unavailableReason: "no_tool_profile_unavailable",
              writable: true,
            }),
          ),
        [WS_METHODS.botsGetTaskResult]: (input: BotTaskResultInput) =>
          Effect.gen(function* () {
            yield* Ref.update(resultReads, (all) => [...all, input]);
            if (yield* Ref.get(failResults))
              return yield* Effect.fail({ _tag: "ResultUnavailable" as const });
            return {
              task: { id: input.taskId },
              result: { state: "available", runId: RunId.make("saved-run"), text: name },
            } as BotTaskResult;
          }),
        [WS_METHODS.botsSubscribe]: () => {
          if (name === "unsupported") throw new Error("Unsupported Bot lookup");
          return SubscriptionRef.changes(bots);
        },
        [WS_METHODS.botsSubscribeTasks]: (input: BotTaskListInput) => {
          if (input.workThreadId === undefined) throw new Error("Unfiltered work-thread lookup");
          const tasks = Stream.succeed({
            tasks:
              input.workThreadId === THREAD
                ? [
                    {
                      id: BotTaskId.make("same-task-id"),
                      botId: BotId.make("same-bot-id"),
                      projectId: ProjectId.make("project"),
                      homeThreadId: ThreadId.make("home"),
                      workThreadId: ThreadId.make(THREAD),
                      // "legacy" stands for an older server that omits `changes`.
                      ...(name === "first"
                        ? { origin: "routine", changes: "none" }
                        : name === "legacy"
                          ? { origin: "direct" }
                          : { origin: "direct", changes: null }),
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
          return Stream.unwrap(
            Ref.get(taskGate).pipe(
              Effect.flatMap((gate) => (gate === undefined ? Effect.void : Deferred.await(gate))),
              Effect.andThen(Ref.get(failTasks)),
              Effect.map((fail) => (fail ? Stream.fail("synthetic-task-failure") : tasks)),
            ),
          );
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
      return {
        environmentId,
        bots,
        supervisor,
        config,
        resultReads,
        failResults,
        taskGate,
        failTasks,
        continuationReads,
      };
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

  it.effect("keeps a work thread's task changes unknown until its task loads", () =>
    Effect.gen(function* () {
      const { atoms, registry, environments } = yield* makeHarness;
      const expected = { first: "none", second: "unknown", legacy: null } as const;
      for (const { environmentId, taskGate, failTasks } of environments.filter(
        (entry) => entry.environmentId !== "unsupported",
      )) {
        const gate = yield* Deferred.make<void>();
        yield* Ref.set(taskGate, gate);
        yield* Ref.set(failTasks, environmentId === "second");
        const atom = atoms.workThreadChanges({ environmentId, id: THREAD });
        yield* Effect.acquireRelease(
          Effect.sync(() => registry.mount(atom)),
          (unmount) => Effect.sync(unmount),
        );
        expect(registry.get(atom)).toBe("unknown");
        yield* Deferred.succeed(gate, undefined);
        const tasks = atoms.botTasksLive({
          environmentId,
          input: { workThreadId: ThreadId.make(THREAD) },
        });
        yield* AtomRegistry.toStream(registry, tasks).pipe(
          Stream.filter((result) => !AsyncResult.isInitial(result)),
          Stream.runHead,
        );
        expect(registry.get(atom)).toBe(expected[environmentId as keyof typeof expected]);
      }
      expect(
        registry.get(
          atoms.workThreadChanges({ environmentId: EnvironmentId.make("unsupported"), id: THREAD }),
        ),
      ).toBeNull();
      expect(
        registry.get(
          atoms.workThreadChanges({ environmentId: EnvironmentId.make("first"), id: "ordinary" }),
        ),
      ).toBeNull();
    }).pipe(Effect.scoped),
  );
});

describe("saved Bot task results", () => {
  it.effect("reads lazily in the destination environment and skips older servers", () =>
    Effect.gen(function* () {
      const { atoms, registry, environments } = yield* makeHarness;
      const input = { taskId: BotTaskId.make("same-task-id") };
      for (const environment of environments) {
        const { environmentId, supervisor, resultReads, failResults } = environment;
        const atom = atoms.botTaskResult({ environmentId, input });
        expect(yield* Ref.get(resultReads)).toEqual([]);
        const supported = environmentId === "first" || environmentId === "second";
        if (supported) {
          yield* Ref.set(failResults, true);
          yield* SubscriptionRef.set(supervisor.state, {
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected" as const,
          });
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => registry.mount(atom)),
          (unmount) => Effect.sync(unmount),
        );
        if (supported) {
          yield* AtomRegistry.toStream(registry, atom).pipe(
            Stream.filter((result) => AsyncResult.isFailure(result) && !result.waiting),
            Stream.runHead,
          );
          yield* Ref.set(failResults, false);
          registry.refresh(atom);
          const refreshed = registry.get(atom);
          expect(AsyncResult.isFailure(refreshed) && !refreshed.waiting).toBe(false);
        }
        const answer = yield* AtomRegistry.toStream(registry, atom).pipe(
          Stream.filter(AsyncResult.isSuccess),
          Stream.runHead,
        );
        const result = Option.getOrThrow(answer).value;
        if (!supported) {
          expect(result).toBeNull();
          expect(yield* Ref.get(resultReads)).toEqual([]);
        } else {
          expect(result?.result).toEqual({
            state: "available",
            runId: "saved-run",
            text: environmentId,
          });
          expect(yield* Ref.get(resultReads)).toEqual([input, input]);
        }
      }
    }).pipe(Effect.scoped),
  );
});

it.effect("loads continuation details in the destination and never calls old-server APIs", () =>
  Effect.gen(function* () {
    const { atoms, registry, environments } = yield* makeHarness;
    const input = { botId: BotId.make("same-bot"), projectId: ProjectId.make("same-project") };
    for (const { environmentId, supervisor, continuationReads } of environments) {
      yield* SubscriptionRef.set(supervisor.state, {
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected" as const,
      });
      if (environmentId === "first" || environmentId === "second") {
        yield* AtomRegistry.toStream(registry, atoms.botsLive({ environmentId, input: {} })).pipe(
          Stream.filter(AsyncResult.isSuccess),
          Stream.runHead,
        );
      }
      const target = { environmentId, input };
      for (const atom of [
        Atom.map(atoms.botContinuation(target), (result) =>
          AsyncResult.map(result, (value) => value !== null),
        ),
        Atom.map(atoms.botContinuationHistory(target), (result) =>
          AsyncResult.map(result, (value) => value !== null),
        ),
        Atom.map(atoms.botMaintenance(target), (result) =>
          AsyncResult.map(result, (value) => value !== null),
        ),
      ]) {
        yield* Effect.acquireRelease(
          Effect.sync(() => registry.mount(atom)),
          (unmount) => Effect.sync(unmount),
        );
        const result = Option.getOrThrow(
          yield* AtomRegistry.toStream(registry, atom).pipe(
            Stream.filter(AsyncResult.isSuccess),
            Stream.runHead,
          ),
        ).value;
        expect(result).toBe(environmentId === "first" || environmentId === "second");
      }
      expect(yield* Ref.get(continuationReads)).toEqual(
        environmentId === "first" || environmentId === "second"
          ? [
              "get:same-bot:same-project",
              "history:same-bot:same-project",
              "maintenance:same-bot:same-project",
            ]
          : [],
      );
    }
  }).pipe(Effect.scoped),
);

it.effect(
  "updates a mounted continuation's write availability through detach, reattach and archive",
  () =>
    Effect.gen(function* () {
      const { atoms, registry, environments } = yield* makeHarness;
      const { environmentId, supervisor, bots, continuationReads } = environments[0]!;
      const project = {
        projectId: ProjectId.make("project"),
        homeThreadId: ThreadId.make("home"),
        attachedAt: "2026-01-01T00:00:00.000Z",
        detachedAt: null,
      };
      yield* SubscriptionRef.update(bots, (current) => ({
        bots: current.bots.map((bot) => ({ ...bot, projects: [project] })),
      }));
      yield* SubscriptionRef.set(supervisor.state, {
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected" as const,
      });
      const live = atoms.botsLive({ environmentId, input: {} });
      const note = atoms.botContinuation({
        environmentId,
        input: { botId: BotId.make("same-bot-id"), projectId: project.projectId },
      });
      for (const atom of [
        Atom.map(live, AsyncResult.isSuccess),
        Atom.map(note, AsyncResult.isSuccess),
      ]) {
        yield* Effect.acquireRelease(
          Effect.sync(() => registry.mount(atom)),
          (unmount) => Effect.sync(unmount),
        );
        yield* AtomRegistry.toStream(registry, atom).pipe(
          Stream.filter((ready) => ready),
          Stream.runHead,
        );
      }
      for (const state of ["detached", "attached", "archived", "restored"] as const) {
        const writable = state === "attached" || state === "restored";
        const updated = yield* SubscriptionRef.updateAndGet(bots, (current) => ({
          bots: current.bots.map((bot) => ({
            ...bot,
            archivedAt: state === "archived" ? "2026-01-02T00:00:00.000Z" : null,
            projects: [
              { ...project, detachedAt: state === "detached" ? "2026-01-02T00:00:00.000Z" : null },
            ],
          })),
        }));
        yield* AtomRegistry.toStream(registry, live).pipe(
          Stream.filter(
            (result) =>
              AsyncResult.isSuccess(result) &&
              result.value.bots[0]?.archivedAt === updated.bots[0]?.archivedAt &&
              result.value.bots[0]?.projects[0]?.detachedAt ===
                updated.bots[0]?.projects[0]?.detachedAt,
          ),
          Stream.runHead,
        );
        if (!writable) {
          const cached = AsyncResult.getOrElse(registry.get(note), () => null);
          expect(cached?.writable).toBe(false);
        }
        yield* AtomRegistry.toStream(registry, note).pipe(
          Stream.filter(
            (result) =>
              AsyncResult.isSuccess(result) &&
              !result.waiting &&
              result.value?.writable === writable,
          ),
          Stream.runHead,
        );
      }
      yield* SubscriptionRef.update(bots, (current) => ({
        bots: current.bots.map((bot) => ({ ...bot, name: "Renamed without changing attachment" })),
      }));
      yield* AtomRegistry.toStream(registry, live).pipe(
        Stream.filter(
          (result) =>
            AsyncResult.isSuccess(result) &&
            result.value.bots[0]?.name === "Renamed without changing attachment",
        ),
        Stream.runHead,
      );
      expect(
        (yield* Ref.get(continuationReads)).filter((read) => read.startsWith("get:")),
      ).toHaveLength(5);
      expect(yield* Ref.get(environments[1]!.continuationReads)).toEqual([]);
    }).pipe(Effect.scoped),
);
