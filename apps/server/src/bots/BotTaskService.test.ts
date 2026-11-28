import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BOT_WORK_THREAD_ID_PREFIX,
  type TerminalMetadataStreamEvent,
  type BotError,
  BotId,
  botHomeProjectId,
  BotTaskId,
  type BotTaskSummary,
  BotTaskListInput,
  type BotTaskStatus,
  CommandId,
  McpConnectionId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  RunId,
  MessageId,
  NodeId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Run,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ScheduledTaskUpsertInput,
  ScheduledTaskId,
  ScheduledTaskError,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { makeSubagentConversationArtifacts } from "@t3tools/provider-core/server/subagentProjection";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { OrchestratorCommandPreviouslyRejectedError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotExecutionConstraint from "./BotExecutionConstraint.ts";
import * as BotFailureDiagnosis from "./BotFailureDiagnosis.ts";
import * as BotHomeFolders from "./BotHomeFolders.ts";
import * as BotHomeUpdates from "./BotHomeUpdates.ts";
import * as BotProjectGuard from "./BotProjectGuard.ts";
import * as BotService from "./BotService.ts";
import * as BotTaskAcceptance from "./BotTaskAcceptance.ts";
import * as BotTaskService from "./BotTaskService.ts";
import * as BotTurnContext from "./BotTurnContext.ts";
import * as BotWorktreePool from "./BotWorktreePool.ts";

afterEach(() => vi.unstubAllEnvs());

const campaign = ProjectId.make("project-campaign");
const botId = BotId.make("campaign-companion");
const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const START = Date.parse("2026-11-02T12:00:00.000Z");
const HOUR = 3_600_000;

const catalogModel = (slug: string): ServerProvider["models"][number] => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
      { id: "fastMode", label: "Fast", type: "boolean" },
    ],
  },
});
const catalogProvider = (instanceId: string, driver: string, enabled = true): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled,
  installed: true,
  version: "test",
  status: enabled ? "ready" : "disabled",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-02T00:00:00.000Z",
  models: [catalogModel("gpt-5"), catalogModel("gpt-5.1")],
  slashCommands: [],
  skills: [],
});
const CATALOG = [
  catalogProvider("codex", "codex"),
  catalogProvider("codex-blocked", "codex"),
  catalogProvider("codex-off", "codex", false),
  catalogProvider("claude", "claudeAgent"),
  catalogProvider("cursor", "cursor"),
  { ...catalogProvider("codex-no-catalog", "codex"), models: [] },
  {
    ...catalogProvider("codex-no-options", "codex"),
    models: [{ ...catalogModel("gpt-5"), capabilities: {} }],
  },
  {
    ...catalogProvider("codex-null-capabilities", "codex"),
    models: [{ ...catalogModel("gpt-5"), capabilities: null }],
  },
];

interface FakeThread {
  readonly projectId: ProjectId;
  readonly archived: boolean;
  /** What the thread was launched with. */
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly status: OrchestrationV2ThreadShell["status"];
  readonly blockingRequest: boolean;
  readonly backgroundTasks: number;
  /** Set once the first message admitted a run. */
  readonly runId: string | null;
  /** Its latest run reached the agent, past workspace preparation. */
  readonly started?: boolean;
  /** Where the launch put it: "root", "worktree <branch> from <base>" or "pooled <path> <branch>". */
  readonly workspace: string;
  readonly worktreePath: string | null;
  /** A run queued behind the active one, which then is the latest. */
  readonly queuedRunId?: string;
  readonly lastError?: string;
  readonly branch?: string | null;
}

const describeWorkspace = (
  input: ThreadLaunchService.ThreadLaunchInput,
): Pick<FakeThread, "workspace" | "worktreePath" | "branch"> => {
  const strategy = input.workspaceStrategy;
  switch (strategy.type) {
    case "root":
      return { workspace: "root", worktreePath: null };
    case "worktree":
      return {
        workspace: `worktree ${strategy.branch} from ${strategy.baseRef}`,
        worktreePath: `/worktrees/${strategy.branch}`,
      };
    case "existing_worktree":
      return {
        workspace: `pooled ${strategy.worktreePath} ${strategy.branch}${input.setupScript === "skip" ? " without setup" : ""}`,
        worktreePath: strategy.worktreePath,
        branch: strategy.branch ?? null,
      };
  }
};

/** Stands in for the orchestrator: launches are idempotent per command id, like receipts. */
const makeThreadWorld = Effect.gen(function* () {
  const botSql = yield* BotDatabase.BotDatabase;
  const deliveryLockTransactions = yield* Ref.make<ReadonlyArray<boolean>>([]);
  const records = yield* Ref.make(
    new Map<
      ThreadId,
      Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages" | "turnItems">
    >(),
  );
  const reads = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const threads = yield* Ref.make(new Map<ThreadId, FakeThread>());
  const launchedCommands = yield* Ref.make(new Set<string>());
  const commands = yield* Ref.make<ReadonlyArray<string>>([]);
  const launched = yield* Ref.make<Deferred.Deferred<ThreadId> | null>(null);
  /** When set, a launch records its thread and then never returns, as a crash would leave it. */
  const hangLaunches = yield* Ref.make(false);
  /**
   * When set, a launch signals `entered` and waits for `release`: before it creates the thread,
   * or after creating it and before its first message starts a run.
   */
  const launchGate = yield* Ref.make<{
    readonly stage: "before-thread" | "before-message";
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
    /** Only this thread's launch; absent takes the next launch with a message. */
    readonly threadId?: ThreadId;
  } | null>(null);
  const receipts = yield* Ref.make(new Set<string>());
  const disposeReturn = yield* Ref.make(false);
  /** Command ids the orchestrator refused; their receipt replays the refusal. */
  const rejected = yield* Ref.make(new Set<string>());
  const notificationAttempts = yield* Ref.make<ReadonlyArray<CommandId>>([]);
  /** What the pool answers next; the last one stays. Without any, a new worktree named by branch. */
  const poolClaims = yield* Ref.make<ReadonlyArray<BotWorktreePool.BotWorktreeClaim>>([]);
  const poolTakes = yield* Ref.make<
    ReadonlyArray<Parameters<BotWorktreePool.BotWorktreePool["Service"]["take"]>[0]>
  >([]);
  /** The worktree each work thread holds now. */
  const poolHeld = yield* Ref.make(new Map<ThreadId, string>());
  /** Worktrees the pool keeps for a thread, with why. */
  const poolKept = yield* Ref.make(new Map<ThreadId, string>());
  /** What happens while a release moves the worktree, before the pool asks whether it is in use. */
  const poolMoving = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  /** TerminalManager's metadata listeners; `terminalEvent` feeds them as it would. */
  const terminalListeners: Array<(event: TerminalMetadataStreamEvent) => Effect.Effect<void>> = [];
  const terminalEvent = (event: TerminalMetadataStreamEvent) =>
    Effect.forEach(terminalListeners, (listener) => listener(event), { discard: true });
  /** Worktree paths given back to the pool, in order. */
  const poolParks = yield* Ref.make<ReadonlyArray<string>>([]);
  const poolSavesWork = yield* Ref.make(false);
  /** When set, the next pool claim signals `entered` and waits for `release`. */
  const poolGate = yield* Ref.make<{
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null>(null);
  /** The next command of this type fails before it is recorded. */
  const failNext = yield* Ref.make<OrchestrationV2ServerCommand["type"] | null>(null);
  /** Branches, commits and files a result's evidence check finds. */
  const existingEvidence = yield* Ref.make<ReadonlySet<string>>(new Set(["notes/prep.md"]));
  /** Messages other threads sent, once per command id as receipts keep them. */
  const sends = yield* Ref.make<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>(
    [],
  );

  const update = (threadId: ThreadId, change: Partial<FakeThread>) =>
    Ref.update(threads, (current) => {
      const thread = current.get(threadId);
      return thread === undefined
        ? current
        : new Map(current).set(threadId, { ...thread, ...change });
    });

  const dispatchLocked = Effect.fn("FakeThreads.dispatch")(function* (
    command: OrchestrationV2ServerCommand,
  ) {
    if (command.type === "thread.mark-unread") {
      yield* Ref.update(notificationAttempts, (current) => [...current, command.commandId]);
    }
    if ((yield* Ref.get(failNext)) === command.type) {
      yield* Ref.set(failNext, null);
      return yield* Effect.die(`injected ${command.type} failure`);
    }
    if ((yield* Ref.get(rejected)).has(command.commandId)) {
      return yield* new OrchestratorCommandPreviouslyRejectedError({
        commandId: command.commandId,
        commandType: command.type,
        detail: "refused",
      });
    }
    // A repeated command id replays its receipt and changes nothing.
    if ((yield* Ref.get(receipts)).has(command.commandId)) return { storedEvents: [] } as never;
    yield* Ref.update(receipts, (current) => new Set(current).add(command.commandId));
    const threadId = "threadId" in command ? command.threadId : "";
    yield* Ref.update(commands, (current) => [
      ...current,
      `${command.type} ${threadId} ${command.commandId}`,
    ]);
    if (command.type === "thread.archive") yield* update(command.threadId, { archived: true });
    if (command.type === "thread.unarchive") yield* update(command.threadId, { archived: false });
    if (command.type === "thread.stop") {
      const thread = (yield* Ref.get(threads)).get(command.threadId);
      // Stop ends a run; a thread without one has nothing to stop.
      if (thread !== undefined && thread.status !== "idle") {
        yield* update(command.threadId, { status: "interrupted" });
      }
    }
    if (command.type === "bot-task.result.deliver" && !(yield* Ref.get(disposeReturn))) {
      return { storedEvents: [{ event: { type: "message.updated" } }] } as never;
    }
    return { storedEvents: [] } as never;
  });

  const beforeDeliveryLock = Effect.gen(function* () {
    const transaction = yield* Effect.serviceOption(botSql.transactionService);
    yield* Ref.update(deliveryLockTransactions, (all) => [...all, Option.isSome(transaction)]);
  });
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    (command.type === "bot-task.result.deliver" ? beforeDeliveryLock : Effect.void).pipe(
      Effect.andThen(dispatchLocked(command)),
    );

  const getThreadShell = Effect.fn("FakeThreads.getThreadShell")(function* (threadId: ThreadId) {
    const thread = (yield* Ref.get(threads)).get(threadId);
    if (thread === undefined) return null;
    const shell: Pick<
      OrchestrationV2ThreadShell,
      | "archivedAt"
      | "deletedAt"
      | "modelSelection"
      | "runtimeMode"
      | "status"
      | "pendingRuntimeRequest"
      | "pendingBackgroundTasks"
      | "latestRunId"
      | "latestRunCompletedAt"
      | "activeRunId"
      | "worktreePath"
      | "branch"
      | "latestRunStartedAt"
      | "id"
      | "projectId"
      | "lastError"
    > = {
      id: threadId,
      projectId: thread.projectId,
      archivedAt: thread.archived ? DateTime.makeUnsafe(0) : null,
      deletedAt: null,
      modelSelection: codex,
      runtimeMode: thread.runtimeMode,
      // A shell takes its latest run's status.
      status: thread.queuedRunId === undefined ? thread.status : "queued",
      pendingRuntimeRequest: thread.blockingRequest
        ? { id: "request" as never, kind: "user_input" as never, createdAt: DateTime.makeUnsafe(0) }
        : null,
      pendingBackgroundTasks: Array.from({ length: thread.backgroundTasks }, () => ({}) as never),
      latestRunId: (thread.queuedRunId ??
        thread.runId) as OrchestrationV2ThreadShell["latestRunId"],
      lastError: thread.lastError ?? null,
      latestRunCompletedAt:
        thread.runId !== null && thread.status !== "queued" && thread.status !== "running"
          ? DateTime.makeUnsafe(0)
          : null,
      activeRunId: thread.status === "running" ? RunId.make(thread.runId!) : null,
      worktreePath: thread.worktreePath,
      branch: thread.branch ?? null,
      latestRunStartedAt: thread.started === true ? DateTime.makeUnsafe(0) : null,
    };
    return shell as OrchestrationV2ThreadShell;
  });

  /** The threads in one folder, as the orchestrator lists them by worktree path. */
  const getShellSnapshot = Effect.fn("FakeThreads.getShellSnapshot")(function* (options?: {
    readonly worktreePath?: string;
  }) {
    const shells: Array<OrchestrationV2ThreadShell> = [];
    const archived: Array<OrchestrationV2ThreadShell> = [];
    for (const [threadId, thread] of yield* Ref.get(threads)) {
      if (options?.worktreePath !== undefined && thread.worktreePath !== options.worktreePath)
        continue;
      const shell = yield* getThreadShell(threadId);
      if (shell !== null) (thread.archived ? archived : shells).push(shell);
    }
    return { threads: shells, archivedThreads: archived } as never;
  });

  const launch = Effect.fn("FakeThreads.launch")(function* (
    input: ThreadLaunchService.ThreadLaunchInput,
  ) {
    const threadId = input.threadId ?? ThreadId.make("unexpected");
    const pending = input.initialMessage === undefined ? null : yield* Ref.get(launchGate);
    const gate = pending?.threadId === undefined || pending.threadId === threadId ? pending : null;
    if (gate !== null) yield* Ref.set(launchGate, null);
    const pause = Effect.gen(function* () {
      if (gate === null) return;
      yield* Deferred.succeed(gate.entered, undefined);
      yield* Deferred.await(gate.release);
    });
    if (gate?.stage === "before-thread") yield* pause;
    const seen = (yield* Ref.get(launchedCommands)).has(input.commandId);
    if (!seen) {
      yield* Ref.update(launchedCommands, (current) => new Set(current).add(input.commandId));
      yield* Ref.update(threads, (current) =>
        new Map(current).set(threadId, {
          projectId: input.projectId,
          archived: false,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          status: "idle",
          blockingRequest: false,
          backgroundTasks: 0,
          runId: null,
          ...describeWorkspace(input),
        }),
      );
      yield* Ref.update(commands, (current) => [...current, `launch ${threadId}`]);
      if (gate?.stage === "before-message") yield* pause;
      if (input.initialMessage !== undefined) {
        yield* update(threadId, { status: "queued", runId: `run:${threadId}` });
      }
    }
    const signal = yield* Ref.get(launched);
    if (signal !== null && input.initialMessage !== undefined) {
      yield* Deferred.succeed(signal, threadId);
    }
    if (yield* Ref.get(hangLaunches)) return yield* Effect.never;
    return { threadId, resumed: seen } as never;
  });

  const threadLayer = Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch,
      withBotResultDelivery: (command, use) =>
        beforeDeliveryLock.pipe(Effect.andThen(use(dispatchLocked(command)))),
      getThreadShell,
      sendToThread: (input) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(threads)).get(input.threadId)?.archived === true)
            return yield* new ThreadManagementService.ThreadManagementThreadArchivedError({
              threadId: input.threadId,
            });
          if (!(yield* Ref.get(receipts)).has(input.commandId)) {
            yield* Ref.update(receipts, (current) => new Set(current).add(input.commandId));
            yield* Ref.update(sends, (all) => [...all, input]);
          }
          return {} as never;
        }),
      getShellSnapshot,
      isProviderInstanceEnabledForProject: (input) =>
        Effect.succeed(input.instanceId !== "codex-blocked"),
      getProjectThreadRecords: (input, fields, filter) =>
        Effect.gen(function* () {
          yield* Ref.update(reads, (all) => [...all, { input, fields, filter }]);
          const record = (yield* Ref.get(records)).get(input.threadId);
          if (record === undefined || record.thread.projectId !== input.projectId) {
            return yield* new ThreadManagementService.ThreadManagementThreadNotFoundError(input);
          }
          return record as never;
        }),
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({ launch }),
    Layer.mock(BotWorktreePool.BotWorktreePool)({
      take: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(poolTakes, (all) => [...all, input]);
          const gate = yield* Ref.getAndSet(poolGate, null);
          if (gate !== null) {
            yield* Deferred.succeed(gate.entered, undefined);
            yield* Deferred.await(gate.release);
          }
          const [next, ...rest] = yield* Ref.get(poolClaims);
          if (rest.length > 0) yield* Ref.set(poolClaims, rest);
          const claim = next ?? {
            _tag: "pooled",
            worktreePath: `/worktrees/${input.branch.replaceAll("/", "-")}`,
            setupNeeded: true,
          };
          if (claim._tag === "pooled") {
            yield* botSql`UPDATE bot_tasks SET worktree_state = 'held'
              WHERE work_thread_id = ${input.workThreadId}`.pipe(Effect.orDie);
            yield* Ref.update(poolHeld, (all) =>
              new Map(all).set(input.workThreadId, claim.worktreePath),
            );
          }
          return claim;
        }),
      release: (input) =>
        Effect.gen(function* () {
          const held = (yield* Ref.get(poolHeld)).get(input.workThreadId);
          if (held === undefined) return { savedWork: false, savedOn: null, kept: null };
          yield* yield* Ref.get(poolMoving);
          const busy = yield* input.inUse;
          if (busy !== null) {
            yield* Ref.update(poolKept, (all) => new Map(all).set(input.workThreadId, busy));
            return { savedWork: false, savedOn: null, kept: busy };
          }
          yield* Ref.update(poolParks, (all) => [...all, input.reuse ? held : `${held} (removed)`]);
          const without = (all: ReadonlyMap<ThreadId, string>) => {
            const next = new Map(all);
            next.delete(input.workThreadId);
            return next;
          };
          yield* Ref.update(poolHeld, without);
          yield* Ref.update(poolKept, without);
          // The pool records saved work on the task itself, before the worktree moves.
          const savedWork = yield* Ref.get(poolSavesWork);
          if (savedWork)
            yield* botSql`UPDATE bot_tasks SET unfinished_work = 1
              WHERE work_thread_id = ${input.workThreadId}`.pipe(Effect.orDie);
          return { savedWork, savedOn: null, kept: null };
        }),
      claimedPath: (workThreadId) =>
        Ref.get(poolHeld).pipe(Effect.map((all) => all.get(workThreadId) ?? null)),
      keep: ({ workThreadId, reason }) =>
        Ref.get(poolHeld).pipe(
          Effect.flatMap((held) =>
            held.has(workThreadId)
              ? Ref.update(poolKept, (all) => new Map(all).set(workThreadId, reason)).pipe(
                  Effect.as(true),
                )
              : Effect.succeed(false),
          ),
        ),
      keptClaims: Effect.gen(function* () {
        const held = yield* Ref.get(poolHeld);
        return [...(yield* Ref.get(poolKept))].map(([workThreadId, reason]) => ({
          workThreadId,
          path: held.get(workThreadId) ?? "",
          reason,
        }));
      }),
      expire: Effect.void,
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      subscribeMetadata: (listener) =>
        Effect.sync(() => {
          terminalListeners.push(listener);
          return () => {
            terminalListeners.splice(terminalListeners.indexOf(listener), 1);
          };
        }),
    }),
    Layer.mock(BotTaskAcceptance.BotTaskEvidence)({
      check: ({ items }) =>
        Ref.get(existingEvidence).pipe(
          Effect.map((existing) =>
            items.map((item) =>
              "target" in item
                ? existing.has(item.target)
                  ? "found"
                  : "missing"
                : item.kind === "link"
                  ? "link"
                  : "unchecked",
            ),
          ),
        ),
    }),
  );

  /** Resolves with the next work thread launched. */
  const nextLaunch = Effect.gen(function* () {
    const deferred = yield* Deferred.make<ThreadId>();
    yield* Ref.set(launched, deferred);
    return deferred;
  });

  const commandsMatching = (prefix: string) =>
    Ref.get(commands).pipe(Effect.map((all) => all.filter((entry) => entry.startsWith(prefix))));

  return {
    threads,
    records,
    reads,
    update,
    threadLayer,
    nextLaunch,
    hangLaunches,
    launchGate,
    failNext,
    disposeReturn,
    rejected,
    notificationAttempts,
    deliveryLockTransactions,
    commandsMatching,
    poolClaims,
    poolTakes,
    poolHeld,
    poolKept,
    poolMoving,
    terminalEvent,
    poolParks,
    poolSavesWork,
    poolGate,
    existingEvidence,
    sends,
  };
});

