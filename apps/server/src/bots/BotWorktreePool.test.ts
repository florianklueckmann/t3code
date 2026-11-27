import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { BOT_WORK_THREAD_ID_PREFIX, type Project, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as BotWorktreePool from "./BotWorktreePool.ts";

const projectId = ProjectId.make("project-pool");
const NOW = "2026-11-27T10:00:00.000Z";

const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const config = ServerConfig.layerTest(process.cwd(), { prefix: "bot-pool-test-" }).pipe(
  Layer.provide(platform),
);
const gitLayer = GitWorkflowService.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provide(
    Layer.effect(
      GitManager.GitManager,
      Effect.map(GitVcsDriver.GitVcsDriver, (driver) =>
        GitManager.GitManager.of({
          createWorktree: (input, options) => driver.createWorktree(input, options),
        } as GitManager.GitManager["Service"]),
      ),
    ),
  ),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(config),
  Layer.provideMerge(platform),
);
const database = Sqlite.layerMemory.pipe(Layer.provideMerge(config), Layer.provideMerge(platform));

type Pool = BotWorktreePool.BotWorktreePool["Service"];

/** A project with an `origin` remote, and the pool over it. */
const withRepository = <A, E>(
  body: (world: {
    readonly root: string;
    readonly worktrees: string;
    readonly pool: Pool;
    readonly git: (cwd: string, ...args: ReadonlyArray<string>) => Effect.Effect<string>;
    readonly write: (file: string, text: string) => Effect.Effect<void>;
    readonly exists: (file: string) => Effect.Effect<boolean>;
    readonly worktreeCount: Effect.Effect<number>;
    readonly runTask: (
      n: number,
      options?: {
        readonly baseBranch?: string;
        readonly work?: (worktreePath: string) => Effect.Effect<void>;
      },
    ) => Effect.Effect<
      {
        readonly thread: ThreadId;
        readonly branch: string;
        readonly worktreePath: string;
        readonly claim: BotWorktreePool.BotWorktreeClaim;
        readonly savedWork: boolean;
      },
      BotWorktreePool.BotWorktreePoolError
    >;
    readonly setups: () => number;
  }) => Effect.Effect<A, E, Scope.Scope | BotDatabase.BotDatabase>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const sql = yield* BotDatabase.BotDatabase;
    const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bot-pool-" });
    const root = path.join(tmp, "project");
    const origin = path.join(tmp, "origin.git");
    const worktrees = path.join(tmp, "worktrees", "project");
    const git = (cwd: string, ...args: ReadonlyArray<string>) =>
      driver.execute({ operation: "test.git", cwd, args }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.orDie,
      );
    const write = (file: string, text: string) =>
      fs
        .makeDirectory(path.dirname(file), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(file, text)), Effect.orDie);
    yield* fs.makeDirectory(worktrees, { recursive: true });
    yield* git(tmp, "init", "--bare", "-b", "main", origin);
    yield* fs.makeDirectory(root);
    yield* git(root, "init", "-b", "main");
    yield* git(root, "config", "user.email", "test@example.com");
    yield* git(root, "config", "user.name", "Test");
    yield* write(path.join(root, "README.md"), "base\n");
    yield* write(path.join(root, ".gitignore"), "node_modules/\n");
    yield* write(path.join(root, "pnpm-lock.yaml"), "lock: 1\n");
    yield* git(root, "add", "-A");
    yield* git(root, "commit", "-m", "base");
    yield* git(root, "remote", "add", "origin", origin);
    yield* git(root, "push", "-u", "origin", "main");
    yield* git(root, "remote", "set-head", "origin", "main");

    yield* sql`INSERT INTO bots (bot_id, name, instructions, model_selection_json, learning_policy, created_at, updated_at)
      VALUES ('bot', 'Bot', '', '{}', 'after_adoption', ${NOW}, ${NOW})`;

    const pool = yield* BotWorktreePool.BotWorktreePool.pipe(
      Effect.provide(
        BotWorktreePool.layer.pipe(
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              getById: () => Effect.succeedSome({ workspaceRoot: root } as Project),
            }),
          ),
        ),
      ),
    );
    let setups = 0;
    const runTask = Effect.fnUntraced(function* (
      n: number,
      options?: {
        readonly baseBranch?: string;
        readonly work?: (worktreePath: string) => Effect.Effect<void>;
      },
    ) {
      const thread = ThreadId.make(`${BOT_WORK_THREAD_ID_PREFIX}task-${n}`);
      const branch = `bot/task-${n}`;
      yield* sql`INSERT INTO bot_tasks (task_id, bot_id, project_id, home_thread_id, work_thread_id,
          origin, title, prompt, runtime_mode, status, created_at, updated_at)
        VALUES (${`task-${n}`}, 'bot', ${projectId}, 'home', ${thread}, 'direct', 'Task', 'Do it',
          'full-access', 'accepted', ${NOW}, ${NOW})`.pipe(Effect.orDie);
      const claim = yield* pool.take({
        projectId,
        workThreadId: thread,
        branch,
        baseBranch: options?.baseBranch ?? null,
      });
      let worktreePath: string;
      if (claim._tag === "create") {
        // What the thread launch does for a new worktree, setup script included.
        worktreePath = path.join(worktrees, `task-${n}`);
        yield* git(root, "worktree", "add", "-b", branch, worktreePath, claim.baseRef);
        setups++;
      } else if (claim._tag === "pooled") {
        worktreePath = claim.worktreePath;
        if (claim.setupNeeded) setups++;
      } else {
        return yield* Effect.die(`unexpected claim ${claim._tag}`);
      }
      if (options?.work !== undefined) yield* options.work(worktreePath);
      const { savedWork } = yield* pool.park({
        projectId,
        workThreadId: thread,
        worktreePath,
        commitMessage: "WIP: Task",
        wipBranch: `${branch}-wip`,
      });
      yield* sql`UPDATE bot_tasks SET worktree_state = 'released' WHERE work_thread_id = ${thread}`.pipe(
        Effect.orDie,
      );
      return { thread, branch, worktreePath, claim, savedWork };
    });
    return yield* body({
      root,
      worktrees,
      pool,
      git,
      write,
      exists: (file) => fs.exists(file).pipe(Effect.orElseSucceed(() => false)),
      worktreeCount: git(root, "worktree", "list", "--porcelain").pipe(
        Effect.map(
          (list) => list.split("\n").filter((line) => line.startsWith("worktree ")).length - 1,
        ),
      ),
      runTask,
      setups: () => setups,
    });
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(gitLayer, database)));

