import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BotId,
  type BotTaskStatus,
  CommandId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
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
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
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

interface FakeThread {
  readonly projectId: ProjectId;
  readonly archived: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly status: OrchestrationV2ThreadShell["status"];
  readonly blockingRequest: boolean;
  readonly backgroundTasks: number;
}

/** Stands in for the orchestrator: launches are idempotent per command id, like receipts. */
const makeThreadWorld = Effect.gen(function* () {
  const threads = yield* Ref.make(new Map<ThreadId, FakeThread>());
  const launchedCommands = yield* Ref.make(new Set<string>());
  const commands = yield* Ref.make<ReadonlyArray<string>>([]);
  const launched = yield* Ref.make<Deferred.Deferred<ThreadId> | null>(null);
  /** When set, a launch records its thread and then never returns, as a crash would leave it. */
  const hangLaunches = yield* Ref.make(false);

  const update = (threadId: ThreadId, change: Partial<FakeThread>) =>
    Ref.update(threads, (current) => {
      const thread = current.get(threadId);
      return thread === undefined
        ? current
        : new Map(current).set(threadId, { ...thread, ...change });
    });

  const dispatch = Effect.fn("FakeThreads.dispatch")(function* (
    command: OrchestrationV2ServerCommand,
  ) {
    const threadId = "threadId" in command ? command.threadId : "";
    yield* Ref.update(commands, (current) => [
      ...current,
      `${command.type} ${threadId} ${command.commandId}`,
    ]);
    if (command.type === "thread.archive") yield* update(command.threadId, { archived: true });
    if (command.type === "thread.unarchive") yield* update(command.threadId, { archived: false });
    if (command.type === "thread.stop") {
      yield* update(command.threadId, { status: "interrupted" });
    }
    return { storedEvents: [] } as never;
  });

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
    > = {
      archivedAt: thread.archived ? DateTime.makeUnsafe(0) : null,
      deletedAt: null,
      modelSelection: codex,
      runtimeMode: thread.runtimeMode,
      status: thread.status,
      pendingRuntimeRequest: thread.blockingRequest
        ? { id: "request" as never, kind: "user_input" as never, createdAt: DateTime.makeUnsafe(0) }
        : null,
      pendingBackgroundTasks: Array.from({ length: thread.backgroundTasks }, () => ({}) as never),
      latestRunId: null,
    };
    return shell as OrchestrationV2ThreadShell;
  });

  const launch = Effect.fn("FakeThreads.launch")(function* (
    input: ThreadLaunchService.ThreadLaunchInput,
  ) {
    const threadId = input.threadId ?? ThreadId.make("unexpected");
    const seen = (yield* Ref.get(launchedCommands)).has(input.commandId);
    if (!seen) {
      yield* Ref.update(launchedCommands, (current) => new Set(current).add(input.commandId));
      yield* Ref.update(threads, (current) =>
        new Map(current).set(threadId, {
          projectId: input.projectId,
          archived: false,
          runtimeMode: input.runtimeMode,
          status: input.initialMessage === undefined ? "idle" : "queued",
          blockingRequest: false,
          backgroundTasks: 0,
        }),
      );
      yield* Ref.update(commands, (current) => [...current, `launch ${threadId}`]);
    }
    const signal = yield* Ref.get(launched);
    if (signal !== null && input.initialMessage !== undefined) {
      yield* Deferred.succeed(signal, threadId);
    }
    if (yield* Ref.get(hangLaunches)) return yield* Effect.never;
    return { threadId, resumed: seen } as never;
  });

  const threadLayer = Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({ dispatch, getThreadShell }),
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

  return { threads, update, threadLayer, nextLaunch, hangLaunches, commandsMatching };
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
);

interface Services {
  readonly bots: BotService.BotService["Service"];
  readonly tasks: BotTaskService.BotTaskService["Service"];
  readonly routines: ScheduledTaskService.ScheduledTaskService["Service"];
  readonly turnContext: BotTurnContext.BotTurnContext["Service"];
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
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(BotService.layer, BotTurnContext.layer).pipe(
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
        assert.include(context.instructions, "scheduled preparation routine");
        assert.include(context.instructions, iso(sessionAt));
        assert.include(context.instructions, "If no record of play exists");
        assert.include(context.instructions, "Help prepare the campaign.");
        const homeContext = yield* services.turnContext.forThread(home);
        assert.isTrue(homeContext._tag === "active" && homeContext.scope.taskId === null);
        return { home, taskId: task?.id ?? assert.fail(), workThreadId };
      }),
    );

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
        yield* services.tasks.reconcile;
        yield* services.tasks.reconcile;
        const task = yield* services.tasks.get(taskId);
        assert.equal(task.status, "completed");
        assert.isNotNull(task.completedAt);
        const routine = (yield* services.routines.list()).tasks[0];
        assert.isNull(routine?.nextRunAt);
      }),
    );
    assert.lengthOf(yield* world.commandsMatching(`launch ${workThreadId}`), 1);
    assert.deepEqual(yield* world.commandsMatching("thread.mark-unread"), [
      `thread.mark-unread ${home} bot-task-notify:${taskId}`,
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

it.effect("skips a preparation whose session has started and coalesces missed recurring runs", () =>
  Effect.gen(function* () {
    vi.stubEnv("TZ", "UTC");
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
          assert.include(skipped[0]?.detail ?? "", "session had already started");
          assert.isNull(skipped[0]?.workThreadId ?? null);
          const daily = tasks.filter((task) => task.status !== "skipped");
          assert.lengthOf(daily, 1);
          assert.equal(daily[0]?.occurrenceDueAt, "2026-11-05T18:00:00.000Z");
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
        const input = routineInput({ type: "fixed_time", timeOfDay: "18:00" });
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