type ThreadWorld = Effect.Success<typeof makeThreadWorld>;

const layerSupport = Layer.mergeAll(
  Layer.mock(ProjectService.ProjectService)({
    getById: (projectId: ProjectId) =>
      Effect.succeedSome({
        id: projectId,
        title: `Title of ${projectId}`,
        deletedAt: null,
      } as Project),
  }),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (instanceId) => {
      const provider = CATALOG.find((candidate) => candidate.instanceId === instanceId);
      return Effect.succeed(
        provider === undefined
          ? undefined
          : ({ instanceId, driverKind: provider.driver } as ProviderInstance),
      );
    },
  }),
  Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(CATALOG) }),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/projects",
    isScratchProject: () => Effect.succeed(false),
  }),
  Layer.mock(SecretRequests.SecretRequests)({}),
  ManagedPolicy.layerTest(),
  BotProjectGuard.layer,
  Layer.mock(BotHomeFolders.BotHomeFolders)({
    root: "/bots",
    ensureProject: (id) =>
      Effect.succeed({ projectId: botHomeProjectId(id), workspaceRoot: `/bots/${id}` }),
  }),
  Scheduler.layer,
  ServerSettings.layerTest(),
);

const layerDatabase = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-task-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

interface Services {
  readonly bots: BotService.BotService["Service"];
  readonly tasks: BotTaskService.BotTaskService["Service"];
  readonly routines: ScheduledTaskService.ScheduledTaskService["Service"];
  readonly turnContext: BotTurnContext.BotTurnContext["Service"];
  readonly constraint: BotExecutionConstraint.BotExecutionConstraint["Service"];
  readonly diagnosis: BotFailureDiagnosis.BotFailureDiagnosis["Service"];
  readonly updates: BotHomeUpdates.BotHomeUpdates["Service"];
  readonly setups: WorktreeSetupTracker.WorktreeSetupTracker["Service"];
}

/**
 * Builds the services fresh over the same database, as a server restart would. With
 * `activation`, scheduled work waits for it, as it waits for startup recovery in the server.
 */
const withServices = <A, E>(
  world: ThreadWorld,
  body: (services: Services) => Effect.Effect<A, E, Scope.Scope>,
  activation?: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    return yield* body({
      bots: yield* BotService.BotService,
      tasks: yield* BotTaskService.BotTaskService,
      routines: yield* ScheduledTaskService.ScheduledTaskService,
      turnContext: yield* BotTurnContext.BotTurnContext,
      constraint: yield* BotExecutionConstraint.BotExecutionConstraint,
      diagnosis: yield* BotFailureDiagnosis.BotFailureDiagnosis,
      updates: yield* BotHomeUpdates.BotHomeUpdates,
      setups: yield* WorktreeSetupTracker.WorktreeSetupTracker,
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        BotService.layer,
        BotTurnContext.layer,
        BotExecutionConstraint.layer,
        BotFailureDiagnosis.layer,
        BotHomeUpdates.layer,
      ).pipe(
        Layer.provideMerge(
          ScheduledTaskService.layer.pipe(Layer.provide(BotTaskService.layerRoutineTarget)),
        ),
        Layer.provideMerge(BotTaskService.layer),
        Layer.provide(Layer.merge(world.threadLayer, layerSupport)),
        Layer.provideMerge(WorktreeSetupTracker.layer),
      ),
    ),
    Effect.scoped,
    Effect.provideService(ServerActivation, activation),
  );

const seedProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${campaign}, 'Campaign', '/campaigns/campaign', NULL,
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
});

const attachBot = Effect.fn("BotTaskServiceTest.attachBot")(function* (services: Services) {
  yield* services.bots.create({
    botId,
    name: "Campaign Companion",
    instructions: "Help prepare the campaign.",
    modelSelection: codex,
    learningPolicy: "after_adoption",
  });
  const detail = yield* services.bots.attachProject({ botId, projectId: campaign });
  return detail.projects[0]?.homeThreadId ?? assert.fail("no home thread");
});

const routineInput = (
  schedule: ScheduledTaskUpsertInput["schedule"],
  sessionAt?: string,
): ScheduledTaskUpsertInput => ({
  commandId: CommandId.make(`routine-${schedule.type}`),
  title: "Session preparation",
  prompt: "Prepare the next session.",
  enabled: true,
  schedule,
  projectId: campaign,
  workspaceStrategy: { type: "root" },
  modelSelection: codex,
  runtimeMode: "full-access",
  interactionMode: "default",
  bot: { botId, ...(sessionAt === undefined ? {} : { sessionAt }) },
});

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const decodeTaskListInput = Schema.decodeUnknownSync(BotTaskListInput);

const statusOf = (services: Services, taskId: string) =>
  services.tasks
    .list({ botId })
    .pipe(Effect.map((result) => result.tasks.find((task) => task.id === taskId)?.status));

it.effect.each<{
  readonly shell: Partial<FakeThread> | null;
  readonly cancelRequested?: boolean;
  readonly expected: BotTaskStatus;
}>([
  { shell: { status: "queued" }, expected: "accepted" },
  { shell: { status: "running" }, expected: "running" },
  { shell: { status: "running", blockingRequest: true }, expected: "waiting" },
  { shell: { status: "completed" }, expected: "completed" },
  { shell: { status: "completed", backgroundTasks: 1 }, expected: "running" },
  { shell: { status: "failed" }, expected: "failed" },
  { shell: { status: "interrupted" }, expected: "interrupted" },
  // A restart ends runs as cancelled; only a stop someone asked for reads as cancelled.
  { shell: { status: "cancelled" }, expected: "interrupted" },
  { shell: { status: "interrupted" }, cancelRequested: true, expected: "cancelled" },
  { shell: null, expected: "interrupted" },
])("derives $expected from the work thread", ({ shell, cancelRequested, expected }) =>
  Effect.sync(() => {
    const status = BotTaskService.deriveTaskStatus({
      cancelRequested: cancelRequested ?? false,
      shell:
        shell === null
          ? null
          : {
              status: shell.status ?? "idle",
              pendingRuntimeRequest: shell.blockingRequest
                ? ({ blocking: true } as OrchestrationV2ThreadShell["pendingRuntimeRequest"])
                : null,
              pendingBackgroundTasks: Array.from(
                { length: shell.backgroundTasks ?? 0 },
                () => ({}) as never,
              ),
              deletedAt: null,
            },
    });
    assert.equal(status, expected);
  }),
);

it.effect("looks up an existing work thread outside the latest 50 environment tasks", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const sql = yield* BotDatabase.BotDatabase;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        const task = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Prepare.",
        });
        const workThreadId = task.workThreadId ?? assert.fail("no work thread");
        yield* sql`
          WITH RECURSIVE newer(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM newer WHERE n < 51)
          INSERT INTO bot_tasks (
            task_id, bot_id, project_id, home_thread_id, work_thread_id, origin,
            title, prompt, runtime_mode, status, created_at, updated_at
          )
          SELECT 'newer-' || n, bot_id, project_id, home_thread_id, 'bot-work:newer-' || n,
            origin, title, prompt, runtime_mode, status, ${iso(START + HOUR)}, ${iso(START + HOUR)}
          FROM bot_tasks, newer WHERE task_id = ${task.id}
        `;
        const recent = (yield* services.tasks.list({})).tasks;
        assert.lengthOf(recent, 50);
        assert.isFalse(recent.some((entry) => entry.id === task.id));
        const lookup = (id: ThreadId) =>
          services.tasks.list(decodeTaskListInput({ workThreadId: id }));
        assert.deepEqual((yield* lookup(workThreadId)).tasks, [task]);
        assert.deepEqual((yield* lookup(ThreadId.make("bot-work:missing"))).tasks, []);
        yield* services.bots.setArchived({ botId, archived: true });
        assert.equal((yield* lookup(workThreadId)).tasks[0]?.botId, botId);
        assert.equal((yield* services.tasks.getAwarenessTasks(workThreadId))[0]?.taskId, task.id);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "reads only the task's saved result run and reports missing or unfinished results honestly",
  () =>
    Effect.gen(function* () {
      yield* seedProject;
      const world = yield* makeThreadWorld;
      const sql = yield* BotDatabase.BotDatabase;
      yield* withServices(world, (services) =>
        Effect.gen(function* () {
          yield* attachBot(services);
          const task = yield* services.tasks.start({
            botId,
            projectId: campaign,
            prompt: "Prepare.",
          });
          const workThreadId = task.workThreadId ?? assert.fail("no work thread");
          assert.equal(
            (yield* services.tasks.getResult({ taskId: task.id })).result.state,
            "not_completed",
          );
          assert.lengthOf(yield* Ref.get(world.reads), 0);
          yield* world.update(workThreadId, { status: "completed" });
          yield* services.tasks.reconcile;
          const runId = RunId.make(`run:${workThreadId}`);
          const laterRunId = RunId.make("later-follow-up");
          const output = (id: string, run: RunId, text: string, ordinal: number) => {
            const artifacts = makeSubagentConversationArtifacts({
              messageId: MessageId.make(id),
              turnItemId: TurnItemId.make(id),
              threadId: workThreadId,
              rootNodeId: NodeId.make("root"),
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              role: "assistant",
              text,
              ordinal,
              now: DateTime.makeUnsafe(START),
            });
            if (artifacts.turnItem.type !== "assistant_message")
              return assert.fail("no assistant item");
            return {
              message: { ...artifacts.message, runId: run },
              turnItem: { ...artifacts.turnItem, runId: run },
            };
          };
          const progress = output("progress", runId, "Starting.", 1);
          const final = output("final", runId, "The saved result.", 2);
          const later = output("later", laterRunId, "Different follow-up answer.", 3);
          const run = {
            id: runId,
            threadId: workThreadId,
            status: "completed",
          } as OrchestrationV2Run;
          const record = {
            thread: {
              id: workThreadId,
              projectId: campaign,
              deletedAt: null,
            } as OrchestrationV2ThreadProjection["thread"],
            runs: [run, { ...run, id: laterRunId }],
            messages: [progress.message, final.message, later.message],
            turnItems: [
              later.turnItem,
              final.turnItem,
              progress.turnItem,
              {
                ...final.turnItem,
                type: "reasoning",
                text: "Hidden reasoning",
                ordinal: 99,
              } as OrchestrationV2ThreadProjection["turnItems"][number],
            ],
          };
          yield* Ref.update(world.records, (all) => new Map(all).set(workThreadId, record));
          yield* world.update(workThreadId, { runId: laterRunId });
          assert.deepEqual(yield* services.tasks.getAwarenessTasks(workThreadId), [
            {
              taskId: task.id,
              botId,
              projectId: campaign,
              homeThreadId: task.homeThreadId,
              byHand: true,
              quiet: false,
              // The result has no report line, so it waits for the user.
              needsYou: true,
              workThreadId,
              status: "completed",
              resultRunId: runId,
              completedAt: (yield* services.tasks.get(task.id)).completedAt,
            },
          ]);
          assert.deepEqual(yield* services.tasks.getAwarenessTasks(ThreadId.make("missing")), []);
          const saved = yield* services.tasks.getResult({ taskId: task.id });
          assert.equal(saved.task.id, task.id);
          assert.deepEqual(saved.result, { state: "available", runId, text: "The saved result." });
          yield* Ref.update(world.records, (all) =>
            new Map(all).set(workThreadId, {
              ...record,
              messages: [progress.message],
              turnItems: [{ ...progress.turnItem, responseKind: "intermediate" }],
            }),
          );
          assert.deepEqual((yield* services.tasks.getResult({ taskId: task.id })).result, {
            state: "empty",
            runId,
          });
          yield* Ref.update(world.records, (all) =>
            new Map(all).set(workThreadId, {
              ...record,
              turnItems: [
                { ...final.turnItem, responseKind: "final" },
                { ...progress.turnItem, responseKind: "intermediate", ordinal: 3 },
              ],
            }),
          );
          assert.deepEqual((yield* services.tasks.getResult({ taskId: task.id })).result, {
            state: "available",
            runId,
            text: "The saved result.",
          });
          assert.deepEqual((yield* Ref.get(world.reads))[0], {
            input: { projectId: campaign, threadId: workThreadId },
            fields: ["runs", "messages", "turnItems"],
            filter: {
              runIds: [runId],
              messageRoles: ["assistant"],
              messageRunIds: [runId],
              turnItemRunIds: [runId],
              turnItemTypes: ["assistant_message"],
            },
          });
          for (const change of [
            { runs: [] },
            { runs: [{ ...run, threadId: ThreadId.make("other-task") }] },
            { runs: [{ ...run, status: "running" as const }] },
            { thread: { ...record.thread, projectId: ProjectId.make("other-project") } },
          ]) {
            yield* Ref.update(world.records, (all) =>
              new Map(all).set(workThreadId, { ...record, ...change }),
            );
            assert.equal(
              (yield* services.tasks.getResult({ taskId: task.id })).result.state,
              "unavailable",
            );
          }
          yield* Ref.update(world.records, (all) =>
            new Map(all).set(workThreadId, {
              ...record,
              messages: [],
              turnItems: [later.turnItem],
            }),
          );
          assert.deepEqual((yield* services.tasks.getResult({ taskId: task.id })).result, {
            state: "empty",
            runId,
          });
          yield* Ref.update(world.records, (all) => {
            const next = new Map(all);
            next.delete(workThreadId);
            return next;
          });
          assert.equal(
            (yield* services.tasks.getResult({ taskId: task.id })).result.state,
            "unavailable",
          );
          for (const text of ["", "   "]) {
            yield* Ref.update(world.records, (all) =>
              new Map(all).set(workThreadId, {
                ...record,
                messages: [progress.message, { ...final.message, text }],
                turnItems: [progress.turnItem, final.turnItem],
              }),
            );
            assert.deepEqual((yield* services.tasks.getResult({ taskId: task.id })).result, {
              state: "empty",
              runId,
            });
          }
          yield* Ref.update(world.records, (all) => new Map(all).set(workThreadId, record));
          yield* sql`UPDATE bot_tasks SET result_run_id = NULL WHERE task_id = ${task.id}`;
          assert.equal(
            (yield* services.tasks.getResult({ taskId: task.id })).result.state,
            "unavailable",
          );
          const missing = yield* services.tasks
            .getResult({ taskId: BotTaskId.make("missing") })
            .pipe(Effect.flip);
          assert.equal(missing.message, "Bot task not found.");
          for (const status of [
            "running",
            "waiting",
            "failed",
            "interrupted",
            "cancelled",
            "skipped",
          ] as const) {
            yield* sql`UPDATE bot_tasks SET status = ${status} WHERE task_id = ${task.id}`;
            const result = yield* services.tasks.getResult({ taskId: task.id });
            assert.equal(result.task.status, status);
            assert.equal(result.result.state, "not_completed");
          }
        }),
      );
    }).pipe(Effect.provide(layerDatabase)),
);