it.effect("ten tasks in a row share one worktree and install once until the lockfile changes", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      for (let n = 1; n <= 10; n++) {
        const { claim } = yield* world.runTask(n);
        assert.equal(claim._tag, n === 1 ? "create" : "pooled");
      }
      assert.equal(yield* world.worktreeCount, 1);
      assert.equal(world.setups(), 1);

      yield* world.write(`${world.root}/pnpm-lock.yaml`, "lock: 2\n");
      yield* world.git(world.root, "commit", "-am", "bump lockfile");
      yield* world.git(world.root, "push", "origin", "main");
      const { claim } = yield* world.runTask(11);
      assert.deepInclude(claim, { _tag: "pooled", setupNeeded: true });
      assert.equal(world.setups(), 2);

      // A task that commits a lockfile change without installing leaves the old install behind.
      const bump = yield* world.runTask(12, {
        work: (worktreePath) =>
          world
            .write(`${worktreePath}/pnpm-lock.yaml`, "lock: 3\n")
            .pipe(Effect.andThen(world.git(worktreePath, "commit", "-qam", "bump again"))),
      });
      yield* world.git(world.root, "merge", "-q", "--ff-only", bump.branch);
      yield* world.git(world.root, "push", "origin", "main");
      assert.deepInclude((yield* world.runTask(13)).claim, { _tag: "pooled", setupNeeded: true });
    }),
  ),
);

it.effect("saves unfinished work as a commit and hands the next task a clean worktree", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const first = yield* world.runTask(1, {
        work: (worktreePath) =>
          Effect.all([
            world.write(`${worktreePath}/README.md`, "edited\n"),
            world.write(`${worktreePath}/notes.txt`, "untracked\n"),
            world.write(`${worktreePath}/node_modules/cache.txt`, "ignored\n"),
          ]),
      });
      assert.isTrue(first.savedWork);
      assert.equal(
        yield* world.git(world.root, "log", "-1", "--format=%s", first.branch),
        "WIP: Task",
      );
      assert.equal(
        yield* world.git(world.root, "show", "--name-only", "--format=", first.branch),
        "README.md\nnotes.txt",
      );

      const second = yield* world.runTask(2, {
        work: (worktreePath) =>
          Effect.gen(function* () {
            assert.equal(yield* world.git(worktreePath, "status", "--porcelain"), "");
            assert.isFalse(yield* world.exists(`${worktreePath}/notes.txt`));
            assert.equal(yield* world.git(worktreePath, "show", "HEAD:README.md"), "base");
            // Ignored files such as installed dependencies stay for the next task.
            assert.isTrue(yield* world.exists(`${worktreePath}/node_modules/cache.txt`));
          }),
      });
      assert.equal(second.claim._tag, "pooled");
      assert.isFalse(second.savedWork);
    }),
  ),
);

