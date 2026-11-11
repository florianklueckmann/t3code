import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BOT_WORK_THREAD_ID_PREFIX,
  BotId,
  BotTaskId,
  BotTaskListInput,
  type BotTaskStatus,
  CommandId,
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
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotExecutionConstraint from "./BotExecutionConstraint.ts";
import * as BotProjectGuard from "./BotProjectGuard.ts";
import * as BotService from "./BotService.ts";
import * as BotTaskService from "./BotTaskService.ts";
import * as BotTurnContext from "./BotTurnContext.ts";

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
}

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
  } | null>(null);
  const receipts = yield* Ref.make(new Set<string>());
  const notificationAttempts = yield* Ref.make<ReadonlyArray<CommandId>>([]);
  /** The next command of this type fails before it is recorded. */
  const failNext = yield* Ref.make<OrchestrationV2ServerCommand["type"] | null>(null);

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
      | "activeRunId"
      | "id"
      | "projectId"
    > = {
      id: threadId,
      projectId: thread.projectId,
      archivedAt: thread.archived ? DateTime.makeUnsafe(0) : null,
      deletedAt: null,
      modelSelection: codex,
      runtimeMode: thread.runtimeMode,
      status: thread.status,
      pendingRuntimeRequest: thread.blockingRequest
        ? { id: "request" as never, kind: "user_input" as never, createdAt: DateTime.makeUnsafe(0) }
        : null,
      pendingBackgroundTasks: Array.from({ length: thread.backgroundTasks }, () => ({}) as never),
      latestRunId: thread.runId as OrchestrationV2ThreadShell["latestRunId"],
      activeRunId: thread.status === "running" ? RunId.make(thread.runId!) : null,
    };
    return shell as OrchestrationV2ThreadShell;
  });

  const launch = Effect.fn("FakeThreads.launch")(function* (
    input: ThreadLaunchService.ThreadLaunchInput,
  ) {
    const threadId = input.threadId ?? ThreadId.make("unexpected");
    const gate = input.initialMessage === undefined ? null : yield* Ref.get(launchGate);
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
    notificationAttempts,
    deliveryLockTransactions,
    commandsMatching,
  };
});

type ThreadWorld = Effect.Success<typeof makeThreadWorld>;

const layerSupport = Layer.mergeAll(
  Layer.mock(ProjectService.ProjectService)({
    getById: (projectId: ProjectId) =>
      Effect.succeedSome({ id: projectId, deletedAt: null } as Project),
  }),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make("codex"),
      } as ProviderInstance),
  }),
  Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(CATALOG) }),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/projects",
    isScratchProject: () => Effect.succeed(false),
  }),
  Layer.mock(SecretRequests.SecretRequests)({}),
  ManagedPolicy.layerTest(),
  BotProjectGuard.layer,
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
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(BotService.layer, BotTurnContext.layer, BotExecutionConstraint.layer).pipe(
        Layer.provideMerge(
          ScheduledTaskService.layer.pipe(Layer.provide(BotTaskService.layerRoutineTarget)),
        ),
        Layer.provideMerge(BotTaskService.layer),
        Layer.provide(Layer.merge(world.threadLayer, layerSupport)),
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
              projectId: campaign,
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
        projectId: campaign,
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
    const { task, home, anchor } = yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        const anchor = yield* seedHomeRun(world, home, "external-mcp");
        const task = yield* services.tasks.start(
          {
            botId,
            projectId: campaign,
            prompt: "Prepare.",
            commandId: CommandId.make("return-home"),
          },
          { returnToHomeFrom: home },
        );
        const ordinary = yield* services.tasks.start({
          botId,
          projectId: campaign,
          prompt: "Ordinary.",
        });
        yield* world.update(ordinary.workThreadId!, { status: "completed" });
        yield* world.update(task.workThreadId!, { status: "completed" });
        yield* services.tasks.reconcile;
        return { task, home, anchor };
      }),
    );
    const runId = RunId.make(`run:${task.workThreadId}`);
    yield* Ref.update(world.records, (all) =>
      new Map(all).set(task.workThreadId!, {
        thread: {
          id: task.workThreadId!,
          projectId: campaign,
          deletedAt: null,
        } as OrchestrationV2ThreadProjection["thread"],
        runs: [
          { id: runId, threadId: task.workThreadId!, status: "completed" } as OrchestrationV2Run,
        ],
        messages: [
          {
            id: MessageId.make("result"),
            threadId: task.workThreadId!,
            runId,
            role: "assistant",
            text: "Saved answer",
            streaming: false,
            createdAt: DateTime.makeUnsafe(START),
            updatedAt: DateTime.makeUnsafe(START),
          } as OrchestrationV2ThreadProjection["messages"][number],
        ],
        turnItems: [],
      }),
    );
    const sql = yield* BotDatabase.BotDatabase;
    yield* sql`CREATE TRIGGER interrupt_return_bookkeeping BEFORE UPDATE OF return_finished_at ON bot_tasks
      BEGIN SELECT RAISE(ABORT, 'injected interruption after receipt'); END`;
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        // The saved run remains authoritative after a later work-thread turn.
        yield* world.update(task.workThreadId!, { runId: "later-run" });
        yield* world.update(home, { status: "completed" });
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
        const task = yield* services.tasks.start(
          { botId, projectId: campaign, prompt: "Prepare." },
          { returnToHomeFrom: home },
        );
        if (state === "cancelled") yield* services.tasks.cancel({ taskId: task.id });
        else
          yield* world.update(task.workThreadId!, {
            status: state === "failed" ? "failed" : "completed",
          });
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
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "gpt-5" },
    error: "Bots currently support Codex providers only.",
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
    yield* withServices(world, (services) =>
      Effect.gen(function* () {
        const home = yield* attachBot(services);
        const { task: routine } = yield* services.routines.upsert(
          routineInput({ type: "interval", everyMs: HOUR }),
        );
        const run = yield* services.routines.runNow({ id: routine.id });
        const workThreadId = run.threadId ?? assert.fail("no work thread");
        yield* world.update(workThreadId, { status: "running" });

        yield* services.bots.detachProject({ botId, projectId: campaign });
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

        yield* services.bots.setArchived({ botId, archived: true });
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