const seedHomeRun = Effect.fn("BotTaskServiceTest.seedHomeRun")(function* (
  world: ThreadWorld,
  home: ThreadId,
  provenance:
    | "ui"
    | "external-mcp"
    | "server"
    | "provider"
    | "forwarded"
    | "automatic"
    | "scheduled-ui"
    | "scheduled-mcp" = "ui",
  projectId: ProjectId = campaign,
) {
  const runId = RunId.make(`user-run:${home}`);
  const messageId = MessageId.make(`user-message:${home}`);
  const input = makeSubagentConversationArtifacts({
    messageId,
    turnItemId: TurnItemId.make(`input:${home}`),
    threadId: home,
    rootNodeId: NodeId.make("home-root"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    role: "user",
    text: "Prepare.",
    ordinal: 1,
    now: DateTime.makeUnsafe(START),
  });
  yield* world.update(home, { status: "running", runId });
  yield* Ref.update(world.records, (all) =>
    new Map(all).set(home, {
      thread: {
        id: home,
        projectId,
        deletedAt: null,
        archivedAt: null,
      } as OrchestrationV2ThreadProjection["thread"],
      runs: [
        {
          id: runId,
          threadId: home,
          userMessageId: messageId,
          ordinal: 1,
          status: "running",
        } as OrchestrationV2Run,
      ],
      messages: [
        {
          ...input.message,
          runId,
          createdBy: provenance === "ui" || provenance === "scheduled-ui" ? "user" : "agent",
          creationSource:
            provenance === "ui" || provenance === "scheduled-ui"
              ? "web"
              : provenance === "server"
                ? "server"
                : provenance === "provider"
                  ? "provider"
                  : "mcp",
          ...(provenance.startsWith("scheduled-")
            ? { scheduledTaskId: ScheduledTaskId.make("scheduled-home") }
            : {}),
          ...(provenance === "forwarded" ? { senderThreadId: ThreadId.make("sender") } : {}),
          ...(provenance === "automatic"
            ? {
                notification: {
                  source: { kind: "system" },
                  outcome: "completed",
                  summary: "Result",
                },
              }
            : {}),
        },
      ],
      turnItems: [{ ...input.turnItem, runId }],
    }),
  );
  return runId;
});

it.effect("returns only opted-in saved results to Home once across retry and restart", () =>
  Effect.gen(function* () {
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const { task, ordinary, home, anchor } = yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        const anchor = yield* seedHomeRun(world, home, "external-mcp");
        // Admitted, so reconciled, before the returning task; while it works, the return waits.
        const ordinary = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Ordinary.",
          commandId: CommandId.make("ordinary"),
        });
        const task = yield* services.tasks.start(
          {
            botId,
            projectId: campaign,
            prompt: "Prepare.",
            commandId: CommandId.make("return-home"),
          },
          { returnToHomeFrom: home },
        );
        yield* finishRun(world, task.workThreadId!, DONE_RESULT);
        yield* services.tasks.reconcile;
        return { task, ordinary, home, anchor };
      }),
    );
    const runId = RunId.make(`run:${task.workThreadId}`);
    const sql = yield* BotDatabase.BotDatabase;
    yield* sql`CREATE TRIGGER interrupt_return_bookkeeping BEFORE UPDATE OF return_finished_at ON bot_tasks
      BEGIN SELECT RAISE(ABORT, 'injected interruption after receipt'); END`;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        // The saved run remains authoritative after a later work-thread turn.
        yield* world.update(task.workThreadId!, { runId: "later-run" });
        yield* world.update(home, { status: "completed" });
        yield* world.update(ordinary.workThreadId!, { status: "completed" });
        yield* Ref.set(world.failNext, "bot-task.result.deliver");
        yield* services.tasks.reconcile;
        yield* services.tasks.reconcile;
        assert.lengthOf(yield* world.commandsMatching("bot-task.result.deliver"), 1);
        assert.equal(
          (yield* services.tasks.getResult({ taskId: task.id })).result.state,
          "available",
        );
      }),
    );
    assert.isNull(
      (yield* sql`SELECT return_finished_at FROM bot_tasks WHERE task_id = ${task.id}`)[0]
        ?.return_finished_at,
    );
    yield* sql`DROP TRIGGER interrupt_return_bookkeeping`;
    yield* withServices(world, (services) => services.tasks.reconcile);
    assert.deepEqual(yield* world.commandsMatching("bot-task.result.deliver"), [
      `bot-task.result.deliver ${home} bot-task-return:${task.id}:${runId}`,
    ]);
    assert.lengthOf(yield* world.commandsMatching("thread.mark-unread"), 2);
    const [saved] = yield* sql<{
      return_home_run_id: string;
      return_finished_at: string | null;
    }>`SELECT return_home_run_id, return_finished_at FROM bot_tasks WHERE task_id = ${task.id}`;
    assert.equal(saved?.return_home_run_id, anchor);
    assert.isNotNull(saved?.return_finished_at);
    const acquisitions = yield* Ref.get(world.deliveryLockTransactions);
    assert.isAbove(acquisitions.length, 0);
    assert.isTrue(
      acquisitions.every((held) => !held),
      "waiting for Home must not hold the Bot writer",
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each([
  "foreign-home",
  "automatic-home",
  "server",
  "provider",
  "forwarded",
  "scheduled-ui",
  "scheduled-mcp",
] as const)("refuses return-to-Home from %s before launching work", (caller) =>
  Effect.gen(function* () {
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        yield* seedHomeRun(
          world,
          home,
          caller === "automatic-home" ? "automatic" : caller === "foreign-home" ? "ui" : caller,
        );
        const started = yield* services.tasks
          .start(
            { botId, projectId: campaign, prompt: "Prepare." },
            { returnToHomeFrom: caller === "foreign-home" ? ThreadId.make("other") : home },
          )
          .pipe(Effect.exit);
        assert.equal(started._tag, "Failure");
        assert.lengthOf((yield* services.tasks.list({ botId })).tasks, 0);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each([
  { caller: "client", byHand: true },
  { caller: "ui", byHand: true },
  { caller: "external-mcp", byHand: false },
  { caller: "automatic", byHand: false },
  { caller: "scheduled-ui", byHand: false },
  { caller: "outside-agent", byHand: false },
  { caller: "other-thread", byHand: false },
] as const)("records whether the user started a direct task: $caller", ({ caller, byHand }) =>
  Effect.gen(function* () {
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        if (caller !== "client" && caller !== "outside-agent" && caller !== "other-thread")
          yield* seedHomeRun(world, home, caller);
        else yield* seedHomeRun(world, home);
        const task = yield* services.tasks.start(
          { botId, projectId: campaign, prompt: "Prepare." },
          caller === "client"
            ? undefined
            : {
                requestedIn:
                  caller === "outside-agent"
                    ? null
                    : caller === "other-thread"
                      ? ThreadId.make("other")
                      : home,
              },
        );
        const [awareness] = yield* services.tasks.getAwarenessTasks(task.workThreadId!);
        assert.equal(awareness?.byHand, byHand);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each([
  { caller: "client", byHand: true },
  { caller: "ui", byHand: true },
  { caller: "automatic", byHand: false },
  { caller: "outside-agent", byHand: false },
  { caller: "other-thread", byHand: false },
  { caller: "schedule", byHand: false },
] as const)("records whether the user started a routine run: $caller", ({ caller, byHand }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        yield* seedHomeRun(world, home, caller === "automatic" ? "automatic" : "ui");
        const { task: routine } = yield* services.routines.upsert(
          routineInput({ type: "once", runAt: iso(START + HOUR) }),
        );
        let workThreadId: ThreadId | null;
        if (caller === "schedule") {
          const launched = yield* world.nextLaunch;
          yield* TestClock.setTime(START + HOUR);
          yield* TestClock.adjust("6 seconds");
          workThreadId = yield* Deferred.await(launched);
        } else {
          const requestedIn =
            caller === "outside-agent"
              ? null
              : caller === "other-thread"
                ? ThreadId.make("other")
                : home;
          ({ threadId: workThreadId } = yield* services.routines.runNow(
            { id: routine.id },
            caller === "client" ? undefined : { requestedIn },
          ));
        }
        const [awareness] = yield* services.tasks.getAwarenessTasks(
          workThreadId ?? assert.fail("no work thread"),
        );
        assert.equal(awareness?.byHand, byHand);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each([
  "failed",
  "cancelled",
  "detach",
  "archive",
  "revoke",
  "detach-interrupted",
  "archive-interrupted",
] as const)("revokes or retires an opted-in return after %s", (state) =>
  Effect.gen(function* () {
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const sql = yield* BotDatabase.BotDatabase;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        yield* seedHomeRun(world, home);
        // Admitted, so reconciled, first; while it works, a completed result's return waits.
        const blocker = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Other work.",
          commandId: CommandId.make("blocker"),
        });
        const task = yield* services.tasks.start(
          { botId, projectId: campaign, prompt: "Prepare.", commandId: CommandId.make("return") },
          { returnToHomeFrom: home },
        );
        if (state === "cancelled") yield* services.tasks.cancel({ taskId: task.id });
        else if (state === "failed") yield* world.update(task.workThreadId!, { status: "failed" });
        else yield* finishRun(world, task.workThreadId!, DONE_RESULT);
        yield* services.tasks.reconcile;
        const runId = RunId.make(`run:${task.workThreadId}`);
        yield* Ref.update(world.records, (all) =>
          new Map(all).set(task.workThreadId!, {
            thread: {
              id: task.workThreadId!,
              projectId: campaign,
              deletedAt: null,
            } as OrchestrationV2ThreadProjection["thread"],
            runs: [
              {
                id: runId,
                threadId: task.workThreadId!,
                status: "completed",
              } as OrchestrationV2Run,
            ],
            messages: [],
            turnItems: [],
          }),
        );
        if (state === "detach-interrupted" || state === "archive-interrupted") {
          using _pause = vi
            .spyOn(services.routines, "pauseBotRoutines")
            .mockImplementation(() =>
              Effect.fail(new ScheduledTaskError({ message: "Injected pause failure." })),
            );
          const transition = yield* (
            state === "detach-interrupted"
              ? services.bots.detachProject({ botId, projectId: campaign })
              : services.bots.setArchived({ botId, archived: true })
          ).pipe(Effect.exit);
          assert.equal(transition._tag, "Failure");
          const [revoked] =
            yield* sql`SELECT return_home_run_id FROM bot_tasks WHERE task_id = ${task.id}`;
          assert.isNull(revoked?.return_home_run_id);
          if (state === "detach-interrupted")
            yield* services.bots.attachProject({ botId, projectId: campaign });
          else yield* services.bots.setArchived({ botId, archived: false });
        } else if (state === "detach") {
          yield* services.bots.detachProject({ botId, projectId: campaign });
          yield* services.bots.attachProject({ botId, projectId: campaign });
        } else if (state === "archive") {
          yield* services.bots.setArchived({ botId, archived: true });
          yield* services.bots.setArchived({ botId, archived: false });
        } else if (state === "revoke") yield* services.tasks.cancel({ taskId: task.id });
        yield* world.update(home, { status: "completed" });
        yield* world.update(blocker.workThreadId!, { status: "completed" });
        yield* services.tasks.reconcile;
        assert.lengthOf(yield* world.commandsMatching("bot-task.result.deliver"), 0);
        if (state === "failed" || state === "cancelled")
          assert.equal(
            (yield* services.tasks.getResult({ taskId: task.id })).result.state,
            "not_completed",
          );
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

const atlas = ProjectId.make("project-atlas");

it.effect(
  "the Bot's own Home starts tasks in its projects and holds their cards; removing it stops them",
  () =>
    Effect.gen(function* () {
      yield* seedProject;
      const main = yield* SqlClient.SqlClient;
      yield* main`INSERT INTO projection_projects (project_id, title, workspace_root,
        default_model_selection_json, scripts_json, created_at, updated_at, deleted_at)
        SELECT ${atlas}, 'Atlas', '/campaigns/atlas', NULL, '[]', created_at, updated_at, NULL
        FROM projection_projects WHERE project_id = ${campaign}`;
      const world = yield* makeThreadWorld;
      const sql = yield* BotDatabase.BotDatabase;
      yield* withServices(world, (services) =>
        Effect.gen(function* () {
          const projectHome = yield* attachBot(services);
          yield* services.bots.attachProject({ botId, projectId: atlas });
          const home = (yield* services.bots.openHome({ botId })).home ?? assert.fail("no Home");
          for (const refused of [
            Effect.asVoid(
              services.tasks.start({ botId, projectId: home.projectId, prompt: "Distribute." }),
            ),
            Effect.asVoid(services.tasks.requireRunnable({ botId, projectId: home.projectId })),
          ]) {
            const error = yield* Effect.flip(refused);
            assert.include(error.message, "never in its own Home's project");
          }

          // The project's Home decides how its tasks run, not the Home that asked.
          yield* world.update(projectHome, { runtimeMode: "approval-required" });
          yield* world.update(home.homeThreadId, { runtimeMode: "full-access" });
          yield* seedHomeRun(world, home.homeThreadId, "ui", home.projectId);
          // An update of a task started earlier in this turn already waits behind it.
          yield* world.update(home.homeThreadId, { queuedRunId: "update-run" });
          yield* services.bots.update({ botId, taskLimit: 1 });
          const fromHome = (prompt: string, projectId: ProjectId, returnToHome = false) =>
            services.tasks.start(
              { botId, projectId, prompt },
              {
                requestedIn: home.homeThreadId,
                ...(returnToHome ? { returnToHomeFrom: home.homeThreadId } : {}),
              },
            );
          // Its results come back as updates, so a return to Home is not held for it.
          const running = yield* fromHome("A.", campaign, true);
          const waiting = yield* fromHome("B.", atlas);
          assert.deepInclude(running, {
            homeThreadId: home.homeThreadId,
            projectId: campaign,
            runtimeMode: "approval-required",
            returnToHome: false,
          });
          assert.deepInclude(waiting, { homeThreadId: home.homeThreadId, projectId: atlas });
          assert.include(waiting.detail, "Waiting for a free slot");
          // The user's own turn in that Home asked, so the task is theirs.
          const [byHand] = yield* sql<{ readonly by_hand: number }>`
            SELECT by_hand FROM bot_tasks WHERE task_id = ${running.id}`;
          assert.equal(byHand?.by_hand, 1);
          const unattached = yield* Effect.flip(fromHome("C.", ProjectId.make("project-other")));
          assert.include(unattached.message, "not attached to this project");

          const own = yield* services.tasks.start(
            { botId, projectId: campaign, prompt: "Own." },
            { requestedIn: projectHome },
          );
          assert.equal(own.homeThreadId, projectHome);
          const cardsOf = (homeThreadId: ThreadId) =>
            services.tasks
              .list({ homeThreadId })
              .pipe(Effect.map(({ tasks }) => tasks.map((task) => task.id)));
          assert.sameMembers(yield* cardsOf(home.homeThreadId), [running.id, waiting.id]);
          assert.deepEqual(yield* cardsOf(projectHome), [own.id]);

          yield* services.bots.removeHome({ botId });
          const rows = yield* sql<{
            readonly task_id: string;
            readonly status: string;
            readonly cancel_requested_at: string | null;
            readonly detail: string | null;
          }>`SELECT task_id, status, cancel_requested_at, detail FROM bot_tasks`;
          const byId = new Map(rows.map((row) => [row.task_id, row]));
          assert.isNull(byId.get(own.id)?.cancel_requested_at);
          for (const task of [running, waiting])
            assert.equal(byId.get(task.id)?.detail, "Stopped because the Bot's Home was removed.");
          // The waiting one ends at once and never starts.
          assert.equal(byId.get(waiting.id)?.status, "cancelled");
          assert.isFalse((yield* Ref.get(world.threads)).has(workThreadOf(waiting)));
          // A turn still running in the removed Home starts nothing, not even in a project's Home.
          const removed = yield* Effect.flip(fromHome("E.", campaign));
          assert.include(removed.message, "Home was removed");

          // A start the removal did not see, as after a crash, is stopped by the next pass.
          yield* services.bots.openHome({ botId });
          const late = yield* fromHome("D.", campaign);
          yield* sql`UPDATE bot_project_contexts SET detached_at = updated_at
            WHERE home_thread_id = ${home.homeThreadId}`;
          yield* services.tasks.reconcile;
          assert.deepInclude(yield* services.tasks.get(late.id), {
            homeThreadId: home.homeThreadId,
            detail: "Stopped because the Bot's Home was removed.",
          });
        }),
      );
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("the Bot's own Home is told once of each task it started that ends or asks", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const sql = yield* BotDatabase.BotDatabase;
    const updates = Ref.get(world.sends).pipe(
      Effect.map((all) => all.filter((send) => send.messageId.startsWith("bot-task-update:"))),
    );
    const { home, tasks } = yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        yield* services.bots.update({ botId, taskLimit: 10 });
        const home = (yield* services.bots.openHome({ botId })).home ?? assert.fail("no Home");
        const fromHome = (title: string) =>
          services.tasks.start(
            { botId, projectId: campaign, prompt: `${title}.`, title },
            { requestedIn: home.homeThreadId },
          );
        const tasks = {
          done: yield* fromHome("Done"),
          unproven: yield* fromHome("Unproven"),
          failed: yield* fromHome("Failed"),
          asking: yield* fromHome("Asking"),
          cancelled: yield* fromHome("Cancelled"),
          // A project Home's task is no update: its card and return work as before.
          own: yield* services.tasks.start({ botId, projectId: campaign, prompt: "Own." }),
        };
        const work = (task: BotTaskSummary) => task.workThreadId ?? assert.fail("not launched");
        yield* finishRun(world, work(tasks.done), DONE_RESULT);
        yield* finishRun(
          world,
          work(tasks.unproven),
          `Changed it.\n${report({ evidence: ["branch: bot/missing"] })}`,
        );
        yield* endRun(world, work(tasks.failed), "failed");
        yield* world.update(work(tasks.failed), { lastError: "Codex exited with code 1." });
        yield* world.update(work(tasks.asking), { status: "running", blockingRequest: true });
        const card = (status: string) =>
          Ref.update(world.records, (all) =>
            new Map(all).set(work(tasks.asking), {
              thread: { id: work(tasks.asking), projectId: campaign, deletedAt: null } as never,
              runs: [],
              messages: [],
              turnItems: [
                {
                  type: "user_input_request",
                  requestId: "request",
                  status,
                  questions: [{ question: "Which branch should I use?" }],
                } as never,
              ],
            }),
          );
        // Answered after the shell was read: no update for a question nobody waits on.
        yield* card("completed");
        yield* services.tasks.cancel({ taskId: tasks.cancelled.id });
        yield* finishRun(world, work(tasks.own), DONE_RESULT);
        yield* services.tasks.reconcile;
        yield* services.tasks.reconcile;
        yield* services.updates.deliverOwed;
        assert.lengthOf(yield* updates, 3);
        yield* card("waiting");
        yield* services.updates.deliverOwed;
        yield* services.updates.deliverOwed;
        return { home, tasks };
      }),
    );
    const sent = yield* updates;
    assert.deepEqual(
      sent.map((send) => send.senderThreadId ?? null),
      [tasks.done, tasks.unproven, tasks.failed, tasks.asking].map((task) => task.workThreadId),
    );
    for (const send of sent) {
      // From the work thread and queued, so it waits for the Home's running turn.
      assert.deepInclude(send, {
        threadId: home.homeThreadId,
        projectId: home.projectId,
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      });
      assert.equal<string>(send.commandId, send.messageId);
    }
    const [done, unproven, failed, asking] = sent.map((send) => send.text);
    assert.include(done, "a task you started finished.");
    assert.include(done, "Project: Title of project-campaign (project-campaign)");
    assert.include(done, "Result: Prepared the notes.");
    assert.include(done, "Result check: passed.");
    assert.notInclude(done, "T3_RESULT");
    assert.include(unproven, "finished, but its result waits for the user");
    assert.include(unproven, "Result check: not done. “branch: bot/missing” does not exist.");
    assert.include(failed, "a task you started failed.");
    assert.include(failed, "What went wrong: Codex exited with code 1.");
    assert.include(asking, "is waiting for the user");
    assert.include(asking, "Question: Which branch should I use?");
    // What waits for the user is noted in the Home that started it.
    const [waitingNote] = yield* sql<{ readonly home_thread_id: string }>`
      SELECT home_thread_id FROM bot_continuation_revisions
      WHERE update_id = ${`task-waiting:${tasks.unproven.id}`}`;
    assert.equal(waitingNote?.home_thread_id, home.homeThreadId);

    // A restart tells nothing twice. A crash after a send and before its record replays it.
    yield* sql`CREATE TRIGGER fail_update_insert BEFORE INSERT ON bot_home_updates
      BEGIN SELECT RAISE(ABORT, 'injected crash after the send'); END`;
    yield* sql`CREATE TRIGGER fail_update_update BEFORE UPDATE ON bot_home_updates
      BEGIN SELECT RAISE(ABORT, 'injected crash after the send'); END`;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* services.tasks.reconcile;
        yield* services.updates.deliverOwed;
        assert.lengthOf(yield* updates, 4);
        yield* world.update(tasks.asking.workThreadId!, { blockingRequest: false });
        yield* finishRun(world, tasks.asking.workThreadId!, DONE_RESULT);
        yield* services.tasks.reconcile;
        yield* services.updates.deliverOwed;
      }),
    );
    yield* sql`DROP TRIGGER fail_update_insert`;
    yield* sql`DROP TRIGGER fail_update_update`;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* services.updates.deliverOwed;
        yield* services.updates.deliverOwed;
      }),
    );
    const after = yield* updates;
    assert.lengthOf(after, 5);
    assert.include(after[4]?.text, "“Asking”");
    assert.include(after[4]?.text, "finished");
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "refuses a second pending Home return before launch and allows replacing a revoked one",
  () =>
    Effect.gen(function* () {
      yield* seedProject;
      const world = yield* makeThreadWorld;
      yield* withServices(world, (services) =>
        Effect.gen(function* () {
          const home = yield* attachBot(services);
          yield* seedHomeRun(world, home);
          const first = yield* services.tasks.start(
            { botId, projectId: campaign, prompt: "First." },
            { returnToHomeFrom: home },
          );
          const second = yield* services.tasks
            .start({ botId, projectId: campaign, prompt: "Second." }, { returnToHomeFrom: home })
            .pipe(Effect.result);
          assert.equal(second._tag, "Failure");
          if (second._tag === "Failure")
            assert.include(second.failure.message, "already has a pending task return");
          assert.lengthOf((yield* services.tasks.list({ botId })).tasks, 1);
          yield* services.tasks.cancel({ taskId: first.id });
          const replacement = yield* services.tasks.start(
            { botId, projectId: campaign, prompt: "Replacement." },
            { returnToHomeFrom: home },
          );
          assert.isTrue(replacement.returnToHome);
          assert.lengthOf((yield* services.tasks.list({ botId })).tasks, 2);
          yield* Ref.update(world.records, (all) => {
            const records = all.get(home)!;
            const messageId = MessageId.make("steered-home-input");
            const firstMessage = records.messages[0]!;
            const firstItem = records.turnItems[0]!;
            if (firstItem.type !== "user_message") return assert.fail("missing Home input");
            return new Map(all).set(home, {
              ...records,
              messages: [
                ...records.messages,
                { ...firstMessage, id: messageId, text: "New request." },
              ],
              turnItems: [
                ...records.turnItems,
                { ...firstItem, id: TurnItemId.make("steered-input"), messageId, ordinal: 2 },
              ],
            });
          });
          const steered = yield* services.tasks.start(
            { botId, projectId: campaign, prompt: "Steered request." },
            { returnToHomeFrom: home },
          );
          assert.isTrue(steered.returnToHome);
          assert.lengthOf((yield* services.tasks.list({ botId })).tasks, 3);
        }),
      );
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("does not refresh a work-thread subscription for unrelated task changes", () =>
  Effect.gen(function* () {
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        const task = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Prepare.",
        });
        const workThreadId = task.workThreadId ?? assert.fail("no work thread");
        const initial = yield* Deferred.make<void>();
        const running = yield* Deferred.make<void>();
        const statuses = yield* Ref.make<ReadonlyArray<BotTaskStatus | undefined>>([]);
        const subscription = yield* services.tasks.subscribeList({ workThreadId }).pipe(
          Stream.runForEach((result) =>
            Effect.gen(function* () {
              const status = result.tasks[0]?.status;
              yield* Ref.update(statuses, (current) => [...current, status]);
              yield* Deferred.succeed(initial, undefined);
              if (status === "running") yield* Deferred.succeed(running, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(initial);
        const recentCounts = yield* Queue.unbounded<number>();
        yield* services.tasks.subscribeList({}).pipe(
          Stream.runForEach((result) => Queue.offer(recentCounts, result.tasks.length)),
          Effect.forkScoped,
        );
        assert.equal(yield* Queue.take(recentCounts), 1);
        let count = 1;
        for (const prompt of ["Unrelated one.", "Unrelated two.", "Unrelated three."]) {
          yield* services.tasks.start({ botId, projectId: campaign, prompt });
          assert.equal(yield* Queue.take(recentCounts), ++count);
        }
        yield* world.update(workThreadId, { status: "running" });
        yield* services.tasks.reconcile;
        yield* Deferred.await(running);
        yield* Fiber.interrupt(subscription);
        assert.deepEqual(yield* Ref.get(statuses), ["accepted", "running"]);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("keeps each routine run's change permission after edits and a restart", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const workThreads = yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        const input = {
          ...routineInput({ type: "fixed_time", timeOfDay: "18:00" }),
          bot: { botId, allowChanges: true },
        };
        const { task } = yield* services.routines.upsert({
          ...input,
          bot: { ...input.bot, allowChanges: true },
        });
        assert.isTrue(task.bot?.allowChanges);
        const changing = yield* services.routines.runNow({ id: task.id });
        const changingThread = changing.threadId ?? assert.fail();
        yield* world.update(changingThread, { status: "completed" });
        yield* services.tasks.reconcile;
        const saved = yield* services.routines.upsert({
          ...input,
          id: task.id,
          bot: { ...input.bot, allowChanges: false },
        });
        assert.isFalse(saved.task.bot?.allowChanges);
        yield* TestClock.adjust("1 second");
        const preparing = yield* services.routines.runNow({ id: task.id });
        const preparingThread = preparing.threadId ?? assert.fail();
        // Allowing changes again applies to the next run, never to one already admitted.
        yield* services.routines.upsert({ ...input, id: task.id });
        // A direct task stores allow_changes = 0 too, and keeps its usual authority.
        const direct = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Fix the typo.",
        });
        return {
          changingThread,
          preparingThread,
          directThread: direct.workThreadId ?? assert.fail(),
        };
      }),
    );
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        for (const [thread, permission, constraint] of [
          [workThreads.changingThread, "Changes allowed", "standard"],
          [workThreads.preparingThread, "No changes", "no-changes"],
        ] as const) {
          const context = yield* services.turnContext.forThread(thread);
          if (context._tag !== "active") return assert.fail();
          assert.include(context.instructions, permission);
          assert.notInclude(context.instructions, "recorded play");
          assert.equal(yield* services.constraint.forThread(thread), constraint);
        }
        assert.equal(yield* services.constraint.forThread(workThreads.directThread), "standard");
        assert.equal(
          yield* services.constraint.forThread(ThreadId.make("thread:not-a-task")),
          "standard",
        );
        // Clients read the same admitted answer from the task summary.
        const changesOf = (workThreadId: ThreadId) =>
          services.tasks
            .list({ workThreadId })
            .pipe(Effect.map(({ tasks }) => tasks.map((task) => task.changes)));
        assert.deepEqual(
          [
            yield* changesOf(workThreads.changingThread),
            yield* changesOf(workThreads.preparingThread),
            yield* changesOf(workThreads.directThread),
          ],
          [[null], ["none"], [null]],
        );
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

const report = (fields: {
  readonly status?: string;
  readonly evidence?: ReadonlyArray<string>;
  readonly openQuestions?: ReadonlyArray<string>;
}) =>
  `T3_RESULT ${JSON.stringify({
    result: "Prepared the notes.",
    status: fields.status ?? "done",
    evidence: fields.evidence ?? ["file: notes/prep.md"],
    openQuestions: fields.openQuestions ?? [],
  })}`;
/** A direct task's final answer that the result check accepts. */
const DONE_RESULT = `Prepared the notes.\n${report({})}`;

/** Ends a work thread's run with `text` as its saved final answer. */
const finishRun = (world: ThreadWorld, workThreadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const runId = RunId.make(`run:${workThreadId}`);
    const artifacts = makeSubagentConversationArtifacts({
      messageId: MessageId.make(`final:${workThreadId}`),
      turnItemId: TurnItemId.make(`final:${workThreadId}`),
      threadId: workThreadId,
      rootNodeId: NodeId.make("root"),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      role: "assistant",
      text,
      ordinal: 1,
      now: DateTime.makeUnsafe(START),
    });
    yield* Ref.update(world.records, (all) =>
      new Map(all).set(workThreadId, {
        thread: {
          id: workThreadId,
          projectId: campaign,
          deletedAt: null,
        } as OrchestrationV2ThreadProjection["thread"],
        runs: [
          {
            id: runId,
            threadId: workThreadId,
            status: "completed",
            completedAt: DateTime.makeUnsafe(START + HOUR),
          } as OrchestrationV2Run,
        ],
        messages: [{ ...artifacts.message, runId }],
        turnItems: [{ ...artifacts.turnItem, runId }],
      }),
    );
    yield* world.update(workThreadId, { status: "completed" });
  });

it.effect("a standing watch posts once per occasion and shows nothing when nothing is new", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const sql = yield* BotDatabase.BotDatabase;
    const SESSION = "2026-11-06 Session 12";
    const post = (items: ReadonlyArray<string>, occasion = SESSION) =>
      `Recap (sessions/session-11.md): Ilvara fled.\nT3_WATCH ${JSON.stringify({ occasion, items })}`;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        // Early checks on, so a result that posts asks for one and a quiet one must not.
        yield* sql`INSERT INTO bot_home_checks
          (home_thread_id, settings_revision, enabled, time_of_day, done_through, early_since, updated_at)
          VALUES (${home}, 1, 1, '08:00', ${iso(START)}, ${iso(START)}, ${iso(START)})`;
        const input = routineInput({ type: "fixed_time", timeOfDay: "18:00" });
        const { task: routine } = yield* services.routines.upsert({
          ...input,
          bot: { botId, watch: true },
        });
        assert.isTrue(routine.bot?.watch);

        /** One unattended run that ends with `text`; what the user can see of it afterwards. */
        const run = Effect.fnUntraced(function* (text: string, byHand = false) {
          yield* TestClock.adjust("1 second");
          const { threadId } = yield* services.routines.runNow(
            { id: routine.id },
            ...(byHand ? [] : [{ requestedIn: null }]),
          );
          const workThreadId = threadId ?? assert.fail("no work thread");
          const context = yield* services.turnContext.forThread(workThreadId);
          yield* finishRun(world, workThreadId, text);
          yield* services.tasks.reconcile;
          const [awareness] = yield* services.tasks.getAwarenessTasks(workThreadId);
          return {
            workThreadId,
            instructions: context._tag === "active" ? context.instructions : "",
            quiet: awareness?.quiet,
            constraint: yield* services.constraint.forThread(workThreadId),
            cards: (yield* services.tasks.list({ botId })).tasks.map((task) => task.workThreadId),
            unread: (yield* world.commandsMatching("thread.mark-unread")).length,
            archived: (yield* world.commandsMatching(`thread.archive ${workThreadId}`)).length,
            earlyCheckOutcomes: (yield* sql`SELECT task_id FROM bot_home_check_outcomes`).length,
            ownTask: (yield* services.tasks.list({ workThreadId })).tasks[0],
          };
        });

        const first = yield* run(post(["Who hired Ilvara?"]));
        assert.include(first.instructions, "standing watch");
        assert.include(first.instructions, "Already posted by this watch: nothing yet.");
        assert.deepInclude(first, {
          // Sealed like every No changes run: what it may read and never write is that seal's.
          constraint: "no-changes",
          quiet: false,
          cards: [first.workThreadId],
          unread: 1,
          archived: 0,
          earlyCheckOutcomes: 1,
        });
        const shown = yield* services.tasks.getResult({
          taskId: first.ownTask?.id ?? assert.fail(),
        });
        assert.deepInclude(shown.result, { text: "Recap (sessions/session-11.md): Ilvara fled." });

        // The same session again, reworded only in case and punctuation: nothing reaches the user.
        const repeat = yield* run(post(["who hired ilvara"]));
        assert.include(repeat.instructions, SESSION);
        assert.include(repeat.instructions, "Who hired Ilvara?");
        const nothingShown = {
          quiet: true,
          cards: [first.workThreadId],
          unread: 1,
          archived: 1,
          earlyCheckOutcomes: 1,
        };
        assert.deepInclude(repeat, nothingShown);
        // A client holding a completion notice for this thread reads the outcome from its task.
        assert.deepEqual(
          [first.ownTask?.watch, repeat.ownTask?.watch, repeat.ownTask?.status],
          [
            { state: "shown", runId: RunId.make(`run:${first.workThreadId}`) },
            { state: "quiet", runId: RunId.make(`run:${repeat.workThreadId}`) },
            "completed",
          ],
        );

        const prepared = yield* run('Session 12 is prepared.\nT3_WATCH {"new": false}');
        assert.deepInclude(prepared, nothingShown);

        // A run due while the previous one still works is skipped, and has nothing new either.
        yield* TestClock.adjust("1 second");
        const working = yield* services.routines.runNow({ id: routine.id }, { requestedIn: null });
        yield* TestClock.adjust("1 second");
        yield* services.routines.runNow({ id: routine.id }, { requestedIn: null });
        yield* finishRun(world, working.threadId ?? assert.fail(), 'T3_WATCH {"new": false}');
        yield* services.tasks.reconcile;
        assert.deepEqual(
          (yield* services.tasks.list({ botId })).tasks.map((task) => task.workThreadId),
          [first.workThreadId],
        );
        assert.lengthOf(yield* world.commandsMatching("thread.mark-unread"), 1);

        // One post per occasion: other questions and another spelling of the session change nothing.
        const reworded = yield* run(post(["Is Toma fit to travel?"], "Session 12 (2026-11-06)"));
        assert.deepInclude(reworded, { ...nothingShown, archived: 1 });

        const next = yield* run(post(["Who hired Ilvara?"], "2026-11-13 Session 13"));
        assert.deepInclude(next, {
          quiet: false,
          cards: [next.workThreadId, first.workThreadId],
          unread: 2,
          archived: 0,
          earlyCheckOutcomes: 2,
        });
        assert.deepEqual(
          yield* sql`SELECT occasion, items_json FROM bot_watch_posts ORDER BY posted_at`,
          [
            { occasion: SESSION, items_json: '["Who hired Ilvara?"]' },
            { occasion: "2026-11-13 Session 13", items_json: '["Who hired Ilvara?"]' },
          ],
        );

        // A run the user starts by hand always shows, also with nothing new.
        const byHand = yield* run('Nothing new.\nT3_WATCH {"new": false}', true);
        assert.deepInclude(byHand, { quiet: false, unread: 3, archived: 0 });
        assert.isUndefined(byHand.ownTask?.watch);

        // An editor that predates the watch saves the routine without it and keeps it. With
        // changes allowed the run is no watch: only a sealed run may stay quiet unattended.
        const edited = yield* services.routines.upsert({
          ...input,
          id: routine.id,
          bot: { botId, allowChanges: true },
        });
        assert.isTrue(edited.task.bot?.watch);
        const changing = yield* run(post(["Who hired Ilvara?"]));
        assert.notInclude(changing.instructions, "standing watch");
        assert.deepInclude(changing, { constraint: "standard", quiet: false, unread: 4 });

        // A watch repeats. Asking for a one-time watch is refused; an editor that keeps the flag
        // while making the routine one-time saves a plain routine.
        const once = {
          ...routineInput({ type: "once", runAt: iso(START + 48 * HOUR) }),
          id: routine.id,
        };
        const refused = yield* services.routines
          .upsert({ ...once, bot: { botId, allowChanges: false, watch: true } })
          .pipe(Effect.flip);
        assert.include(refused.message, "A watch needs a recurring schedule");
        const oneTime = yield* services.routines.upsert({
          ...once,
          bot: { botId, allowChanges: false },
        });
        assert.isUndefined(oneTime.task.bot?.watch);
        const storedWatch = sql<{
          readonly bot_watch: number;
        }>`SELECT bot_watch FROM bot_routines WHERE task_id = ${routine.id}`;
        assert.deepEqual(yield* storedWatch, [{ bot_watch: 0 }]);
        // A one-time watch saved before the refusal reads and runs as a plain routine.
        yield* sql`UPDATE bot_routines SET bot_watch = 1 WHERE task_id = ${routine.id}`;
        assert.isUndefined((yield* services.routines.list()).tasks[0]?.bot?.watch);
        const plain = yield* run(post(["Who hired Ilvara?"]));
        assert.notInclude(plain.instructions, "standing watch");
        assert.deepInclude(plain, { constraint: "no-changes", quiet: false, unread: 5 });

        yield* services.routines.delete({ id: routine.id });
        assert.lengthOf(yield* sql`SELECT task_id FROM bot_watch_posts`, 0);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("runs a dated preparation once and publishes its result to the home conversation", () =>
  Effect.gen(function* () {
    vi.stubEnv("TZ", "UTC");
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const runAt = START + HOUR;
    const sessionAt = START + 3 * HOUR;
    const { home, taskId, workThreadId } = yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        yield* services.routines.upsert(
          routineInput({ type: "once", runAt: iso(runAt) }, iso(sessionAt)),
        );
        const launched = yield* world.nextLaunch;
        yield* TestClock.setTime(runAt);
        yield* TestClock.adjust("6 seconds");
        const workThreadId = yield* Deferred.await(launched);
        const [task, ...others] = (yield* services.tasks.list({ botId })).tasks;
        assert.lengthOf(others, 0);
        assert.equal(task?.origin, "routine");
        assert.equal(task?.workThreadId, workThreadId);
        assert.equal(task?.homeThreadId, home);
        assert.equal((yield* services.tasks.getAwarenessTasks(workThreadId))[0]?.taskId, task?.id);
        assert.equal(task?.runtimeMode, "full-access");
        assert.equal(task?.sessionAt, iso(sessionAt));

        const context = yield* services.turnContext.forThread(workThreadId);
        assert.equal(context._tag, "active");
        if (context._tag !== "active") return assert.fail();
        assert.deepEqual(context.scope, {
          botId,
          projectId: campaign,
          homeThreadId: home,
          taskId: task?.id ?? null,
        });
        assert.include(context.instructions, "scheduled routine");
        assert.notInclude(context.instructions, "Working notes");
        assert.include(context.instructions, iso(sessionAt));
        assert.include(context.instructions, "No changes");
        assert.notInclude(context.instructions, "recorded play");
        assert.include(context.instructions, "Help prepare the campaign.");
        const homeContext = yield* services.turnContext.forThread(home);
        assert.isTrue(homeContext._tag === "active" && homeContext.scope.taskId === null);
        return { home, taskId: task?.id ?? assert.fail(), workThreadId };
      }),
    );
    const sql = yield* BotDatabase.BotDatabase;
    const notification = sql<{ readonly notified_at: string | null }>`
      SELECT notified_at FROM bot_tasks WHERE task_id = ${taskId}
    `;

    // A restart in the middle of the run neither starts nor publishes it twice.
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* services.tasks.reconcile;
        assert.equal(yield* statusOf(services, taskId), "accepted");
        yield* world.update(workThreadId, { status: "running" });
        yield* services.tasks.reconcile;
        assert.equal(yield* statusOf(services, taskId), "running");
        yield* world.update(workThreadId, { blockingRequest: true });
        yield* services.tasks.reconcile;
        assert.equal(yield* statusOf(services, taskId), "waiting");
        yield* world.update(workThreadId, { blockingRequest: false, status: "completed" });
        yield* Ref.set(world.failNext, "thread.mark-unread");
        yield* services.tasks.reconcile;
        assert.equal(yield* statusOf(services, taskId), "completed");
        assert.isNull((yield* notification)[0]?.notified_at);
        assert.lengthOf(yield* world.commandsMatching("thread.mark-unread"), 0);
        yield* services.tasks.reconcile;
        assert.isNotNull((yield* notification)[0]?.notified_at);
        yield* services.tasks.reconcile;
        const task = yield* services.tasks.get(taskId);
        assert.equal(task.status, "completed");
        assert.isNotNull(task.completedAt);
        assert.equal((yield* services.tasks.getAwarenessTasks())[0]?.taskId, task.id);
        yield* TestClock.adjust("3 minutes");
        assert.deepEqual(yield* services.tasks.getAwarenessTasks(), []);
        assert.equal((yield* services.tasks.getAwarenessTasks(workThreadId))[0]?.taskId, task.id);
        const routine = (yield* services.routines.list()).tasks[0];
        assert.isNull(routine?.nextRunAt);
      }),
    );
    assert.lengthOf(yield* world.commandsMatching(`launch ${workThreadId}`), 1);
    assert.deepEqual(yield* world.commandsMatching("thread.mark-unread"), [
      `thread.mark-unread ${home} bot-task-notify:${taskId}`,
    ]);
    assert.deepEqual(yield* Ref.get(world.notificationAttempts), [
      CommandId.make(`bot-task-notify:${taskId}`),
      CommandId.make(`bot-task-notify:${taskId}`),
    ]);
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("starts work a crash left admitted without launching it twice", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const launched = yield* world.nextLaunch;
    // The launch is accepted, then the server stops before recording it.
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        yield* Ref.set(world.hangLaunches, true);
        yield* Effect.forkScoped(
          services.tasks.start({
            botId,
            projectId: campaign,
            prompt: "Summarize the last session.",
            commandId: CommandId.make("direct-request"),
          }),
        );
        yield* Deferred.await(launched);
      }),
    );
    yield* Ref.set(world.hangLaunches, false);
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* services.tasks.reconcile;
        // Retrying the request returns the same task.
        const retried = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Summarize the last session.",
          commandId: CommandId.make("direct-request"),
        });
        assert.equal(retried.origin, "direct");
        assert.equal(retried.status, "accepted");
        assert.lengthOf((yield* services.tasks.list({ botId })).tasks, 1);
        assert.lengthOf(yield* world.commandsMatching(`launch ${retried.workThreadId}`), 1);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

const ownModel = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1",
  options: [{ id: "reasoningEffort", value: "low" }],
} satisfies ModelSelection;

const launchedSelection = (world: ThreadWorld, workThreadId: ThreadId | null) =>
  Ref.get(world.threads).pipe(
    Effect.map((threads) => threads.get(workThreadId ?? assert.fail("no work thread"))),
    Effect.map((thread) => thread?.modelSelection),
  );

it.effect("runs a direct task on its own model without changing the Bot or its Home", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const homeThreadId = yield* attachBot(services);
        const request = {
          botId,
          projectId: campaign,
          prompt: "Recap the last session carefully.",
          modelSelection: ownModel,
          commandId: CommandId.make("own-model"),
        };
        const task = yield* services.tasks.start(request);
        assert.deepEqual(yield* launchedSelection(world, task.workThreadId), ownModel);
        assert.deepEqual(task.modelSelection, ownModel);
        assert.equal(task.homeThreadId, homeThreadId);
        assert.isTrue(task.workThreadId?.startsWith(BOT_WORK_THREAD_ID_PREFIX));
        // A retry returns the same task without launching it again.
        assert.deepEqual(yield* services.tasks.start(request), task);
        assert.lengthOf(yield* world.commandsMatching(`launch ${task.workThreadId}`), 1);

        const inherited = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Recap the last session.",
        });
        assert.deepEqual(yield* launchedSelection(world, inherited.workThreadId), codex);
        assert.deepEqual(inherited.modelSelection, codex);
        const withoutOptions = {
          instanceId: ProviderInstanceId.make("codex-no-options"),
          model: "gpt-5",
        };
        const plain = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Recap without model options.",
          modelSelection: withoutOptions,
        });
        assert.deepEqual(yield* launchedSelection(world, plain.workThreadId), withoutOptions);
        assert.deepEqual((yield* services.bots.get({ botId })).modelSelection, codex);
        assert.deepEqual(yield* launchedSelection(world, homeThreadId), codex);
        assert.lengthOf(yield* world.commandsMatching("thread.model-selection.set"), 0);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("keeps each task's model when a restart comes before its launch", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const sql = yield* BotDatabase.BotDatabase;
    const taskId = BotTaskId.make("bot-task:restart-before-launch");
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const homeThreadId = yield* attachBot(services);
        // Admitted before task selections were recorded, so it follows the Bot.
        yield* sql`
          INSERT INTO bot_tasks (
            task_id, bot_id, project_id, home_thread_id, work_thread_id, origin,
            title, prompt, runtime_mode, status, created_at, updated_at
          ) VALUES (
            'bot-task:before-010', ${botId}, ${campaign}, ${homeThreadId},
            'bot-work:bot-task:before-010', 'direct', 'Older task', 'Recap.', 'full-access',
            'accepted', ${iso(START)}, ${iso(START)}
          )
        `;
        const gate = {
          stage: "before-thread" as const,
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
          // The startup reconcile may launch the older task first.
          threadId: ThreadId.make(`${BOT_WORK_THREAD_ID_PREFIX}${taskId}`),
        };
        yield* Ref.set(world.launchGate, gate);
        yield* Effect.forkScoped(
          services.tasks.start({
            botId,
            projectId: campaign,
            prompt: "Recap the last session.",
            modelSelection: ownModel,
            commandId: CommandId.make("restart-before-launch"),
          }),
        );
        // The server stops while the task is admitted and its work thread not yet created.
        yield* Deferred.await(gate.entered);
      }),
    );
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        assert.deepEqual((yield* services.tasks.get(taskId)).modelSelection, ownModel);
        yield* services.tasks.reconcile;
        const task = yield* services.tasks.get(taskId);
        assert.deepEqual(yield* launchedSelection(world, task.workThreadId), ownModel);
        const older = yield* services.tasks.get(BotTaskId.make("bot-task:before-010"));
        assert.isUndefined(older.modelSelection);
        assert.deepEqual(yield* launchedSelection(world, older.workThreadId), codex);
        assert.deepEqual((yield* services.bots.get({ botId })).modelSelection, codex);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each<{
  readonly name: string;
  readonly modelSelection: ModelSelection;
  readonly error: string;
}>([
  {
    name: "an unknown provider",
    modelSelection: { instanceId: ProviderInstanceId.make("missing"), model: "gpt-5" },
    error: "Provider instance missing is not configured.",
  },
  {
    name: "a provider Bots do not support",
    modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "gpt-5" },
    error: "Bots run on Codex, Claude and Pi providers only.",
  },
  {
    name: "a disabled provider",
    modelSelection: { instanceId: ProviderInstanceId.make("codex-off"), model: "gpt-5" },
    error: "Provider instance codex-off is disabled.",
  },
  {
    name: "a provider the project turned off",
    modelSelection: { instanceId: ProviderInstanceId.make("codex-blocked"), model: "gpt-5" },
    error: "Provider instance codex-blocked is turned off for this project.",
  },
  {
    name: "a model the provider does not offer",
    modelSelection: { ...codex, model: "gpt-9" },
    error: "Model gpt-9 is not offered by provider codex.",
  },
  {
    name: "an unavailable model catalog",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex-no-catalog"),
      model: "invented-model",
    },
    error:
      "Provider instance codex-no-catalog has no model catalog. Refresh the provider before choosing a task model.",
  },
  {
    name: "missing option metadata",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex-no-options"),
      model: "gpt-5",
      options: [{ id: "reasoningEffort", value: "low" }],
    },
    error: "Unknown option reasoningEffort; supported options: none.",
  },
  {
    name: "unavailable model capabilities",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex-null-capabilities"),
      model: "gpt-5",
      options: [{ id: "fastMode", value: true }],
    },
    error: "Unknown option fastMode; supported options: none.",
  },
  {
    name: "an unknown option",
    modelSelection: { ...codex, options: [{ id: "verbosity", value: "high" }] },
    error: "Unknown option verbosity; supported options: reasoningEffort, fastMode.",
  },
  {
    name: "an option value the model does not have",
    modelSelection: { ...codex, options: [{ id: "reasoningEffort", value: "max" }] },
    error: "Option reasoningEffort must be one of: low, high.",
  },
  {
    name: "an option given twice",
    modelSelection: {
      ...codex,
      options: [
        { id: "reasoningEffort", value: "low" },
        { id: "reasoningEffort", value: "high" },
      ],
    },
    error: "Option reasoningEffort was specified more than once.",
  },
])("refuses a task on $name before admitting it", ({ modelSelection, error }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        const refused = yield* services.tasks
          .start({ botId, projectId: campaign, prompt: "Recap.", modelSelection })
          .pipe(Effect.flip);
        assert.include(refused.message, error);
        assert.lengthOf((yield* services.tasks.list({ botId })).tasks, 0);
        assert.lengthOf(yield* world.commandsMatching(`launch ${BOT_WORK_THREAD_ID_PREFIX}`), 0);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each(["before-thread", "before-message"] as const)(
  "stops a task cancelled while its work thread is still launching (%s)",
  (stage) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* seedProject;
      const world = yield* makeThreadWorld;
      yield* withServices(world, (services) =>
        Effect.gen(function* () {
          yield* attachBot(services);
          const gate = {
            stage,
            entered: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          yield* Ref.set(world.launchGate, gate);
          const starting = yield* Effect.forkScoped(
            services.tasks.start({
              botId,
              projectId: campaign,
              prompt: "Summarize the last session.",
              commandId: CommandId.make("cancel-while-launching"),
            }),
          );
          yield* Deferred.await(gate.entered);
          // The launch is under way: no thread yet, or a thread whose run has not started.
          const taskId = BotTaskId.make("bot-task:cancel-while-launching");
          yield* services.tasks.cancel({ taskId });
          // A reconcile pass before the run is admitted must not use up the stop meant for it.
          yield* services.tasks.reconcile;
          yield* Deferred.succeed(gate.release, undefined);
          const task = yield* Fiber.join(starting);
          const workThreadId = task.workThreadId ?? assert.fail("no work thread");
          assert.equal((yield* Ref.get(world.threads)).get(workThreadId)?.status, "interrupted");
          yield* services.tasks.reconcile;
          assert.equal((yield* services.tasks.get(taskId)).status, "cancelled");
        }),
      );
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("retries a stop that failed until the cancelled task ends", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        const task = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Summarize the last session.",
        });
        const workThreadId = task.workThreadId ?? assert.fail("no work thread");
        yield* world.update(workThreadId, { status: "running" });
        yield* Ref.set(world.failNext, "thread.stop");
        yield* services.tasks.cancel({ taskId: task.id }).pipe(Effect.exit);
        assert.equal((yield* Ref.get(world.threads)).get(workThreadId)?.status, "running");
        yield* services.tasks.reconcile;
        yield* services.tasks.reconcile;
        assert.equal((yield* services.tasks.get(task.id)).status, "cancelled");
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("waits for Home's run to end before marking it unread and stops after a refusal", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const sql = yield* BotDatabase.BotDatabase;
    const notifiedAt = (taskId: string) =>
      sql<{ readonly notified_at: string | null }>`
        SELECT notified_at FROM bot_tasks WHERE task_id = ${taskId}
      `.pipe(Effect.map((rows) => rows[0]?.notified_at ?? null));
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        const [waiting, refused] = yield* Effect.forEach(
          ["Summarize the last session.", "List the open threads."],
          (prompt) => services.tasks.start({ botId, projectId: campaign, prompt }),
        );
        if (waiting === undefined || refused === undefined) return assert.fail();
        const notify = (taskId: string) => CommandId.make(`bot-task-notify:${taskId}`);
        yield* Ref.set(world.rejected, new Set([notify(refused.id)]));
        yield* world.update(home, { status: "running", runId: "run:home" });
        for (const task of [waiting, refused]) {
          yield* world.update(task.workThreadId ?? assert.fail("no work thread"), {
            status: "completed",
          });
        }

        yield* services.tasks.reconcile;
        assert.equal(yield* statusOf(services, waiting.id), "completed");
        assert.isNull(yield* notifiedAt(waiting.id));
        assert.deepEqual(yield* Ref.get(world.notificationAttempts), []);

        yield* world.update(home, { status: "completed" });
        yield* services.tasks.reconcile;
        yield* services.tasks.reconcile;
        assert.isNotNull(yield* notifiedAt(waiting.id));
        assert.isNotNull(yield* notifiedAt(refused.id));
        // The scheduler's startup pass can overlap these passes and repeat an attempt; the
        // command id makes a repeat harmless, so only which tasks were attempted is checked.
        assert.sameMembers(
          [...new Set(yield* Ref.get(world.notificationAttempts))],
          [notify(waiting.id), notify(refused.id)],
        );
        assert.deepEqual(yield* world.commandsMatching("thread.mark-unread"), [
          `thread.mark-unread ${home} ${notify(waiting.id)}`,
        ]);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("runs a routine occurrence again when a crash came before its task was admitted", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const runAt = START + HOUR;
    const routineId = yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        const { task } = yield* services.routines.upsert(
          routineInput({ type: "once", runAt: iso(runAt) }, iso(START + 3 * HOUR)),
        );
        return task.id;
      }),
    );
    // The run was marked running, then the server stopped before the Bot task was written.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE scheduled_tasks SET last_run_status = 'running', last_run_at = ${iso(runAt)}
      WHERE task_id = ${routineId}
    `;
    yield* TestClock.setTime(runAt + 60_000);
    const activate = yield* Deferred.make<void>();
    yield* withServices(
      world,
      (services) =>
        Effect.gen(function* () {
          const launched = yield* world.nextLaunch;
          yield* Deferred.succeed(activate, undefined);
          yield* Deferred.await(launched);
          const [task, ...others] = (yield* services.tasks.list({ botId })).tasks;
          assert.lengthOf(others, 0);
          assert.equal(task?.occurrenceDueAt, iso(runAt));
        }),
      Deferred.await(activate),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("skips a preparation whose session has started and coalesces missed recurring runs", () =>
  Effect.gen(function* () {
    // 18:00 here is 17:00Z, so walking the missed days in UTC would pick the wrong instant.
    vi.stubEnv("TZ", "Europe/Berlin");
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const home = yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        yield* services.routines.upsert(
          routineInput({ type: "once", runAt: iso(START + HOUR) }, iso(START + 2 * HOUR)),
        );
        yield* services.routines.upsert(routineInput({ type: "fixed_time", timeOfDay: "18:00" }));
        return home;
      }),
    );
    // The server is down for three days and comes back after the session started.
    yield* TestClock.setTime(Date.parse("2026-11-05T19:00:00.000Z"));
    const activate = yield* Deferred.make<void>();
    yield* withServices(
      world,
      (services) =>
        Effect.gen(function* () {
          const changes = yield* services.tasks.changes;
          const launched = yield* world.nextLaunch;
          yield* Deferred.succeed(activate, undefined);
          yield* Deferred.await(launched);
          yield* Stream.runDrain(changes.pipe(Stream.take(2)));
          yield* services.tasks.reconcile;

          const tasks = (yield* services.tasks.list({ botId })).tasks;
          const skipped = tasks.filter((task) => task.status === "skipped");
          assert.lengthOf(skipped, 1);
          assert.include(skipped[0]?.detail ?? "", "event had already started");
          assert.isNull(skipped[0]?.workThreadId ?? null);
          const daily = tasks.filter((task) => task.status !== "skipped");
          assert.lengthOf(daily, 1);
          assert.equal(daily[0]?.occurrenceDueAt, "2026-11-05T17:00:00.000Z");
          assert.lengthOf(
            (yield* world.commandsMatching("thread.mark-unread")).filter((entry) =>
              entry.includes(home),
            ),
            1,
          );
        }),
      Deferred.await(activate),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("skips an occurrence while the routine's previous run is still working", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        const { task: routine } = yield* services.routines.upsert(
          routineInput({ type: "interval", everyMs: HOUR }),
        );
        const first = yield* services.routines.runNow({ id: routine.id });
        assert.isNotNull(first.threadId);
        yield* TestClock.adjust("1 second");
        const second = yield* services.routines.runNow({ id: routine.id });
        assert.isNull(second.threadId);
        const tasks = (yield* services.tasks.list({ botId })).tasks;
        assert.deepEqual(
          tasks.map((task) => task.status),
          ["skipped", "accepted"],
        );
        assert.include(tasks[0]?.detail ?? "", "still working");
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("detach and archive pause routines and stop their work until resumed", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const sql = yield* BotDatabase.BotDatabase;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        const { task: routine } = yield* services.routines.upsert(
          routineInput({ type: "interval", everyMs: HOUR }),
        );
        const run = yield* services.routines.runNow({ id: routine.id });
        const workThreadId = run.threadId ?? assert.fail("no work thread");
        yield* world.update(workThreadId, { status: "running" });
        // Work that waits for an early Home check, and work a running check claimed.
        const owed = sql`INSERT INTO bot_home_check_outcomes (task_id, home_thread_id, check_message_id)
          VALUES ('owed', ${home}, NULL), ('claimed', ${home}, 'bot-home-check-early:running')`;
        const outcomes = sql`SELECT task_id FROM bot_home_check_outcomes`;
        yield* owed;

        yield* services.bots.detachProject({ botId, projectId: campaign });
        // Nothing is owed after a reattach, even one before the next scheduler tick.
        assert.deepEqual(yield* outcomes, []);
        const paused = (yield* services.routines.list()).tasks[0];
        assert.isFalse(paused?.enabled);
        assert.isNull(paused?.nextRunAt);
        assert.lengthOf(yield* world.commandsMatching(`thread.stop ${workThreadId}`), 1);
        yield* services.tasks.reconcile;
        const [task] = (yield* services.tasks.list({ botId })).tasks;
        assert.equal(task?.status, "cancelled");
        assert.equal((yield* services.turnContext.forThread(workThreadId))._tag, "inactive");
        // A detached project's task keeps No changes: its row, not the Bot, decides.
        assert.equal(yield* services.constraint.forThread(workThreadId), "no-changes");
        // A cancelled task is not announced as a result.
        assert.lengthOf(yield* world.commandsMatching("thread.mark-unread"), 0);

        const blocked = yield* services.routines
          .setEnabled({ id: routine.id, enabled: true })
          .pipe(Effect.flip);
        assert.include(blocked.message, "not attached");
        const blockedStart = yield* services.tasks
          .start({ botId, projectId: campaign, prompt: "Anything." })
          .pipe(Effect.flip);
        assert.include(blockedStart.message, "not attached");

        // Reattaching brings back the conversation but not the routine.
        yield* services.bots.attachProject({ botId, projectId: campaign });
        assert.isFalse((yield* services.routines.list()).tasks[0]?.enabled);
        assert.isTrue(
          (yield* services.routines.setEnabled({ id: routine.id, enabled: true })).task.enabled,
        );

        yield* owed;
        yield* services.bots.setArchived({ botId, archived: true });
        assert.deepEqual(yield* outcomes, []);
        assert.isFalse((yield* services.routines.list()).tasks[0]?.enabled);
        yield* services.bots.setArchived({ botId, archived: false });
        assert.isFalse((yield* services.routines.list()).tasks[0]?.enabled);
        assert.isFalse((yield* Ref.get(world.threads)).get(home)?.archived);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("keeps a routine's Bot when an editor saves it without one", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        const input = {
          ...routineInput({ type: "fixed_time", timeOfDay: "18:00" }),
          bot: { botId, allowChanges: true },
        };
        const { task } = yield* services.routines.upsert(input);
        const { bot: _bot, ...olderEditor } = input;
        const saved = yield* services.routines.upsert({
          ...olderEditor,
          id: task.id,
          title: "Renamed",
          threadId: ThreadId.make("some-thread"),
          runtimeMode: "approval-required",
        });
        assert.equal(saved.task.bot?.botId, botId);
        assert.isTrue(saved.task.bot?.allowChanges);
        const partial = yield* services.routines.upsert({ ...input, id: task.id, bot: { botId } });
        assert.isTrue(partial.task.bot?.allowChanges);
        assert.equal(saved.task.threadMode, "new_thread");
        for (const threadMode of ["continue", "fresh_session"] as const) {
          const refused = yield* services.routines
            .upsert({ ...input, id: task.id, threadMode })
            .pipe(Effect.flip);
          assert.include(refused.message, "new thread");
        }
        assert.isNull(saved.task.threadId);
        assert.equal(saved.task.runtimeMode, "full-access");
        const webhook = yield* services.routines
          .upsert({ ...olderEditor, id: task.id, schedule: { type: "webhook" } })
          .pipe(Effect.flip);
        assert.include(webhook.message, "not a webhook");
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

const DIAGNOSIS_BRIEF = "Check the session log first.";
const MAIL = McpConnectionId.make("2a2a2a2a-0000-4000-8000-00000000002a");

const enableDiagnosis = (services: Services) =>
  services.diagnosis
    .configure({
      botId,
      projectId: campaign,
      baseRevision: 0,
      enabled: true,
      brief: DIAGNOSIS_BRIEF,
    })
    .pipe(Effect.provideService(HostProcess.Platform, "darwin"));

/** Runs a routine now; its task and work thread. */
const runRoutine = Effect.fn("BotTaskServiceTest.runRoutine")(function* (
  services: Services,
  allowChanges: boolean,
) {
  const { task } = yield* services.routines.upsert({
    ...routineInput({ type: "fixed_time", timeOfDay: "18:00" }),
    bot: { botId, allowChanges },
  });
  const run = yield* services.routines.runNow({ id: task.id });
  const workThreadId = run.threadId ?? assert.fail("no work thread");
  const [routine] = (yield* services.tasks.list({ workThreadId })).tasks;
  return { taskId: routine?.id ?? assert.fail("no task"), workThreadId };
});

/** Ends the thread's first run now, in its shell and in its persisted run record. */
const endRun = Effect.fn("BotTaskServiceTest.endRun")(function* (
  world: ThreadWorld,
  threadId: ThreadId,
  status: "completed" | "failed" | "rolled_back" | "interrupted",
) {
  yield* world.update(threadId, { status });
  const completedAt = yield* DateTime.now;
  yield* Ref.update(world.records, (current) =>
    new Map(current).set(threadId, {
      thread: { id: threadId, projectId: campaign, deletedAt: null } as never,
      runs: [{ id: RunId.make(`run:${threadId}`), threadId, status, completedAt } as never],
      messages: [],
      turnItems:
        status === "completed"
          ? []
          : [
              {
                type: "error",
                status: "failed",
                runId: RunId.make(`run:${threadId}`),
                ordinal: 1,
                failure: { message: "The provider event stream closed unexpectedly." },
              } as never,
            ],
    }),
  );
});

const diagnosesOf = (services: Services, taskId: string) =>
  services.tasks
    .list({ botId })
    .pipe(Effect.map(({ tasks }) => tasks.filter((task) => task.diagnosis?.taskId === taskId)));

it.effect(
  "diagnoses a failed routine run once, without changes, across duplicates and a restart",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* seedProject;
      const world = yield* makeThreadWorld;
      const sql = yield* BotDatabase.BotDatabase;
      const failed = yield* withServices(world, (services) =>
        Effect.gen(function* () {
          const home = yield* attachBot(services);
          yield* enableDiagnosis(services);
          const routine = yield* runRoutine(services, true);
          // The Bot may use a connection and the user's own servers; a routine run gets both.
          yield* sql`INSERT INTO bot_mcp_grants (bot_id, connection_id) VALUES (${botId}, ${MAIL})`;
          yield* sql`UPDATE bots SET mcp_own_codex_servers = 1 WHERE bot_id = ${botId}`;
          yield* TestClock.adjust("1 second");
          yield* endRun(world, routine.workThreadId, "failed");
          // Passes at once stand in for the same failure delivered twice.
          yield* Effect.all([services.tasks.reconcile, services.tasks.reconcile], {
            concurrency: 2,
            discard: true,
          });
          yield* services.tasks.reconcile;
          const [diagnosis, ...others] = yield* diagnosesOf(services, routine.taskId);
          assert.lengthOf(others, 0);
          if (diagnosis === undefined) return assert.fail("no diagnosis");
          assert.deepEqual(diagnosis.diagnosis, {
            taskId: BotTaskId.make(routine.taskId),
            runId: RunId.make(`run:${routine.workThreadId}`),
            title: "Session preparation",
            workThreadId: routine.workThreadId,
          });
          assert.equal(diagnosis.origin, "routine");
          assert.isNull(diagnosis.scheduledTaskId);
          assert.equal(diagnosis.homeThreadId, home);
          assert.equal(diagnosis.projectId, campaign);
          assert.equal(
            diagnosis.runtimeMode,
            (yield* services.tasks.get(BotTaskId.make(routine.taskId))).runtimeMode,
          );
          // The routine could change things; its diagnosis cannot, on the same model.
          assert.equal(diagnosis.changes, "none");
          const diagnosisThread = diagnosis.workThreadId ?? assert.fail("no work thread");
          assert.equal(yield* services.constraint.forThread(diagnosisThread), "no-changes");
          assert.deepEqual(
            yield* launchedSelection(world, diagnosisThread),
            yield* launchedSelection(world, routine.workThreadId),
          );
          const accessOf = (id: ThreadId) =>
            services.turnContext.mcpAccessForThread({
              id,
              lineage: { parentThreadId: null, relationshipToParent: null },
              createdByThreadId: null,
            } as never);
          assert.deepInclude(yield* accessOf(routine.workThreadId), {
            connectionIds: [MAIL],
            ownCodexMcpServers: true,
          });
          assert.deepInclude(yield* accessOf(diagnosisThread), {
            connectionIds: [],
            ownCodexMcpServers: false,
          });
          const context = yield* services.turnContext.forThread(diagnosisThread);
          if (context._tag !== "active") return assert.fail("inactive diagnosis");
          assert.include(context.instructions, "diagnoses a failed run");
          const [row] = yield* sql<{ readonly prompt: string }>`
            SELECT prompt FROM bot_tasks WHERE task_id = ${diagnosis.id}
          `;
          assert.include(row?.prompt, DIAGNOSIS_BRIEF);
          assert.include(row?.prompt, routine.workThreadId);
          assert.include(
            row?.prompt,
            "error (failed): The provider event stream closed unexpectedly.",
          );
          return { ...routine, diagnosisId: diagnosis.id, diagnosisThread };
        }),
      );
      yield* withServices(world, (services) =>
        Effect.gen(function* () {
          yield* services.tasks.reconcile;
          assert.lengthOf(yield* diagnosesOf(services, failed.taskId), 1);
          // A diagnosis that fails is never diagnosed in turn.
          yield* endRun(world, failed.diagnosisThread, "failed");
          yield* services.tasks.reconcile;
          yield* services.tasks.reconcile;
          assert.equal(yield* statusOf(services, failed.diagnosisId), "failed");
          assert.lengthOf((yield* services.tasks.list({ botId })).tasks, 2);
        }),
      );
      assert.lengthOf(yield* world.commandsMatching(`launch ${failed.diagnosisThread}`), 1);
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("recovers a diagnosis across crashes before admission and before launch", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const sql = yield* BotDatabase.BotDatabase;
    const routine = yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        yield* enableDiagnosis(services);
        const routine = yield* runRoutine(services, false);
        yield* endRun(world, routine.workThreadId, "failed");
        // The failure is stored, then the server stops before admitting a diagnosis.
        yield* sql`UPDATE bot_tasks SET status = 'failed', result_run_id = ${`run:${routine.workThreadId}`},
          completed_at = ${iso(START)} WHERE task_id = ${routine.taskId}`;
        return routine;
      }),
    );
    // Before the restart, the user follows up in the failed thread.
    yield* world.update(routine.workThreadId, { status: "running", runId: "run:follow-up" });
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const launched = yield* world.nextLaunch;
        // The diagnosis is admitted and its launch accepted, then the server stops again.
        yield* Ref.set(world.hangLaunches, true);
        yield* Effect.raceFirst(
          Deferred.await(launched),
          services.tasks.reconcile.pipe(
            Effect.andThen(Effect.die("the reconcile pass launched no diagnosis")),
          ),
        );
      }),
    );
    yield* Ref.set(world.hangLaunches, false);
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* services.tasks.reconcile;
        yield* services.tasks.reconcile;
        const [diagnosis, ...others] = yield* diagnosesOf(services, routine.taskId);
        assert.lengthOf(others, 0);
        if (diagnosis === undefined) return assert.fail("no diagnosis");
        assert.equal(diagnosis.diagnosis?.runId, `run:${routine.workThreadId}`);
        const diagnosisThread = diagnosis.workThreadId ?? assert.fail("no work thread");
        assert.lengthOf(yield* world.commandsMatching(`launch ${diagnosisThread}`), 1);

        yield* world.update(diagnosisThread, { status: "running" });
        yield* services.tasks.cancel({ taskId: diagnosis.id });
        yield* services.tasks.reconcile;
        yield* services.tasks.reconcile;
        assert.equal(yield* statusOf(services, diagnosis.id), "cancelled");
        assert.lengthOf((yield* services.tasks.list({ botId })).tasks, 2);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each<{
  readonly name: string;
  readonly run: (
    services: Services,
    world: ThreadWorld,
  ) => Effect.Effect<void, BotError | ScheduledTaskError, Scope.Scope>;
}>([
  {
    name: "the rule is off",
    run: (services, world) =>
      Effect.gen(function* () {
        const routine = yield* runRoutine(services, false);
        yield* endRun(world, routine.workThreadId, "failed");
      }),
  },
  {
    name: "the rule was turned off before the run failed",
    run: (services, world) =>
      Effect.gen(function* () {
        yield* enableDiagnosis(services);
        yield* services.diagnosis.configure({
          botId,
          projectId: campaign,
          baseRevision: 1,
          enabled: false,
        });
        const routine = yield* runRoutine(services, false);
        yield* endRun(world, routine.workThreadId, "failed");
      }),
  },
  {
    name: "the rule was turned on after the run failed",
    run: (services, world) =>
      Effect.gen(function* () {
        const routine = yield* runRoutine(services, false);
        yield* endRun(world, routine.workThreadId, "failed");
        // The server reads the failure only after the rule is on.
        yield* TestClock.adjust("1 second");
        yield* enableDiagnosis(services);
      }),
  },
  {
    name: "the user rolled the run back",
    run: (services, world) =>
      Effect.gen(function* () {
        yield* enableDiagnosis(services);
        const routine = yield* runRoutine(services, false);
        yield* endRun(world, routine.workThreadId, "rolled_back");
      }),
  },
  {
    name: "the run was interrupted",
    run: (services, world) =>
      Effect.gen(function* () {
        yield* enableDiagnosis(services);
        const routine = yield* runRoutine(services, false);
        yield* endRun(world, routine.workThreadId, "interrupted");
      }),
  },
  {
    name: "the failed task was a direct request",
    run: (services, world) =>
      Effect.gen(function* () {
        yield* enableDiagnosis(services);
        const task = yield* services.tasks.start({ botId, projectId: campaign, prompt: "Fix it." });
        yield* endRun(world, task.workThreadId ?? assert.fail("no work thread"), "failed");
      }),
  },
  {
    name: "the routine run was cancelled",
    run: (services, world) =>
      Effect.gen(function* () {
        yield* enableDiagnosis(services);
        const routine = yield* runRoutine(services, false);
        yield* world.update(routine.workThreadId, { status: "running" });
        yield* services.tasks.cancel({ taskId: BotTaskId.make(routine.taskId) });
        yield* endRun(world, routine.workThreadId, "failed");
      }),
  },
  {
    name: "the Bot was archived",
    run: (services, world) =>
      Effect.gen(function* () {
        yield* enableDiagnosis(services);
        const routine = yield* runRoutine(services, false);
        yield* endRun(world, routine.workThreadId, "failed");
        yield* services.bots.setArchived({ botId, archived: true });
      }),
  },
  {
    name: "the project was detached",
    run: (services, world) =>
      Effect.gen(function* () {
        yield* enableDiagnosis(services);
        const routine = yield* runRoutine(services, false);
        yield* endRun(world, routine.workThreadId, "failed");
        yield* services.bots.detachProject({ botId, projectId: campaign });
      }),
  },
])("starts no diagnosis when $name", ({ run }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        yield* run(services, world);
        yield* services.tasks.reconcile;
        yield* services.tasks.reconcile;
        const tasks = (yield* services.tasks.list({ botId })).tasks;
        assert.lengthOf(tasks, 1);
        assert.isUndefined(tasks[0]?.diagnosis);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each<{
  readonly name: string;
  /** When early checks were turned on, null while off; default the epoch. */
  readonly early?: string | null;
  /** Runs the work; the ids of the tasks that should ask for an early Home check. */
  readonly run: (
    services: Services,
    world: ThreadWorld,
    home: ThreadId,
  ) => Effect.Effect<
    ReadonlyArray<string>,
    BotError | ScheduledTaskError,
    Scope.Scope | BotDatabase.BotDatabase
  >;
}>([
  {
    name: "a completed routine run",
    run: (services, world) =>
      Effect.gen(function* () {
        const routine = yield* runRoutine(services, true);
        yield* endRun(world, routine.workThreadId, "completed");
        return [routine.taskId];
      }),
  },
  {
    name: "a failed routine run without a diagnosis",
    run: (services, world) =>
      Effect.gen(function* () {
        const routine = yield* runRoutine(services, true);
        yield* endRun(world, routine.workThreadId, "failed");
        return [routine.taskId];
      }),
  },
  {
    name: "a failed routine run a diagnosis takes on, then the diagnosis",
    run: (services, world) =>
      Effect.gen(function* () {
        yield* enableDiagnosis(services);
        const routine = yield* runRoutine(services, true);
        yield* TestClock.adjust("1 second");
        yield* endRun(world, routine.workThreadId, "failed");
        yield* services.tasks.reconcile;
        const [diagnosis] = yield* diagnosesOf(services, routine.taskId);
        if (diagnosis?.workThreadId == null) return assert.fail("no diagnosis");
        yield* endRun(world, diagnosis.workThreadId, "completed");
        return [diagnosis.id];
      }),
  },
  {
    name: "a completed direct task",
    run: (services, world) =>
      Effect.gen(function* () {
        const task = yield* services.tasks.start({ botId, projectId: campaign, prompt: "Pick." });
        yield* endRun(world, task.workThreadId ?? assert.fail("no work thread"), "completed");
        return [task.id];
      }),
  },
  ...[false, true].map((dropped) => ({
    name: dropped
      ? "a completed direct task whose Home return is dropped"
      : "a completed direct task that returns to Home",
    run: (services: Services, world: ThreadWorld, home: ThreadId) =>
      Effect.gen(function* () {
        yield* seedHomeRun(world, home, "external-mcp");
        const task = yield* services.tasks.start(
          { botId, projectId: campaign, prompt: "Pick." },
          { returnToHomeFrom: home },
        );
        yield* world.update(home, { status: "completed" });
        yield* finishRun(world, task.workThreadId ?? assert.fail("no work thread"), DONE_RESULT);
        yield* Ref.set(world.disposeReturn, dropped);
        yield* services.tasks.reconcile;
        assert.lengthOf(yield* world.commandsMatching("bot-task.result.deliver"), 1);
        return dropped ? [task.id] : [];
      }),
  })),
  {
    name: "a failed direct task that was to return to Home",
    run: (services, world, home) =>
      Effect.gen(function* () {
        yield* seedHomeRun(world, home, "external-mcp");
        const task = yield* services.tasks.start(
          { botId, projectId: campaign, prompt: "Pick." },
          { returnToHomeFrom: home },
        );
        yield* world.update(home, { status: "completed" });
        yield* endRun(world, task.workThreadId ?? assert.fail("no work thread"), "failed");
        return [task.id];
      }),
  },
  {
    name: "a cancelled routine run",
    run: (services, world) =>
      Effect.gen(function* () {
        const routine = yield* runRoutine(services, true);
        yield* world.update(routine.workThreadId, { status: "running" });
        yield* services.tasks.cancel({ taskId: BotTaskId.make(routine.taskId) });
        yield* world.update(routine.workThreadId, { status: "cancelled" });
        return [];
      }),
  },
  {
    name: "an interrupted routine run",
    run: (services, world) =>
      Effect.gen(function* () {
        const routine = yield* runRoutine(services, true);
        yield* endRun(world, routine.workThreadId, "interrupted");
        return [];
      }),
  },
  {
    name: "a skipped routine occurrence",
    run: (_services, _world, home) =>
      Effect.gen(function* () {
        const sql = yield* BotDatabase.BotDatabase;
        const now = iso(START);
        yield* sql`INSERT INTO bot_tasks (task_id, bot_id, project_id, home_thread_id, origin, title, prompt, runtime_mode, status, completed_at, created_at, updated_at)
          VALUES ('skipped', ${botId}, ${campaign}, ${home}, 'routine', 'Prepare', 'Prepare', 'full-access', 'skipped', ${now}, ${now}, ${now})`;
        return [];
      }).pipe(Effect.orDie),
  },
  {
    name: "a completed routine run while early checks are off",
    early: null,
    run: (services, world) =>
      Effect.gen(function* () {
        const routine = yield* runRoutine(services, true);
        yield* world.update(routine.workThreadId, { status: "completed" });
        return [];
      }),
  },
  ...[false, true].map((deleted) => ({
    name: deleted
      ? "a pre-opt-in result whose work thread is deleted while Home is busy"
      : "a routine run that ended before early checks were turned on but was seen after",
    early: iso(START),
    run: (services: Services, world: ThreadWorld, home: ThreadId) =>
      Effect.gen(function* () {
        const routine = yield* runRoutine(services, true);
        const runId = RunId.make(`run:${routine.workThreadId}`);
        yield* world.update(routine.workThreadId, { status: "completed", runId });
        yield* Ref.update(world.records, (all) =>
          new Map(all).set(routine.workThreadId, {
            thread: { id: routine.workThreadId, projectId: campaign, deletedAt: null } as never,
            runs: [
              { id: runId, status: "completed", completedAt: DateTime.makeUnsafe(0) } as never,
            ],
            messages: [],
            turnItems: [],
          }),
        );
        // The busy Home holds the notification after reconcile records the completed task.
        yield* seedHomeRun(world, home);
        yield* TestClock.adjust("1 second");
        yield* services.tasks.reconcile;
        if (deleted) {
          yield* Ref.update(world.threads, (all) => {
            const next = new Map(all);
            next.delete(routine.workThreadId);
            return next;
          });
          yield* Ref.update(world.records, (all) => {
            const next = new Map(all);
            next.delete(routine.workThreadId);
            return next;
          });
        } else {
          yield* world.update(routine.workThreadId, { runId: "follow-up-run" });
        }
        yield* world.update(home, { status: "completed" });
        return [];
      }),
  })),
])("records whether $name asks for an early Home check", ({ early, run }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const sql = yield* BotDatabase.BotDatabase;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        yield* sql`INSERT INTO bot_home_checks (home_thread_id, settings_revision, enabled, time_of_day, done_through, early_since, updated_at)
          VALUES (${home}, 1, 1, '08:00', ${iso(START)}, ${early === undefined ? iso(0) : early}, ${iso(START)})`;
        const expected = yield* run(services, world, home).pipe(
          Effect.provideService(BotDatabase.BotDatabase, sql),
        );
        yield* services.tasks.reconcile;
        yield* services.tasks.reconcile;
        // Every task reached the point where its outcome is recorded.
        assert.deepEqual(yield* sql`SELECT task_id FROM bot_tasks WHERE notified_at IS NULL`, []);
        const recorded = yield* sql<{
          readonly task_id: string;
          readonly home_thread_id: string;
          readonly check_message_id: string | null;
        }>`SELECT * FROM bot_home_check_outcomes ORDER BY task_id`;
        assert.deepEqual(
          recorded,
          expected.map((taskId) => ({
            task_id: taskId,
            home_thread_id: home,
            check_message_id: null,
          })),
        );
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("saves the failure diagnosis rule only from its current revision and while active", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        const scope = { botId, projectId: campaign };
        const onLinux = Effect.provideService(HostProcess.Platform, "linux");
        const initial = yield* services.diagnosis.get(scope).pipe(onLinux);
        assert.deepInclude(initial, {
          revision: 0,
          enabled: false,
          writable: true,
          unavailableReason: "platform",
        });
        // No changes cannot be enforced there, so a diagnosis could not run.
        const unenforceable = yield* services.diagnosis
          .configure({ ...scope, baseRevision: 0, enabled: true })
          .pipe(onLinux, Effect.flip);
        assert.include(unenforceable.message, "No changes");
        const on = yield* enableDiagnosis(services);
        assert.equal(on._tag, "saved");
        const stale = yield* services.diagnosis.configure({
          ...scope,
          baseRevision: 0,
          enabled: false,
        });
        assert.equal(stale._tag, "conflict");
        const off = yield* services.diagnosis.configure({
          ...scope,
          baseRevision: 1,
          enabled: false,
        });
        if (off._tag !== "saved") return assert.fail("not saved");
        assert.deepInclude(off.view, { revision: 2, enabled: false, brief: DIAGNOSIS_BRIEF });
        yield* services.bots.setArchived({ botId, archived: true });
        const refused = yield* services.diagnosis
          .configure({ ...scope, baseRevision: 2, enabled: true })
          .pipe(Effect.flip);
        assert.include(refused.message, "archived or detached");
        assert.isFalse((yield* services.diagnosis.get(scope)).writable);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

const claude = { instanceId: ProviderInstanceId.make("claude"), model: "gpt-5" };

it.effect.each<{
  readonly setting: string;
  readonly change: string;
  /** A task loads the Bot's MCP access; everything else acts on the Home or the Bot's model. */
  readonly refusesTask: boolean;
  readonly apply: (input: {
    readonly services: Services;
    readonly home: ThreadId;
    readonly sql: SqlClient.SqlClient;
  }) => Effect.Effect<unknown, Error>;
}>([
  {
    setting: "the own servers switch",
    change: 'turn off "Use my own Codex MCP servers"',
    refusesTask: true,
    apply: ({ sql }) => sql`UPDATE bots SET mcp_own_codex_servers = 1 WHERE bot_id = ${botId}`,
  },
])(
  "keeps a Bot with $setting off Claude, and one task only if it needs it",
  ({ change, refusesTask, apply }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* seedProject;
      const world = yield* makeThreadWorld;
      const sql = yield* BotDatabase.BotDatabase;
      yield* withServices(world, (services) =>
        Effect.gen(function* () {
          const home = yield* attachBot(services);
          yield* apply({ services, home, sql }).pipe(Effect.orDie);
          const switched = yield* services.bots
            .update({ botId, modelSelection: claude })
            .pipe(Effect.flip);
          assert.include(switched.message, `Claude can't enforce some of this Bot's settings yet`);
          assert.include(switched.message, change);
          assert.deepEqual((yield* services.bots.get({ botId })).modelSelection, codex);
          const task = yield* services.tasks
            .start({ botId, projectId: campaign, prompt: "Recap.", modelSelection: claude })
            .pipe(Effect.result);
          if (refusesTask) {
            if (task._tag === "Success") return assert.fail("the task started");
            assert.include(task.failure.message, change);
          } else {
            if (task._tag === "Failure") return assert.fail(task.failure.message);
            assert.deepEqual(yield* launchedSelection(world, task.success.workThreadId), claude);
          }
        }),
      );
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("runs a Bot on Claude with what Claude can enforce, No changes included", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const sql = yield* BotDatabase.BotDatabase;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        // No changes routines, paused or active, failure diagnosis, the Home check and
        // maintenance switch along.
        yield* sql`INSERT INTO bot_home_checks
          (home_thread_id, settings_revision, enabled, time_of_day, done_through, updated_at)
          VALUES (${home}, 1, 1, '08:00', ${iso(START)}, ${iso(START)})`;
        yield* sql`INSERT INTO bot_maintenance (home_thread_id, settings_revision, enabled, updated_at)
          VALUES (${home}, 1, 1, ${iso(START)})`;
        const paused = yield* services.routines.upsert({
          ...routineInput({ type: "fixed_time", timeOfDay: "18:00" }),
          enabled: false,
        });
        yield* services.routines.upsert(routineInput({ type: "fixed_time", timeOfDay: "17:00" }));
        yield* sql`INSERT INTO bot_failure_diagnosis
          (home_thread_id, settings_revision, enabled, brief, enabled_at, updated_at)
          VALUES (${home}, 1, 1, 'Why?', ${iso(START)}, ${iso(START)})`;
        const codexBot = yield* services.bots.get({ botId });
        assert.deepEqual(Object.values(codexBot.capabilities ?? {}), [
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ]);
        // Granted connections switch along: Claude enforces them.
        yield* sql`INSERT INTO bot_mcp_grants (bot_id, connection_id) VALUES (${botId}, ${MAIL})`;

        const claudeBot = yield* services.bots.update({ botId, modelSelection: claude });
        assert.deepEqual(claudeBot.mcpGrants?.connectionIds, [MAIL]);
        assert.deepEqual(claudeBot.capabilities, {
          mcpGrants: null,
          ownMcpServers: "claude_unsupported",
          noChangesRoutines: null,
          maintenance: null,
          homeCheck: null,
          failureDiagnosis: null,
          home: null,
        });
        const task = yield* services.tasks.start({ botId, projectId: campaign, prompt: "Recap." });
        assert.deepEqual(yield* launchedSelection(world, task.workThreadId), claude);

        // The switch stays closed while Claude cannot honor it; turning it off stays open.
        const own = yield* services.bots
          .setMcpGrants({
            botId,
            expectedRevision: claudeBot.mcpGrants?.revision ?? 0,
            connectionIds: [],
            ownCodexMcpServers: true,
          })
          .pipe(Effect.flip);
        assert.include(own.message, "can't load your own Codex MCP servers");
        yield* services.bots.setMcpGrants({
          botId,
          expectedRevision: claudeBot.mcpGrants?.revision ?? 0,
          connectionIds: [],
          ownCodexMcpServers: false,
        });

        const noChanges = yield* services.routines.upsert(
          routineInput({ type: "fixed_time", timeOfDay: "19:00" }),
        );
        assert.isTrue(noChanges.task.enabled);
        const resumed = yield* services.routines.setEnabled({ id: paused.task.id, enabled: true });
        assert.isTrue(resumed.task.enabled);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("names a daily routine's runs apart, though their timestamps end alike", () =>
  Effect.sync(() => {
    // Daily runs five days apart end in the same six digits of epoch milliseconds.
    const due = Date.parse("2026-11-02T18:00:00.000Z");
    const names = [0, 5].map((days) =>
      BotTaskService.taskBranchName({
        task_id: `bot-task:routine-1:0:${due + days * 24 * HOUR}`,
        title: "Session preparation",
      }),
    );
    assert.notEqual(names[0], names[1]);
  }),
);

/** The thread a direct task launches into; its summary names it only once launched. */
const workThreadOf = (task: Pick<BotTaskSummary, "id">) =>
  ThreadId.make(`${BOT_WORK_THREAD_ID_PREFIX}${task.id}`);

const workspaceOf = (world: ThreadWorld, workThreadId: ThreadId | null | undefined) =>
  Ref.get(world.threads).pipe(
    Effect.map((threads) => threads.get(workThreadId ?? assert.fail("no work thread"))?.workspace),
  );

it.effect(
  "a task that may change files gets its own branch and worktree; a reading one stays",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* seedProject;
      const world = yield* makeThreadWorld;
      yield* withServices(world, (services) =>
        Effect.gen(function* () {
          yield* attachBot(services);
          const fresh = yield* services.tasks.start({
            botId,
            projectId: campaign,
            prompt: "Fix the typo in the intro.",
            title: "Fix the typo",
            baseBranch: "release",
          });
          const branch = fresh.branch ?? assert.fail("no branch");
          assert.match(branch, /^bot\/fix-the-typo-[0-9a-f]{8}$/);
          assert.equal(fresh.baseBranch, "release");
          // Even a new worktree is the pool's: the launch only runs its setup, and a cancelled
          // setup has nothing of its own to remove.
          assert.equal(
            yield* workspaceOf(world, fresh.workThreadId),
            `pooled /worktrees/${branch.replaceAll("/", "-")} ${branch}`,
          );
          assert.deepInclude((yield* Ref.get(world.poolTakes))[0], {
            branch,
            baseBranch: "release",
          });

          yield* Ref.set(world.poolClaims, [
            { _tag: "pooled", worktreePath: "/worktrees/bot-reused", setupNeeded: false },
          ]);
          const reused = yield* services.tasks.start({
            botId,
            projectId: campaign,
            prompt: "Add a test.",
          });
          assert.equal(
            yield* workspaceOf(world, reused.workThreadId),
            `pooled /worktrees/bot-reused ${reused.branch} without setup`,
          );

          const runRoutine = (allowChanges: boolean) =>
            services.routines
              .upsert({
                ...routineInput({ type: "fixed_time", timeOfDay: "18:00" }),
                commandId: CommandId.make(`routine-changes-${allowChanges}`),
                bot: { botId, allowChanges },
              })
              .pipe(Effect.flatMap(({ task }) => services.routines.runNow({ id: task.id })));
          const reading = yield* runRoutine(false);
          assert.equal(yield* workspaceOf(world, reading.threadId), "root");
          const changing = yield* runRoutine(true);
          assert.match(
            (yield* workspaceOf(world, changing.threadId)) ?? "",
            /^pooled \/worktrees\/bot-reused bot\/session-preparation-/,
          );
          // The reading routine never asked the pool.
          assert.lengthOf(yield* Ref.get(world.poolTakes), 3);
        }),
      );
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "a reconcile pass leaves a task being started alone, so one claim takes its worktree",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* seedProject;
      const world = yield* makeThreadWorld;
      yield* withServices(world, (services) =>
        Effect.gen(function* () {
          yield* attachBot(services);
          const gate = {
            stage: "before-thread" as const,
            entered: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          yield* Ref.set(world.launchGate, gate);
          const starting = yield* Effect.forkScoped(
            services.tasks.start({ botId, projectId: campaign, prompt: "Fix the typo." }),
          );
          yield* Deferred.await(gate.entered);
          yield* services.tasks.reconcile;
          yield* Deferred.succeed(gate.release, undefined);
          const task = yield* Fiber.join(starting);
          assert.lengthOf(yield* Ref.get(world.poolTakes), 1);
          assert.equal(task.status, "accepted");
        }),
      );
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("a task cancelled while it claims a worktree never launches into it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        const gate = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        yield* Ref.set(world.poolGate, gate);
        const starting = yield* Effect.forkScoped(
          services.tasks.start({
            botId,
            projectId: campaign,
            prompt: "Fix the typo.",
            commandId: CommandId.make("cancelled-while-claiming"),
          }),
        );
        yield* Deferred.await(gate.entered);
        const taskId = BotTaskId.make("bot-task:cancelled-while-claiming");
        yield* services.tasks.cancel({ taskId });
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(starting);
        // The launch returned without a thread; the next pass finishes the cancel.
        yield* services.tasks.reconcile;
        const task = yield* services.tasks.get(taskId);
        assert.equal(task.status, "cancelled");
        assert.isUndefined(yield* workspaceOf(world, workThreadOf(task)));
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("a task waits for a free worktree, and without Git for the other writing task", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        yield* Ref.set(world.poolClaims, [{ _tag: "full" }]);
        const waiting = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Fix the typo.",
        });
        assert.equal(waiting.status, "accepted");
        assert.include(waiting.detail, "Waiting for a free worktree");
        assert.isUndefined(yield* workspaceOf(world, workThreadOf(waiting)));
        yield* Ref.set(world.poolClaims, [
          { _tag: "pooled", worktreePath: "/worktrees/waited", setupNeeded: true },
        ]);
        yield* services.tasks.reconcile;
        const started = yield* services.tasks.get(waiting.id);
        assert.isNull(started.detail);
        assert.equal(
          yield* workspaceOf(world, workThreadOf(waiting)),
          `pooled /worktrees/waited ${started.branch}`,
        );

        yield* Ref.set(world.poolClaims, [{ _tag: "no-git" }]);
        const first = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Rename the chapter.",
        });
        assert.equal(yield* workspaceOf(world, first.workThreadId), "root");
        assert.isUndefined(first.branch);
        // Reconcile visits tasks oldest first, so the first ends before the second asks again.
        yield* TestClock.adjust("1 second");
        const second = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Rename the index.",
        });
        assert.include(second.detail, "Waiting for another task");
        assert.isUndefined(yield* workspaceOf(world, workThreadOf(second)));
        yield* world.update(first.workThreadId ?? assert.fail(), { status: "completed" });
        yield* services.tasks.reconcile;
        assert.equal(yield* workspaceOf(world, workThreadOf(second)), "root");
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "gives a worktree back once its thread is idle, keeping unfinished work on the branch",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* seedProject;
      const world = yield* makeThreadWorld;
      const sql = yield* BotDatabase.BotDatabase;
      yield* withServices(
        world,
        (services) =>
          Effect.gen(function* () {
            yield* attachBot(services);
            const task = yield* services.tasks.start({
              botId,
              projectId: campaign,
              prompt: "Fix the typo.",
            });
            const thread = task.workThreadId ?? assert.fail();
            const worktreePath = `/worktrees/${task.branch?.replaceAll("/", "-")}`;
            yield* world.update(thread, { status: "running" });
            yield* services.tasks.reconcile;
            assert.deepEqual(yield* Ref.get(world.poolParks), []);

            // Its run never started: the install may be unfinished and a cancelled setup still
            // writing, so the worktree is not reused.
            const setupOf = sql<{ readonly setup_signature: string | null }>`
              SELECT setup_signature FROM bot_tasks WHERE task_id = ${task.id}`.pipe(
              Effect.map((rows) => rows[0]?.setup_signature),
            );
            yield* sql`UPDATE bot_tasks SET setup_signature = 'lock-a' WHERE task_id = ${task.id}`;
            yield* Ref.set(world.poolSavesWork, true);
            yield* services.tasks.cancel({ taskId: task.id });
            yield* services.tasks.reconcile;
            const cancelled = yield* services.tasks.get(task.id);
            assert.deepInclude(cancelled, {
              status: "cancelled",
              branch: task.branch,
              unfinishedWork: true,
            });
            assert.deepEqual(yield* Ref.get(world.poolParks), [`${worktreePath} (removed)`]);

            // A follow-up took a worktree again at turn start; it goes back when that turn ends.
            // Once a run started, the install it set up is trusted.
            yield* sql`UPDATE bot_tasks SET setup_signature = 'lock-a' WHERE task_id = ${task.id}`;
            yield* world.update(thread, { started: true });
            yield* sql`UPDATE bot_tasks SET worktree_state = 'held' WHERE task_id = ${task.id}`;
            yield* Ref.update(world.poolHeld, (all) => new Map(all).set(thread, worktreePath));
            yield* Ref.set(world.poolSavesWork, false);
            yield* world.update(thread, { status: "running" });
            yield* services.tasks.reconcile;
            assert.lengthOf(yield* Ref.get(world.poolParks), 1);
            yield* world.update(thread, { status: "completed" });
            yield* services.tasks.reconcile;
            assert.deepEqual(yield* Ref.get(world.poolParks), [
              `${worktreePath} (removed)`,
              worktreePath,
            ]);
            assert.isTrue((yield* services.tasks.get(task.id)).unfinishedWork);
            assert.equal(yield* setupOf, "lock-a");
          }),
        // Only the passes above: a scheduled one running beside them would release once more.
        Effect.never,
      );
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("a Bot runs at most its task limit and starts waiting tasks oldest first", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const launched = (tasks: ReadonlyArray<BotTaskSummary>) =>
      Ref.get(world.threads).pipe(
        Effect.map((threads) => tasks.map((task) => threads.has(workThreadOf(task)))),
      );
    // Only the passes below run: a scheduled pass alongside them could hold a task's dispatch
    // while it still counts a slot those passes free.
    const tasks = yield* withServices(
      world,
      (services) =>
        Effect.gen(function* () {
          yield* attachBot(services);
          yield* services.bots.update({ botId, taskLimit: 2 });
          const tasks: Array<BotTaskSummary> = [];
          for (const n of [1, 2, 3, 4, 5]) {
            yield* TestClock.adjust("1 second");
            tasks.push(
              yield* services.tasks.start({ botId, projectId: campaign, prompt: `Task ${n}.` }),
            );
          }
          assert.deepEqual(yield* launched(tasks), [true, true, false, false, false]);
          assert.deepInclude(tasks[2], {
            status: "accepted",
            detail: "Waiting for a free slot: Campaign Companion runs at most 2 tasks at once.",
          });
          // Routines do not count and start on time.
          const routine = yield* runRoutine(services, false);
          assert.isTrue((yield* Ref.get(world.threads)).has(routine.workThreadId));
          // A cancelled waiting task never starts; the next one takes the free slot.
          yield* services.tasks.cancel({ taskId: tasks[2]!.id });
          yield* finishRun(world, tasks[0]!.workThreadId!, DONE_RESULT);
          yield* services.tasks.reconcile;
          assert.deepEqual(yield* launched(tasks), [true, true, false, true, false]);
          // Cancelled before it started: no thread to open on its card.
          assert.deepInclude(yield* services.tasks.get(tasks[2]!.id), {
            status: "cancelled",
            workThreadId: null,
          });
          return tasks;
        }),
      Effect.never,
    );
    // After a restart the last task still waits, and starts once a slot frees up.
    yield* withServices(
      world,
      (services) =>
        Effect.gen(function* () {
          yield* services.tasks.reconcile;
          assert.deepEqual(yield* launched(tasks), [true, true, false, true, false]);
          yield* finishRun(world, tasks[1]!.workThreadId!, DONE_RESULT);
          yield* services.tasks.reconcile;
          assert.deepEqual(yield* launched(tasks), [true, true, false, true, true]);
          assert.isNull((yield* services.tasks.get(tasks[4]!.id)).detail);
        }),
      Effect.never,
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("two tasks admitted at the same instant cannot both take the last slot", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        yield* services.bots.update({ botId, taskLimit: 1 });
        const gate = {
          stage: "before-thread" as const,
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        yield* Ref.set(world.launchGate, gate);
        // The first is still launching when the second, whose id sorts first, is admitted.
        const first = yield* Effect.forkScoped(
          services.tasks.start({
            botId,
            projectId: campaign,
            prompt: "First.",
            commandId: CommandId.make("z-first"),
          }),
        );
        yield* Deferred.await(gate.entered);
        const second = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Second.",
          commandId: CommandId.make("a-second"),
        });
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(first);
        assert.include(second.detail, "Waiting for a free slot");
        // Not launched, so it reports no thread to open.
        assert.isNull(second.workThreadId);
        assert.isFalse((yield* Ref.get(world.threads)).has(workThreadOf(second)));
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("a task cancelled while it launches keeps its slot until its thread stops", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        yield* services.bots.update({ botId, taskLimit: 1 });
        const gate = {
          stage: "before-thread" as const,
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        yield* Ref.set(world.launchGate, gate);
        const first = yield* Effect.forkScoped(
          services.tasks.start({ botId, projectId: campaign, prompt: "First." }),
        );
        yield* Deferred.await(gate.entered);
        const [launching] = (yield* services.tasks.list({ botId })).tasks;
        yield* services.tasks.cancel({ taskId: launching!.id });
        yield* TestClock.adjust("1 second");
        const second = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Second.",
        });
        assert.include(second.detail, "Waiting for a free slot");
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(first);
        // The launch made its thread and stopped it; once that run ends, the slot is free.
        yield* services.tasks.reconcile;
        assert.equal((yield* services.tasks.get(launching!.id)).status, "cancelled");
        assert.isTrue((yield* Ref.get(world.threads)).has(workThreadOf(second)));
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each([
  {
    name: "names a branch, commit and file that exist",
    text: `Prepared the notes.\n${report({ evidence: ["branch: bot/notes", "commit: 0a1b2c3", "file: notes/prep.md:4", "link: https://example.com/doc", "The session log"] })}`,
    acceptance: {
      state: "done",
      missing: [],
      checks: ["found", "found", "found", "link", "unchecked"],
    },
  },
  {
    name: "names no evidence",
    text: `Prepared the notes.\n${report({ evidence: [] })}`,
    acceptance: { state: "needs_you", missing: ["The result names no evidence."], checks: [] },
  },
  {
    name: "names a branch that does not exist",
    text: `Prepared the notes.\n${report({ evidence: ["branch: bot/missing"] })}`,
    acceptance: {
      state: "needs_you",
      missing: ["“branch: bot/missing” does not exist."],
      checks: ["missing"],
    },
  },
  {
    name: "reports itself blocked with a question",
    text: `Stuck.\n${report({ status: "blocked", openQuestions: ["Which session is next?"] })}`,
    acceptance: {
      state: "needs_you",
      missing: ["The work thread reported its status as blocked."],
      checks: ["found"],
    },
  },
  {
    name: "has no report",
    text: "Prepared the notes.",
    acceptance: {
      state: "needs_you",
      missing: ["The result did not end with a T3_RESULT line in the fixed shape."],
      checks: null,
    },
  },
] as const)("a direct task's result that $name", ({ text, acceptance: expected }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* Ref.update(world.existingEvidence, (all) => new Set([...all, "bot/notes", "0a1b2c3"]));
    const sql = yield* BotDatabase.BotDatabase;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        yield* seedHomeRun(world, home, "external-mcp");
        const started = yield* services.tasks.start(
          { botId, projectId: campaign, prompt: "Prepare the notes." },
          { returnToHomeFrom: home },
        );
        yield* world.update(home, { status: "completed" });
        yield* finishRun(world, started.workThreadId!, text);
        yield* services.tasks.reconcile;
        const task = yield* services.tasks.get(started.id);
        assert.equal(task.status, "completed");
        assert.deepInclude(task.acceptance, { state: expected.state, missing: expected.missing });
        assert.deepEqual<ReadonlyArray<string> | null>(
          task.acceptance?.report?.evidence.map((item) => item.check) ?? null,
          expected.checks,
        );
        const [awareness] = yield* services.tasks.getAwarenessTasks(started.workThreadId!);
        assert.equal(awareness?.needsYou, expected.state === "needs_you");
        // The user reads the result without the report line.
        const saved = yield* services.tasks.getResult({ taskId: task.id });
        assert.notInclude(saved.result.state === "available" ? saved.result.text : "", "T3_RESULT");
        const revisions = yield* sql<{ readonly revision_json: string }>`
          SELECT revision_json FROM bot_continuation_revisions WHERE home_thread_id = ${home}
          ORDER BY revision DESC LIMIT 1`;
        const waiting: ReadonlyArray<{
          readonly text: string;
          readonly refs: ReadonlyArray<{ readonly taskId?: string }>;
        }> = revisions[0] === undefined ? [] : JSON.parse(revisions[0].revision_json).note.waiting;
        const deliveries = yield* world.commandsMatching("bot-task.result.deliver");
        if (expected.state === "done") {
          assert.deepEqual(waiting, []);
          assert.lengthOf(deliveries, 1);
          return;
        }
        // Not done: it waits for the user and does not go back to Home.
        assert.lengthOf(deliveries, 0);
        assert.lengthOf(waiting, 1);
        assert.include(waiting[0]?.text, "“Campaign Companion: Prepare the notes.”");
        for (const missing of expected.missing) assert.include(waiting[0]?.text, missing);
        assert.deepEqual(
          waiting[0]?.refs.map((ref) => ref.taskId),
          [task.id],
        );
        // Settled once: another pass adds nothing.
        yield* services.tasks.reconcile;
        assert.lengthOf(
          yield* sql`SELECT revision FROM bot_continuation_revisions WHERE home_thread_id = ${home}`,
          1,
        );
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("keeps a worktree held while a thread sharing it runs or its setup still runs", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        const task = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Fix the typo.",
        });
        const thread = task.workThreadId ?? assert.fail();
        const work = (yield* Ref.get(world.threads)).get(thread) ?? assert.fail();
        // A side chat of the work thread works in the same folder.
        const sideChat = ThreadId.make("side-chat");
        yield* Ref.update(world.threads, (all) =>
          // Archived already, while its provider is still stopping.
          new Map(all).set(sideChat, {
            ...work,
            status: "running",
            runId: "run:side",
            archived: true,
          }),
        );
        yield* world.update(thread, { status: "completed", started: true });
        yield* services.tasks.reconcile;
        assert.equal((yield* services.tasks.get(task.id)).status, "completed");
        assert.deepEqual(yield* Ref.get(world.poolParks), []);

        // An async setup script can still install after the agent finished.
        yield* services.setups.begin({
          threadId: thread,
          branch: task.branch ?? null,
          baseRef: null,
          stages: ["setup-script", "agent"],
          fiber: null,
        });
        yield* world.update(sideChat, { status: "completed" });
        yield* services.tasks.reconcile;
        assert.deepEqual(yield* Ref.get(world.poolParks), []);

        yield* services.setups.finish(thread, "done");
        yield* services.tasks.reconcile;
        assert.deepEqual(yield* Ref.get(world.poolParks), [work.worktreePath ?? assert.fail()]);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("tells the work thread the WIP branch a release a restart interrupted saved", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const sql = yield* BotDatabase.BotDatabase;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        const task = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Fix the typo.",
        });
        const thread = task.workThreadId ?? assert.fail();
        // The pool recorded the WIP branch on the task, then the server stopped.
        const wip = `${task.branch}-wip-1`;
        yield* sql`UPDATE bot_tasks SET branch = ${wip} WHERE task_id = ${task.id}`;
        yield* world.update(thread, { status: "completed", started: true });
        // Until the thread knows the branch the task stays held, so the pass's own retry tells it.
        yield* Ref.set(world.failNext, "thread.metadata.update");
        yield* services.tasks.reconcile;
        assert.lengthOf(
          yield* world.commandsMatching(`thread.metadata.update ${thread} bot-task-wip-branch`),
          1,
        );
        assert.equal((yield* services.tasks.get(task.id)).branch, wip);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("keeps a worktree a terminal works in out of the pool until that terminal closes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const sql = yield* BotDatabase.BotDatabase;
    const fs = yield* FileSystem.FileSystem;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        const task = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Fix the typo.",
        });
        const thread = task.workThreadId ?? assert.fail();
        const worktreePath = (yield* Ref.get(world.poolHeld)).get(thread) ?? assert.fail();
        // A shell the user opened in another thread, working in a folder of this worktree.
        const shell = {
          threadId: "user-thread",
          terminalId: "zsh",
          cwd: `${worktreePath}/src`,
          worktreePath: null,
          status: "running",
          pid: 4242,
          exitCode: null,
          exitSignal: null,
          hasRunningSubprocess: false,
          label: "zsh",
          updatedAt: "2026-01-01T00:00:00.000Z",
        } as const;
        yield* world.terminalEvent({ type: "upsert", terminal: shell });
        yield* world.update(thread, { status: "completed", started: true });
        yield* services.tasks.reconcile;
        // Kept in place and out of the count; the terminal is left alone.
        assert.deepEqual(yield* Ref.get(world.poolParks), []);
        assert.deepEqual(
          [...(yield* Ref.get(world.poolKept))],
          [[thread, "has a terminal open in it"]],
        );
        const stateOf = sql<{ readonly worktree_state: string }>`
          SELECT worktree_state FROM bot_tasks WHERE task_id = ${task.id}`.pipe(
          Effect.map((rows) => rows[0]?.worktree_state),
        );
        assert.equal(yield* stateOf, "released");
        yield* services.tasks.reconcile;
        assert.deepEqual(yield* Ref.get(world.poolParks), []);

        yield* world.terminalEvent({ type: "remove", threadId: "user-thread", terminalId: "zsh" });
        yield* services.tasks.reconcile;
        assert.deepEqual(yield* Ref.get(world.poolParks), [worktreePath]);
        assert.deepEqual([...(yield* Ref.get(world.poolKept))], []);

        // A shell that opens after the check, while the worktree moves, keeps it all the same,
        // also when it names the folder that is gone by another spelling, through a symlink.
        const tmp = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "bot-task-alias-" }),
        );
        yield* fs.makeDirectory(`${tmp}/real`);
        yield* fs.symlink(`${tmp}/real`, `${tmp}/alias`);
        const nextPath = `${tmp}/alias/bot-next`;
        yield* Ref.set(world.poolClaims, [
          { _tag: "pooled", worktreePath: nextPath, setupNeeded: true },
        ]);
        const next = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Fix another typo.",
        });
        const nextThread = next.workThreadId ?? assert.fail();
        yield* Ref.set(
          world.poolMoving,
          world.terminalEvent({
            type: "upsert",
            terminal: { ...shell, cwd: `${tmp}/real/bot-next/src` },
          }),
        );
        yield* world.update(nextThread, { status: "completed", started: true });
        yield* services.tasks.reconcile;
        yield* Ref.set(world.poolMoving, Effect.void);
        assert.deepEqual(yield* Ref.get(world.poolParks), [worktreePath]);
        assert.deepEqual(
          [...(yield* Ref.get(world.poolKept))],
          [[nextThread, "has a terminal open in it"]],
        );
        yield* services.tasks.reconcile;
        assert.deepEqual(yield* Ref.get(world.poolParks), [worktreePath]);
        yield* world.terminalEvent({ type: "remove", threadId: "user-thread", terminalId: "zsh" });
        yield* services.tasks.reconcile;
        assert.deepEqual(yield* Ref.get(world.poolParks), [worktreePath, nextPath]);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("leaves a worktree from before the pool held while a terminal works in it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* seedProject;
    const world = yield* makeThreadWorld;
    const sql = yield* BotDatabase.BotDatabase;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        yield* attachBot(services);
        const task = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Fix the typo.",
        });
        const thread = task.workThreadId ?? assert.fail();
        const worktreePath = (yield* Ref.get(world.poolHeld)).get(thread) ?? assert.fail();
        // The launch made this worktree before the pool tracked them: the pool holds no row.
        yield* Ref.update(world.poolHeld, (all) => {
          const next = new Map(all);
          next.delete(thread);
          return next;
        });
        yield* world.terminalEvent({
          type: "upsert",
          terminal: {
            threadId: thread,
            terminalId: "zsh",
            cwd: worktreePath,
            worktreePath,
            status: "running",
            pid: 4242,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: false,
            label: "zsh",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        });
        yield* world.update(thread, { status: "completed", started: true });
        yield* services.tasks.reconcile;
        // Nothing records the hold, so the task keeps the worktree until the terminal is gone.
        const [state] = yield* sql<{ readonly worktree_state: string }>`
          SELECT worktree_state FROM bot_tasks WHERE task_id = ${task.id}`;
        assert.equal(state?.worktree_state, "held");
        assert.deepEqual([...(yield* Ref.get(world.poolKept))], []);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);