it.effect("starts a task from the base branch it names", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.git(world.root, "switch", "-c", "release");
      yield* world.write(`${world.root}/RELEASE.md`, "release\n");
      yield* world.git(world.root, "add", "-A");
      yield* world.git(world.root, "commit", "-m", "release");
      yield* world.git(world.root, "push", "origin", "release");
      yield* world.git(world.root, "switch", "main");
      const release = yield* world.git(world.root, "rev-parse", "release");

      const created = yield* world.runTask(1, { baseBranch: "release" });
      assert.deepEqual(created.claim, { _tag: "create", baseRef: release });
      const pooled = yield* world.runTask(2, {
        baseBranch: "release",
        work: (worktreePath) =>
          world
            .git(worktreePath, "rev-parse", "HEAD")
            .pipe(Effect.map((head) => assert.equal(head, release))),
      });
      assert.equal(pooled.claim._tag, "pooled");
      const failed = yield* world.pool
        .take({
          projectId,
          workThreadId: ThreadId.make(`${BOT_WORK_THREAD_ID_PREFIX}task-1`),
          branch: "bot/missing",
          baseBranch: "missing",
        })
        .pipe(Effect.flip);
      assert.equal(failed.message, 'Base branch "missing" was not found.');
    }),
  ),
);

it.effect(
  "never overwrites an existing branch, and gives back a worktree a failed start claimed",
  () =>
    withRepository((world) =>
      Effect.gen(function* () {
        const sql = yield* BotDatabase.BotDatabase;
        yield* world.runTask(1);
        yield* world.git(world.root, "branch", "bot/taken", "main");
        const taken = yield* world.git(world.root, "rev-parse", "bot/taken");
        yield* world.git(world.root, "commit", "--allow-empty", "-m", "newer main");
        yield* world.git(world.root, "push", "origin", "main");
        const thread = ThreadId.make(`${BOT_WORK_THREAD_ID_PREFIX}taken`);
        yield* sql`INSERT INTO bot_tasks (task_id, bot_id, project_id, home_thread_id, work_thread_id,
          origin, title, prompt, runtime_mode, status, created_at, updated_at)
        VALUES ('taken', 'bot', ${projectId}, 'home', ${thread}, 'direct', 'Task', 'Do it',
          'full-access', 'accepted', ${NOW}, ${NOW})`;
        const refused = yield* world.pool
          .take({ projectId, workThreadId: thread, branch: "bot/taken", baseBranch: null })
          .pipe(Effect.flip);
        assert.equal(refused.operation, "checkout");
        assert.equal(yield* world.git(world.root, "rev-parse", "bot/taken"), taken);

        // The task fails; its release finds the claim and parks the worktree for the next task.
        const claimed = yield* world.pool.claimedPath(thread);
        assert.isNotNull(claimed);
        yield* world.pool.park({
          projectId,
          workThreadId: thread,
          worktreePath: claimed!,
          commitMessage: "WIP: Task",
          wipBranch: "bot/taken-wip",
        });
        assert.isNull(yield* world.pool.claimedPath(thread));
        assert.lengthOf(yield* world.pool.parkedPaths(projectId), 1);
        assert.equal((yield* world.runTask(2)).claim._tag, "pooled");
      }),
    ),
);

it.effect("keeps a checkout whose edits inside a submodule it cannot commit", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const library = `${world.root}-library`;
      yield* world.git(world.root, "init", "-q", "-b", "main", library);
      yield* world.write(`${library}/lib.txt`, "lib\n");
      yield* world.git(library, "add", "-A");
      yield* world.git(
        library,
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=T",
        "commit",
        "-qm",
        "lib",
      );
      yield* world.git(
        world.root,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        library,
        "lib",
      );
      yield* world.git(world.root, "commit", "-qm", "add submodule");
      yield* world.git(world.root, "push", "origin", "main");
      const task = yield* world.runTask(1, {
        work: (worktreePath) =>
          world
            .git(
              worktreePath,
              "-c",
              "protocol.file.allow=always",
              "submodule",
              "update",
              "--init",
              "-q",
            )
            .pipe(Effect.andThen(world.write(`${worktreePath}/lib/lib.txt`, "edited\n"))),
      });
      assert.isFalse(task.savedWork);
      assert.isTrue(yield* world.exists(task.worktreePath));
      assert.equal(yield* world.git(`${task.worktreePath}/lib`, "show", "HEAD:lib.txt"), "lib");
      assert.deepEqual(yield* world.pool.parkedPaths(projectId), []);
    }),
  ),
);

