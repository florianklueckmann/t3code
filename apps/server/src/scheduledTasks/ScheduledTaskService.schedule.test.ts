import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { liveThreadShell, idleThreadProjection } from "../mcp/McpToolAccess.testkit.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:edit-after-delete",
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stale-schedule",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const created = yield* service.upsert(input);
      const edit = yield* decodeUpsertInput({ ...input, requireExisting: true, title: "Edited" });
      expect((yield* service.upsert(edit)).task.title).toBe("Edited");
      yield* service.delete({ id: created.task.id });

      const failure = yield* service.upsert(edit).pipe(Effect.flip);
      expect(failure.message).toBe("Schedule task not found.");
      expect((yield* service.list()).tasks).toEqual([]);

      expect((yield* service.upsert(input)).task.id).toBe(created.task.id);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("preserves a due run when a save only pads the scheduled hour", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        commandId: "schedule-time-format",
        title: "Morning review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "9:00" },
        projectId: "project-schedule-time-format",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mcp",
      });
      const created = yield* service.upsert(input);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 1_000);
      const update = yield* decodeUpsertInput({
        ...input,
        id: created.task.id,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const updated = yield* service.upsert(update);
      expect(updated.task.nextRunAt).toBe(expectedDueAt);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expectedDueAt);

      const rescheduled = yield* service.upsert({
        ...update,
        schedule: { type: "fixed_time", timeOfDay: "09:30" },
      });
      expect(rescheduled.task.nextRunAt).toBe(
        DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { minutes: 30 }))),
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps the task list order when a toggle or edit rewrites updated_at", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = (id: string) => ({
        id,
        title: id,
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stable-order",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const listedIds = service
        .list()
        .pipe(Effect.map(({ tasks }) => tasks.map((task) => String(task.id))));

      const older = yield* service.upsert(yield* decodeUpsertInput(input("scheduled-task:older")));
      yield* TestClock.adjust("1 second");
      yield* service.upsert(yield* decodeUpsertInput(input("scheduled-task:newer")));
      const order = ["scheduled-task:newer", "scheduled-task:older"];
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const toggled = yield* service.setEnabled({ id: older.task.id, enabled: false });
      expect(toggled.task.updatedAt > older.task.updatedAt).toBe(true);
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const edit = { ...input(older.task.id), requireExisting: true, title: "Edited" };
      yield* service.upsert(yield* decodeUpsertInput({ ...edit, enabled: false }));
      expect(yield* listedIds).toEqual(order);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "idle polls still wake for tasks saved later, recorded due times, and beside far-future tasks",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
      const launched = yield* Deferred.make<string>();
      const layerDependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Deferred.succeed(launched, input.title).pipe(
              Effect.as({ threadId: "thread-idle-poll", resumed: false } as never),
            ),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        // The first poll finds no tasks and remembers that nothing is due.
        yield* TestClock.adjust("6 seconds");
        // Its year-10000+ next run sorts first as text; it must not hide the task below.
        yield* service.upsert(
          yield* decodeUpsertInput({
            title: "Far future",
            prompt: "Review the open pull requests.",
            enabled: true,
            schedule: { type: "interval", everyMs: 3e14 },
            projectId: "project-idle-poll",
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        );
        const created = yield* service.upsert(
          yield* decodeUpsertInput({
            title: "Idle poll",
            prompt: "Review the open pull requests.",
            enabled: true,
            schedule: { type: "interval", everyMs: 60_000 },
            projectId: "project-idle-poll",
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        );
        // This poll records the new task's due time; the later ones must still fire it.
        yield* TestClock.adjust("6 seconds");
        yield* TestClock.adjust("60 seconds");
        expect(yield* Deferred.await(launched)).toBe(created.task.title);
      }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  "same-project new thread",
  "cross-project default",
  "same-project default",
  "fresh session",
] as const)("keeps the Bot grant lineage for scheduled work: %s", (mode) =>
  Effect.gen(function* () {
    const home = ThreadId.make("bot-home:mail:project");
    const shell = liveThreadShell(home);
    const launches = yield* Ref.make<ThreadLaunchService.ThreadLaunchInput[]>([]);
    const shared = Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          Ref.update(launches, (all) => [...all, input]).pipe(
            Effect.as({ threadId: ThreadId.make("scheduled-child"), resumed: false } as never),
          ),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shell),
        getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
        sendToThread: () => Effect.succeed({} as never),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/synthetic/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
    );
    const scheduled = ScheduledTaskService.layer.pipe(Layer.provide(shared));
    const service = OrchestratorMcpService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          scheduled,
          shared,
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.succeedSome({
                id,
                workspaceRoot: "/synthetic/project",
                defaultModelSelection: shell.modelSelection,
              } as never),
          }),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            resolvePrimaryRemoteName: () => Effect.succeed("origin"),
            resolveDefaultBranchName: () => Effect.succeed("main"),
            resolveCommit: () => Effect.succeed({ commitSha: "synthetic-commit" }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const tasks = yield* ScheduledTaskService.ScheduledTaskService;
      const scope = {
        environmentId: EnvironmentId.make("synthetic-environment"),
        requestNamespace: "synthetic:bot-home",
        thread: {
          threadId: home,
          providerInstanceId: shell.modelSelection.instanceId,
          providerSessionId: "synthetic",
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      };
      const created = yield* mcp.scheduleTask(scope, {
        prompt: "Check the mail account granted to this Bot",
        schedule: { type: "interval", everyMs: 60000 },
        ...(mode === "same-project new thread"
          ? { bindToCurrentThread: false }
          : mode === "cross-project default"
            ? { projectId: ProjectId.make("project:other") }
            : mode === "fresh session"
              ? { bindToCurrentThread: false, freshSession: true }
              : {}),
      });
      const result = yield* tasks.runNow({ id: created.scheduledTaskId });
      const inputs = yield* Ref.get(launches);
      if (mode === "same-project default") {
        assert.equal(result.threadId, home);
        assert.equal(inputs.length, 0);
        return;
      }
      assert.equal(result.threadId, "scheduled-child");
      assert.equal(inputs.length, 1);
      assert.equal(inputs[0]?.createdByThreadId, home);
      assert.isUndefined(result.task.bot);
      yield* tasks.runNow({ id: created.scheduledTaskId });
      const repeated = yield* Ref.get(launches);
      assert.equal(repeated.length, mode === "fresh session" ? 1 : 2);
      assert.isTrue(repeated.every((input) => input.createdByThreadId === home));
    }).pipe(Effect.provide(Layer.mergeAll(service, scheduled)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["agent", "client"] as const)(
  "preserves server-controlled schedule provenance across database reopen for %s",
  (caller) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "schedule-provenance-" });
      const dbPath = path.join(directory, "statev2.sqlite");
      const creator = ThreadId.make("bot-home:mail:project");
      const forged = ThreadId.make("bot-home:forged:project");
      const launches = yield* Ref.make<ThreadLaunchService.ThreadLaunchInput[]>([]);
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        ManagedPolicy.layerTest(),
        Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Ref.update(launches, (all) => [...all, input]).pipe(
              Effect.as({ threadId: ThreadId.make("scheduled-child"), resumed: false } as never),
            ),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/synthetic/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      const persisted = () =>
        ScheduledTaskService.layer.pipe(
          Layer.provide(dependencies),
          Layer.provideMerge(SqlitePersistence.layerFromPath(dbPath)),
        );
      const input = yield* decodeUpsertInput({
        id: "schedule:provenance",
        title: "Check mail",
        prompt: "Check the granted account",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project:mail",
        threadMode: "new_thread",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdByThreadId: forged,
      });
      const id = yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert(
          input,
          caller === "agent" ? { createdByThreadId: creator } : undefined,
        );
        yield* service.upsert({ ...input, title: "Edited by a client" });
        return task.id;
      }).pipe(Effect.provide(persisted()));

      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const sql = yield* SqlClient.SqlClient;
        const rows =
          yield* sql`SELECT created_by_thread_id FROM scheduled_tasks WHERE task_id = ${id}`;
        assert.deepEqual(rows, [{ created_by_thread_id: caller === "agent" ? creator : null }]);
        for (let run = 0; run < 2; run++) {
          const result = yield* service.runNow({ id });
          assert.equal(result.threadId, "scheduled-child");
          assert.isUndefined(result.task.bot);
        }
        const inputs = yield* Ref.get(launches);
        assert.equal(inputs.length, 2);
        assert.isTrue(
          inputs.every(
            (launch) => launch.createdByThreadId === (caller === "agent" ? creator : undefined),
          ),
        );
      }).pipe(Effect.provide(persisted()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