it.effect("keeps a new task waiting while the pool is full", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const sql = yield* BotDatabase.BotDatabase;
      for (let n = 1; n <= BotWorktreePool.BOT_WORKTREE_POOL_LIMIT + 1; n++) {
        const thread = ThreadId.make(`${BOT_WORK_THREAD_ID_PREFIX}busy-${n}`);
        yield* sql`INSERT INTO bot_tasks (task_id, bot_id, project_id, home_thread_id, work_thread_id,
            origin, title, prompt, runtime_mode, status, created_at, updated_at)
          VALUES (${`busy-${n}`}, 'bot', ${projectId}, 'home', ${thread}, 'direct', 'Task', 'Do it',
            'full-access', 'accepted', ${NOW}, ${NOW})`;
        const claim = yield* world.pool.take({
          projectId,
          workThreadId: thread,
          branch: `bot/busy-${n}`,
          baseBranch: null,
        });
        assert.equal(claim._tag, n <= BotWorktreePool.BOT_WORKTREE_POOL_LIMIT ? "create" : "full");
      }
    }),
  ),
);

it.effect("leaves a repository without a commit to the project folder", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const take = (n: number) =>
        world.pool.take({
          projectId,
          workThreadId: ThreadId.make(`${BOT_WORK_THREAD_ID_PREFIX}fresh-${n}`),
          branch: `bot/fresh-${n}`,
          baseBranch: null,
        });
      // An unborn HEAD alone is not an empty repository: main still has commits.
      yield* world.git(world.root, "symbolic-ref", "HEAD", "refs/heads/unborn");
      assert.equal((yield* take(1))._tag, "create");
      // With no commit anywhere, as right after `git init`, the task runs in the folder.
      yield* world.git(world.root, "remote", "set-head", "origin", "--delete");
      const refs = yield* world.git(world.root, "for-each-ref", "--format=%(refname)");
      for (const ref of refs.split("\n").filter(Boolean))
        yield* world.git(world.root, "update-ref", "-d", ref);
      assert.equal((yield* take(2))._tag, "no-git");
    }),
  ),
);

it.effect("puts a released task's worktree back on its branch for a follow-up", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const sql = yield* BotDatabase.BotDatabase;
      const task = yield* world.runTask(1, {
        work: (worktreePath) =>
          world
            .write(`${worktreePath}/feature.txt`, "feature\n")
            .pipe(
              Effect.andThen(world.git(worktreePath, "add", "-A")),
              Effect.andThen(world.git(worktreePath, "commit", "-m", "feature")),
            ),
      });
      assert.isFalse(yield* world.exists(task.worktreePath));
      const restored = yield* world.pool.restore({
        id: task.thread,
        projectId,
        worktreePath: task.worktreePath,
        branch: task.branch,
      });
      assert.isTrue(restored);
      assert.equal(yield* world.git(task.worktreePath, "branch", "--show-current"), task.branch);
      assert.isTrue(yield* world.exists(`${task.worktreePath}/feature.txt`));
      const [state] = yield* sql<{ readonly worktree_state: string }>`
        SELECT worktree_state FROM bot_tasks WHERE work_thread_id = ${task.thread}`;
      assert.equal(state?.worktree_state, "held");
      assert.equal(yield* world.worktreeCount, 1);
      // Another thread's worktree, or one already in place, is left to the usual restore.
      assert.isFalse(
        yield* world.pool.restore({
          id: task.thread,
          projectId,
          worktreePath: task.worktreePath,
          branch: task.branch,
        }),
      );
    }),
  ),
);

it.effect("removes a free worktree after its idle time, and all of them on clear", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.runTask(1);
      const [parked] = yield* world.pool.parkedPaths(projectId);
      assert.isDefined(parked);
      yield* TestClock.adjust(`${BotWorktreePool.BOT_WORKTREE_IDLE_DAYS - 1} days`);
      yield* world.pool.expire;
      assert.isTrue(yield* world.exists(parked!));
      yield* TestClock.adjust("2 days");
      yield* world.pool.expire;
      assert.isFalse(yield* world.exists(parked!));
      assert.equal(yield* world.worktreeCount, 0);

      yield* world.runTask(2);
      assert.equal(yield* world.pool.clear(projectId), 1);
      assert.deepEqual(yield* world.pool.parkedPaths(projectId), []);
      assert.equal(yield* world.worktreeCount, 0);
    }),
  ),
);
