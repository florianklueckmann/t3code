import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { BOT_WORK_THREAD_ID_PREFIX, type Project, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Scope from "effect/Scope";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as BotWorktreePool from "./BotWorktreePool.ts";
import * as BotMigrations from "./persistence/Migrations.ts";

// Submodules here come from local folders, which Git clones only when allowed. The setting
// must reach the clone the pool's `submodule update` starts, so it goes through the environment.
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
process.env.GIT_CONFIG_VALUE_0 = "always";

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

const threadOf = (name: string) => ThreadId.make(`${BOT_WORK_THREAD_ID_PREFIX}${name}`);

/** A task row for a work thread, as BotTaskService stores it before it claims a worktree. */
const insertTask = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* BotDatabase.BotDatabase;
    const thread = threadOf(name);
    yield* sql`INSERT INTO bot_tasks (task_id, bot_id, project_id, home_thread_id, work_thread_id,
        origin, title, prompt, runtime_mode, status, created_at, updated_at)
      VALUES (${name}, 'bot', ${projectId}, 'home', ${thread}, 'direct', 'Task', 'Do it',
        'full-access', 'accepted', ${NOW}, ${NOW})`.pipe(Effect.orDie);
    return thread;
  });

const markReleased = (thread: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* BotDatabase.BotDatabase;
    yield* sql`UPDATE bot_tasks SET worktree_state = 'released' WHERE work_thread_id = ${thread}`.pipe(
      Effect.orDie,
    );
  });

/** A project with an `origin` remote, and the pool over it. */
const withRepository = <A, E>(
  body: (world: {
    readonly root: string;
    readonly worktrees: string;
    readonly pool: Pool;
    readonly git: (cwd: string, ...args: ReadonlyArray<string>) => Effect.Effect<string>;
    readonly write: (file: string, text: string) => Effect.Effect<void>;
    readonly exists: (file: string) => Effect.Effect<boolean>;
    readonly remove: (folder: string) => Effect.Effect<void>;
    readonly chmod: (file: string, mode: number) => Effect.Effect<void>;
    /** Gives the file an old modification time, as `cp -p` or an unpacked archive does. */
    readonly backdate: (file: string) => Effect.Effect<void>;
    readonly link: (target: string, at: string) => Effect.Effect<void>;
    readonly worktreeCount: Effect.Effect<number>;
    readonly take: (
      name: string,
      baseBranch?: string,
    ) => Effect.Effect<BotWorktreePool.BotWorktreeClaim, BotWorktreePool.BotWorktreePoolError>;
    readonly release: (
      name: string,
      worktreePath?: string | null,
      reuse?: boolean,
      inUse?: Effect.Effect<string | null>,
    ) => Effect.Effect<BotWorktreePool.BotWorktreeRelease, BotWorktreePool.BotWorktreePoolError>;
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
        readonly released: BotWorktreePool.BotWorktreeRelease;
      },
      BotWorktreePool.BotWorktreePoolError,
      BotDatabase.BotDatabase
    >;
    readonly setups: () => number;
  }) => Effect.Effect<A, E, Scope.Scope | BotDatabase.BotDatabase>,
  options?: {
    /** Where worktrees live, from the project folder; by default beside it. */
    readonly worktreesDirectory?: (root: string) => string;
    /** Stands in for the repository lookup. */
    readonly repositoryRoot?: GitWorkflowService.GitWorkflowService["Service"]["repositoryRoot"];
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const sql = yield* BotDatabase.BotDatabase;
    const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bot-pool-" });
    const root = path.join(tmp, "project");
    const origin = path.join(tmp, "origin.git");
    const worktreesDirectory = options?.worktreesDirectory?.(root) ?? path.join(tmp, "worktrees");
    const worktrees = path.join(worktreesDirectory, "project");
    const git = (cwd: string, ...args: ReadonlyArray<string>) =>
      driver.execute({ operation: "test.git", cwd, args }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.orDie,
      );
    const write = (file: string, text: string) =>
      fs
        .makeDirectory(path.dirname(file), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(file, text)), Effect.orDie);
    yield* git(tmp, "init", "--bare", "-b", "main", origin);
    yield* fs.makeDirectory(root);
    yield* git(root, "init", "-b", "main");
    yield* git(root, "config", "user.email", "test@example.com");
    yield* git(root, "config", "user.name", "Test");
    yield* write(path.join(root, "README.md"), "base\n");
    yield* write(path.join(root, ".gitignore"), "node_modules/\n.worktrees/\n");
    yield* write(path.join(root, "pnpm-lock.yaml"), "lock: 1\n");
    yield* git(root, "add", "-A");
    yield* git(root, "commit", "-m", "base");
    yield* git(root, "remote", "add", "origin", origin);
    yield* git(root, "push", "-u", "origin", "main");
    yield* git(root, "remote", "set-head", "origin", "main");

    yield* sql`INSERT INTO bots (bot_id, name, instructions, model_selection_json, learning_policy, created_at, updated_at)
      VALUES ('bot', 'Bot', '', '{}', 'after_adoption', ${NOW}, ${NOW})`;

    const repositoryRoot = options?.repositoryRoot;
    const pool = yield* BotWorktreePool.BotWorktreePool.pipe(
      Effect.provide(
        BotWorktreePool.layer.pipe(
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              getById: () => Effect.succeedSome({ workspaceRoot: root } as Project),
            }),
          ),
          Layer.provide(ServerSettings.layerTest({ worktreesDirectory })),
          Layer.provide(
            repositoryRoot === undefined
              ? Layer.empty
              : Layer.effect(
                  GitWorkflowService.GitWorkflowService,
                  Effect.map(GitWorkflowService.GitWorkflowService, (service) => ({
                    ...service,
                    repositoryRoot,
                  })),
                ),
          ),
        ),
      ),
    );
    let setups = 0;
    const take = (name: string, baseBranch?: string) =>
      pool.take({
        projectId,
        workThreadId: threadOf(name),
        branch: `bot/${name}`,
        baseBranch: baseBranch ?? null,
      });
    const release = (
      name: string,
      worktreePath: string | null = null,
      reuse = true,
      inUse: Effect.Effect<string | null> = Effect.succeed(null),
    ) =>
      pool.release({
        projectId,
        workThreadId: threadOf(name),
        branch: `bot/${name}`,
        worktreePath,
        commitMessage: "WIP: Task",
        wipBranch: `bot/${name}-wip-1`,
        reuse,
        inUse,
      });
    const runTask = Effect.fnUntraced(function* (
      n: number,
      options?: {
        readonly baseBranch?: string;
        readonly work?: (worktreePath: string) => Effect.Effect<void>;
      },
    ) {
      const name = `task-${n}`;
      const thread = yield* insertTask(name);
      const claim = yield* take(name, options?.baseBranch);
      if (claim._tag !== "pooled") return yield* Effect.die(`unexpected claim ${claim._tag}`);
      // What the thread launch does when the pool says the worktree needs its setup script.
      if (claim.setupNeeded) setups++;
      // Turn start asks the pool again before the agent runs; the worktree is in place.
      yield* pool.restore({
        id: thread,
        projectId,
        worktreePath: claim.worktreePath,
        branch: `bot/${name}`,
      });
      if (options?.work !== undefined) yield* options.work(claim.worktreePath);
      const released = yield* release(name);
      yield* markReleased(thread);
      return { thread, branch: `bot/${name}`, worktreePath: claim.worktreePath, claim, released };
    });
    return yield* body({
      root,
      worktrees,
      pool,
      git,
      write,
      exists: (file) => fs.exists(file).pipe(Effect.orElseSucceed(() => false)),
      remove: (folder) => fs.remove(folder, { recursive: true }).pipe(Effect.orDie),
      chmod: (file, mode) => fs.chmod(file, mode).pipe(Effect.orDie),
      backdate: (file) => fs.utimes(file, 0, 0).pipe(Effect.orDie),
      link: (target, at) => fs.symlink(target, at).pipe(Effect.orDie),
      worktreeCount: git(root, "worktree", "list", "--porcelain").pipe(
        Effect.map(
          (list) => list.split("\n").filter((line) => line.startsWith("worktree ")).length - 1,
        ),
      ),
      take,
      release,
      runTask,
      setups: () => setups,
    });
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(gitLayer, database)));

const addLibrary = (world: {
  readonly root: string;
  readonly git: (cwd: string, ...args: ReadonlyArray<string>) => Effect.Effect<string>;
  readonly write: (file: string, text: string) => Effect.Effect<void>;
}) =>
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
    yield* world.git(world.root, "submodule", "add", "-q", library, "lib");
    yield* world.git(world.root, "commit", "-qm", "add submodule");
    yield* world.git(world.root, "push", "-q", "origin", "main");
  });

it.effect("ten tasks in a row share one worktree and install once until the lockfile changes", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      for (let n = 1; n <= 10; n++) {
        const { claim } = yield* world.runTask(n);
        assert.deepInclude(claim, { _tag: "pooled", setupNeeded: n === 1 });
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

      // Lockfiles at any depth count; other changes do not.
      yield* world.write(`${world.root}/README.md`, "changed\n");
      yield* world.git(world.root, "commit", "-qam", "readme");
      yield* world.git(world.root, "push", "-q", "origin", "main");
      assert.deepInclude((yield* world.runTask(14)).claim, { _tag: "pooled", setupNeeded: false });
      yield* world.write(`${world.root}/frontend/package-lock.json`, "{}\n");
      yield* world.git(world.root, "add", "-A");
      yield* world.git(world.root, "commit", "-qm", "frontend lockfile");
      yield* world.git(world.root, "push", "-q", "origin", "main");
      assert.deepInclude((yield* world.runTask(15)).claim, { _tag: "pooled", setupNeeded: true });
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
      assert.deepEqual(first.released, { savedWork: true, savedOn: null, kept: null });
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
      assert.isFalse(second.released.savedWork);
    }),
  ),
);

it.effect(
  "a reused worktree drops files the previous branch ignored and the next one would see",
  () =>
    withRepository((world) =>
      Effect.gen(function* () {
        yield* world.runTask(1, {
          work: (worktreePath) =>
            Effect.gen(function* () {
              yield* world.write(`${worktreePath}/.gitignore`, "node_modules/\ngenerated/\n");
              yield* world.git(worktreePath, "commit", "-qam", "ignore generated");
              yield* world.write(`${worktreePath}/generated/out.txt`, "task one\n");
            }),
        });
        yield* world.runTask(2, {
          work: (worktreePath) =>
            Effect.gen(function* () {
              assert.equal(yield* world.git(worktreePath, "status", "--porcelain"), "");
              assert.isFalse(yield* world.exists(`${worktreePath}/generated/out.txt`));
            }),
        });
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
      const startsAtRelease = (worktreePath: string) =>
        world
          .git(worktreePath, "rev-parse", "HEAD")
          .pipe(Effect.map((head) => assert.equal(head, release)));

      yield* world.runTask(1, { baseBranch: "release", work: startsAtRelease });
      yield* world.runTask(2, { baseBranch: "release", work: startsAtRelease });
      yield* insertTask("missing");
      const failed = yield* world.take("missing", "missing").pipe(Effect.flip);
      assert.equal(failed.message, 'Base branch "missing" was not found.');
    }),
  ),
);

it.effect(
  "never overwrites an existing branch, and gives back a worktree a failed start claimed",
  () =>
    withRepository((world) =>
      Effect.gen(function* () {
        yield* world.runTask(1);
        yield* world.git(world.root, "branch", "bot/taken", "main");
        const taken = yield* world.git(world.root, "rev-parse", "bot/taken");
        yield* world.git(world.root, "commit", "--allow-empty", "-m", "newer main");
        yield* world.git(world.root, "push", "origin", "main");
        yield* insertTask("taken");
        const refused = yield* world.take("taken").pipe(Effect.flip);
        assert.equal(refused.operation, "checkout");
        assert.equal(yield* world.git(world.root, "rev-parse", "bot/taken"), taken);

        // The task fails; its release finds the claim and parks the worktree for the next task.
        assert.isNotNull(yield* world.pool.claimedPath(threadOf("taken")));
        yield* world.release("taken");
        assert.isNull(yield* world.pool.claimedPath(threadOf("taken")));
        assert.lengthOf((yield* world.pool.inventory(projectId)).free, 1);
        assert.equal((yield* world.runTask(2)).claim._tag, "pooled");
        assert.equal(yield* world.worktreeCount, 1);
      }),
    ),
);

it.effect("never moves a worktree into a folder in its way, so the project checkout stays", () =>
  withRepository(
    (world) =>
      Effect.gen(function* () {
        // Worktrees inside the project: a folder the move lands in finds the project's .git.
        yield* world.runTask(1);
        yield* world.write(`${world.root}/README.md`, "my edit\n");
        yield* world.write(`${world.worktrees}/bot-task-2/keep.txt`, "in the way\n");
        yield* insertTask("task-2");
        const refused = yield* world.take("task-2").pipe(Effect.flip);
        assert.equal(refused.operation, "move");
        assert.equal(yield* world.git(world.root, "branch", "--show-current"), "main");
        assert.equal(yield* world.git(world.root, "diff", "--name-only"), "README.md");
        assert.isTrue(yield* world.exists(`${world.worktrees}/bot-task-2/keep.txt`));
        // The claim never left its resting place, and goes back as it was.
        yield* world.release("task-2");
        assert.lengthOf((yield* world.pool.inventory(projectId)).free, 1);
      }),
    { worktreesDirectory: (root) => `${root}/.worktrees` },
  ),
);

it.effect("keeps a checkout whose edits inside a submodule it cannot commit", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* addLibrary(world);
      const task = yield* world.runTask(1, {
        work: (worktreePath) => world.write(`${worktreePath}/lib/lib.txt`, "edited\n"),
      });
      // Kept where it is, on its branch, with the edit: nothing reset it.
      assert.isFalse(task.released.savedWork);
      assert.isNotNull(task.released.kept);
      assert.equal(yield* world.git(task.worktreePath, "branch", "--show-current"), task.branch);
      assert.equal(
        yield* world.git(`${task.worktreePath}/lib`, "status", "--porcelain"),
        "M lib.txt",
      );
      const inventory = yield* world.pool.inventory(projectId);
      assert.deepEqual(inventory.free, []);
      assert.deepEqual(inventory.kept, [
        {
          path: task.worktreePath,
          workThreadId: task.thread,
          reason: "has uncommitted changes (1 file)",
        },
      ]);
    }),
  ),
);

it.effect("keeps a checkout whose submodule has a commit no remote has", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* addLibrary(world);
      let commit = "";
      const task = yield* world.runTask(1, {
        work: (worktreePath) =>
          Effect.gen(function* () {
            yield* world.write(`${worktreePath}/lib/lib.txt`, "local\n");
            yield* world.git(
              `${worktreePath}/lib`,
              "-c",
              "user.email=t@example.com",
              "-c",
              "user.name=T",
              "commit",
              "-qam",
              "local only",
            );
            commit = yield* world.git(`${worktreePath}/lib`, "rev-parse", "HEAD");
          }),
      });
      // The gitlink went into the WIP commit; the commit itself lives only in this checkout.
      assert.isTrue(task.released.savedWork);
      assert.include(task.released.kept ?? "", "submodule");
      assert.equal(
        yield* world.git(`${task.worktreePath}/lib`, "cat-file", "-t", commit),
        "commit",
      );
    }),
  ),
);

it.effect("a reused worktree checks out submodules, and one with submodules is not reused", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.runTask(1);
      yield* addLibrary(world);
      const second = yield* world.runTask(2, {
        work: (worktreePath) =>
          world
            .exists(`${worktreePath}/lib/lib.txt`)
            .pipe(Effect.map((present) => assert.isTrue(present, "the submodule is empty"))),
      });
      // Git cannot move a worktree with submodules; it goes away once nothing in it is unsaved.
      assert.isNull(second.released.kept);
      assert.isFalse(yield* world.exists(second.worktreePath));
      assert.equal(yield* world.worktreeCount, 0);
    }),
  ),
);

it.effect("starts from the remote's current default branch, not a stale origin/HEAD", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const origin = yield* world.git(world.root, "remote", "get-url", "origin");
      yield* world.git(world.root, "switch", "-q", "-c", "trunk");
      yield* world.git(world.root, "commit", "-q", "--allow-empty", "-m", "trunk");
      yield* world.git(world.root, "push", "-q", "origin", "trunk");
      yield* world.git(world.root, "switch", "-q", "main");
      yield* world.git(
        world.root,
        `--git-dir=${origin}`,
        "symbolic-ref",
        "HEAD",
        "refs/heads/trunk",
      );
      const trunk = yield* world.git(world.root, "rev-parse", "trunk");
      yield* world.runTask(1, {
        work: (worktreePath) =>
          world
            .git(worktreePath, "rev-parse", "HEAD")
            .pipe(Effect.map((head) => assert.equal(head, trunk))),
      });
    }),
  ),
);

it.effect("fails instead of starting from local main when the remote cannot name its default", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.git(world.root, "remote", "set-url", "origin", `${world.root}-gone.git`);
      yield* world.git(world.root, "update-ref", "-d", "refs/remotes/origin/main");
      yield* world.git(world.root, "remote", "set-head", "origin", "--delete");
      yield* insertTask("offline");
      const failed = yield* world.take("offline").pipe(Effect.flip);
      assert.equal(failed.operation, "resolve-base");
      assert.isNull(yield* world.pool.claimedPath(threadOf("offline")));
    }),
  ),
);

it.effect("fails instead of running in the project folder when Git cannot be asked", () =>
  withRepository(
    (world) =>
      Effect.gen(function* () {
        yield* insertTask("lookup");
        const failed = yield* world.take("lookup").pipe(Effect.flip);
        assert.equal(failed.operation, "resolve-repository");
      }),
    { repositoryRoot: () => Effect.fail(new Error("git crashed") as never) },
  ),
);

it.effect("names commits made on a detached HEAD on a branch of their own", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const dirty = yield* world.runTask(1, {
        work: (worktreePath) =>
          world
            .git(worktreePath, "switch", "-q", "--detach")
            .pipe(Effect.andThen(world.write(`${worktreePath}/draft.txt`, "draft\n"))),
      });
      assert.deepEqual(dirty.released, {
        savedWork: true,
        savedOn: "bot/task-1-wip-1",
        kept: null,
      });
      assert.equal(
        yield* world.git(world.root, "log", "-1", "--format=%s", "bot/task-1-wip-1"),
        "WIP: Task",
      );

      // Nothing to commit, but the commit is on no branch until the release names it.
      let commit = "";
      const clean = yield* world.runTask(2, {
        work: (worktreePath) =>
          Effect.gen(function* () {
            yield* world.git(worktreePath, "switch", "-q", "--detach");
            yield* world.write(`${worktreePath}/detached.txt`, "detached\n");
            yield* world.git(worktreePath, "add", "-A");
            yield* world.git(worktreePath, "commit", "-qm", "detached work");
            commit = yield* world.git(worktreePath, "rev-parse", "HEAD");
          }),
      });
      assert.deepEqual(clean.released, {
        savedWork: false,
        savedOn: "bot/task-2-wip-1",
        kept: null,
      });
      assert.equal(yield* world.git(world.root, "rev-parse", "bot/task-2-wip-1"), commit);

      // A release a restart stopped after it committed the work on its WIP branch still names it,
      // on the task too, which is how the thread learns the branch.
      const sql = yield* BotDatabase.BotDatabase;
      const thread = yield* insertTask("task-3");
      const claim = yield* world.take("task-3");
      const worktreePath = claim._tag === "pooled" ? claim.worktreePath : "";
      yield* world.git(worktreePath, "switch", "-q", "-c", "bot/task-3-wip-1");
      yield* world.write(`${worktreePath}/draft.txt`, "draft\n");
      yield* world.git(worktreePath, "add", "-A");
      yield* world.git(worktreePath, "commit", "-qm", "WIP: Task");
      assert.deepEqual(yield* world.release("task-3"), {
        savedWork: false,
        savedOn: "bot/task-3-wip-1",
        kept: null,
      });
      const [task] = yield* sql<{ readonly branch: string | null }>`
        SELECT branch FROM bot_tasks WHERE work_thread_id = ${thread}`;
      assert.equal(task?.branch, "bot/task-3-wip-1");
    }),
  ),
);

it.effect("starts from a local base branch even when a tag has its name", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.git(world.root, "branch", "local-only", "main");
      const branchCommit = yield* world.git(world.root, "rev-parse", "local-only");
      yield* world.git(world.root, "commit", "-q", "--allow-empty", "-m", "later");
      yield* world.git(world.root, "tag", "local-only");
      const startsAtBranch = (worktreePath: string) =>
        world
          .git(worktreePath, "rev-parse", "HEAD")
          .pipe(Effect.map((head) => assert.equal(head, branchCommit)));
      yield* world.runTask(1, { baseBranch: "local-only", work: startsAtBranch });
      yield* world.runTask(2, { baseBranch: "local-only", work: startsAtBranch });
    }),
  ),
);

it.effect("keeps a new task waiting while the pool is full", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      for (let n = 1; n <= BotWorktreePool.BOT_WORKTREE_POOL_LIMIT + 1; n++) {
        yield* insertTask(`busy-${n}`);
        const claim = yield* world.take(`busy-${n}`);
        assert.equal(claim._tag, n <= BotWorktreePool.BOT_WORKTREE_POOL_LIMIT ? "pooled" : "full");
      }
    }),
  ),
);

it.effect("keeps a worktree whose .git it cannot read instead of forgetting it", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* insertTask("unreadable");
      const claim = yield* world.take("unreadable");
      const worktreePath = claim._tag === "pooled" ? claim.worktreePath : "";
      yield* world.write(`${worktreePath}/.git`, "gitdir: /nowhere\n");
      assert.isNotNull((yield* world.release("unreadable")).kept);
      assert.equal(yield* world.pool.claimedPath(threadOf("unreadable")), worktreePath);
      assert.isTrue(yield* world.exists(worktreePath));
    }),
  ),
);

it.effect("starts from a detached project HEAD no branch holds without piling up worktrees", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.git(world.root, "remote", "remove", "origin");
      yield* world.git(world.root, "branch", "-m", "main", "trunk");
      yield* world.git(world.root, "switch", "-q", "--detach");
      yield* world.git(world.root, "commit", "-q", "--allow-empty", "-m", "on no branch");
      yield* world.runTask(1);
      assert.equal(yield* world.worktreeCount, 1);
    }),
  ),
);

it.effect("brings a follow-up's worktree into a folder whose parent is gone", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const task = yield* world.runTask(1);
      yield* world.runTask(2);
      const elsewhere = `${world.root}-moved/project/bot-task-1`;
      assert.isTrue(
        yield* world.pool.restore({
          id: task.thread,
          projectId,
          worktreePath: elsewhere,
          branch: task.branch,
        }),
      );
      assert.equal(yield* world.git(elsewhere, "branch", "--show-current"), task.branch);
    }),
  ),
);

it.effect("a worktree kept for an open terminal is neither handed out nor counted", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const thread = yield* insertTask("terminal");
      const claim = yield* world.take("terminal");
      const worktreePath = claim._tag === "pooled" ? claim.worktreePath : "";
      yield* world.pool.keep({ workThreadId: thread, reason: "has a terminal open in it" });
      yield* markReleased(thread);
      assert.deepEqual(yield* world.pool.keptClaims, [
        { path: worktreePath, workThreadId: thread, reason: "has a terminal open in it" },
      ]);
      // The next tasks never get it, and it leaves the limit's worth of room.
      for (let n = 1; n <= BotWorktreePool.BOT_WORKTREE_POOL_LIMIT; n++) {
        yield* insertTask(`next-${n}`);
        const next = yield* world.take(`next-${n}`);
        assert.equal(next._tag, "pooled");
        assert.notEqual(next._tag === "pooled" ? next.worktreePath : "", worktreePath);
      }
      // Once the terminal is gone it is released like any other; with the pool full that removes
      // it, since it no longer counted as held.
      yield* world.release("terminal");
      assert.deepEqual(yield* world.pool.keptClaims, []);
      assert.isFalse(yield* world.exists(worktreePath));
      assert.equal(yield* world.worktreeCount, BotWorktreePool.BOT_WORKTREE_POOL_LIMIT);

      // With room, it is parked.
      yield* world.release("next-1");
      yield* markReleased(threadOf("next-1"));
      const again = yield* insertTask("terminal-again");
      const reclaimed = yield* world.take("terminal-again");
      yield* world.pool.keep({ workThreadId: again, reason: "has a terminal open in it" });
      yield* markReleased(again);
      yield* world.release("terminal-again");
      assert.isFalse(
        yield* world.exists(reclaimed._tag === "pooled" ? reclaimed.worktreePath : ""),
      );
      assert.lengthOf((yield* world.pool.inventory(projectId)).free, 1);
    }),
  ),
);

it.effect("a terminal that opened while release moved the worktree keeps it out of the pool", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const thread = yield* insertTask("terminal");
      const claim = yield* world.take("terminal");
      const worktreePath = claim._tag === "pooled" ? claim.worktreePath : "";
      // The caller found no terminal before; one opened in the folder while the worktree moved.
      const opened = Effect.gen(function* () {
        assert.isFalse(yield* world.exists(worktreePath));
        return "has a terminal open in it";
      });
      const released = yield* world.release("terminal", null, true, opened);
      assert.equal(released.kept, "has a terminal open in it");
      yield* markReleased(thread);
      assert.deepEqual(yield* world.pool.keptClaims, [
        { path: worktreePath, workThreadId: thread, reason: "has a terminal open in it" },
      ]);
      yield* insertTask("next");
      assert.equal((yield* world.take("next"))._tag, "pooled");
      assert.equal(yield* world.worktreeCount, 2);
      // Once the terminal is gone, it is freed where it rests.
      yield* world.release("terminal");
      assert.deepEqual(yield* world.pool.keptClaims, []);
      assert.lengthOf((yield* world.pool.inventory(projectId)).free, 1);
    }),
  ),
);

it.effect("a new worktree never takes over another checkout already at the task's folder", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const theirs = `${world.worktrees}/bot-mine`;
      yield* world.git(world.root, "worktree", "add", "-q", "-b", "theirs", theirs, "main");
      yield* insertTask("mine");
      const refused = yield* world.take("mine").pipe(Effect.flip);
      assert.equal(refused.operation, "move");
      assert.equal(yield* world.git(theirs, "branch", "--show-current"), "theirs");
    }),
  ),
);

it.effect("a claim a restart stopped after its switch still cleans up before the task runs", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const sql = yield* BotDatabase.BotDatabase;
      yield* world.runTask(1, {
        work: (worktreePath) =>
          Effect.gen(function* () {
            yield* world.write(`${worktreePath}/.gitignore`, "node_modules/\ngenerated/\n");
            yield* world.git(worktreePath, "commit", "-qam", "ignore generated");
            yield* world.write(`${worktreePath}/generated/out.txt`, "task one\n");
          }),
      });
      // What the claim had done when the server stopped: noted the clean-up, moved, switched.
      const thread = yield* insertTask("task-2");
      const [row] = yield* sql<{ readonly path: string }>`SELECT path FROM bot_worktrees`;
      const target = `${world.worktrees}/bot-task-2`;
      yield* sql`UPDATE bot_worktrees SET claimed_by = ${thread}, claimed_path = ${target},
        pending_clean = '["generated/"]'`;
      yield* sql`UPDATE bot_tasks SET worktree_state = 'held' WHERE work_thread_id = ${thread}`;
      yield* world.git(world.root, "worktree", "move", row!.path, target);
      const gitDir = yield* world.git(target, "rev-parse", "--absolute-git-dir");
      yield* world.write(`${gitDir}/t3-bot-switch`, "");
      yield* world.git(target, "switch", "-q", "-c", "bot/task-2", "origin/main");
      // Written after the switch, as by a post-checkout hook: not a leftover, even when copied
      // with its old modification time.
      yield* world.write(`${target}/generated/fresh.txt`, "from the hook\n");
      yield* world.backdate(`${target}/generated/fresh.txt`);

      assert.equal((yield* world.take("task-2"))._tag, "pooled");
      assert.isFalse(yield* world.exists(`${target}/generated/out.txt`));
      assert.isTrue(yield* world.exists(`${target}/generated/fresh.txt`));
      assert.equal(yield* world.git(target, "status", "--porcelain"), "?? generated/");
      const [after] = yield* sql<{ readonly pending_clean: string | null }>`
        SELECT pending_clean FROM bot_worktrees`;
      assert.isNull(after?.pending_clean);
    }),
  ),
);

it.effect("never takes a checkout Git recreated at a free worktree's place for its own", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.runTask(1);
      const [parked] = (yield* world.pool.inventory(projectId)).free;
      const adminDir = yield* world.git(parked!, "rev-parse", "--absolute-git-dir");
      const parkedHead = yield* world.git(parked!, "rev-parse", "HEAD");
      // Someone removed it and made their own clean checkout there, at the same commit. Git
      // reuses the admin name, so only the pool's mark tells it apart.
      yield* world.git(world.root, "worktree", "remove", "--force", parked!);
      yield* world.git(world.root, "worktree", "add", "-q", "-b", "theirs", parked!, parkedHead);
      assert.equal(yield* world.git(parked!, "rev-parse", "--absolute-git-dir"), adminDir);

      yield* world.runTask(2);
      assert.equal(yield* world.git(parked!, "branch", "--show-current"), "theirs");
      assert.equal(yield* world.pool.clear(projectId), 1);
      assert.isTrue(yield* world.exists(parked!));
    }),
  ),
);

it.effect("keeps a free worktree whose assume-unchanged file changed only its mode", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.runTask(1);
      const [parked] = (yield* world.pool.inventory(projectId)).free;
      yield* world.git(parked!, "config", "core.fileMode", "true");
      yield* world.git(parked!, "update-index", "--assume-unchanged", "README.md");
      yield* world.chmod(`${parked!}/README.md`, 0o755);
      assert.equal(yield* world.git(parked!, "status", "--porcelain"), "");
      assert.equal(yield* world.pool.clear(projectId), 0);
      assert.isTrue(yield* world.exists(parked!));
    }),
  ),
);

it.effect("keeps a free worktree whose assume-unchanged file was deleted", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.runTask(1);
      const [parked] = (yield* world.pool.inventory(projectId)).free;
      yield* world.git(parked!, "update-index", "--assume-unchanged", "README.md");
      yield* world.remove(`${parked!}/README.md`);
      assert.equal(yield* world.git(parked!, "status", "--porcelain"), "");
      assert.equal(yield* world.pool.clear(projectId), 0);
      assert.isTrue(yield* world.exists(parked!));
    }),
  ),
);

it.effect("a worktree that cannot be released is kept and leaves its place in the pool", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const thread = yield* insertTask("locked");
      const claim = yield* world.take("locked");
      assert.equal(claim._tag, "pooled");
      const worktreePath = claim._tag === "pooled" ? claim.worktreePath : "";
      yield* world.git(world.root, "worktree", "lock", worktreePath);
      const released = yield* world.release("locked");
      assert.include(released.kept ?? "", "locked");
      yield* markReleased(thread);
      assert.isTrue(yield* world.exists(worktreePath));
      // The kept worktree does not count: the limit's worth of tasks still start.
      for (let n = 1; n <= BotWorktreePool.BOT_WORKTREE_POOL_LIMIT; n++) {
        yield* insertTask(`after-${n}`);
        assert.equal((yield* world.take(`after-${n}`))._tag, "pooled");
      }
    }),
  ),
);

it.effect("leaves a repository without a commit to the project folder", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      // An unborn HEAD alone is not an empty repository: main still has commits.
      yield* world.git(world.root, "symbolic-ref", "HEAD", "refs/heads/unborn");
      yield* insertTask("fresh-1");
      assert.equal((yield* world.take("fresh-1"))._tag, "pooled");
      // With no commit anywhere, as right after `git init`, the task runs in the folder.
      yield* world.git(world.root, "remote", "set-head", "origin", "--delete");
      const refs = yield* world.git(world.root, "for-each-ref", "--format=%(refname)");
      for (const ref of refs.split("\n").filter(Boolean))
        yield* world.git(world.root, "update-ref", "-d", ref);
      yield* insertTask("fresh-2");
      assert.equal((yield* world.take("fresh-2"))._tag, "no-git");
      // A detached HEAD naming a commit Git cannot read is no empty repository.
      yield* world.write(`${world.root}/.git/HEAD`, `${"1".repeat(40)}\n`);
      yield* insertTask("fresh-3");
      assert.equal((yield* world.take("fresh-3").pipe(Effect.flip))._tag, "BotWorktreePoolError");
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
      const thread = {
        id: task.thread,
        projectId,
        worktreePath: task.worktreePath,
        branch: task.branch,
      };
      assert.isTrue(yield* world.pool.restore(thread));
      assert.equal(yield* world.git(task.worktreePath, "branch", "--show-current"), task.branch);
      assert.isTrue(yield* world.exists(`${task.worktreePath}/feature.txt`));
      const [state] = yield* sql<{ readonly worktree_state: string }>`
        SELECT worktree_state FROM bot_tasks WHERE work_thread_id = ${task.thread}`;
      assert.equal(state?.worktree_state, "held");
      assert.equal(yield* world.worktreeCount, 1);
      // Turn start asks again after the send did: the worktree is in place.
      assert.isTrue(yield* world.pool.restore(thread));
      // Not a Bot work thread: the usual restore handles it.
      assert.isFalse(
        yield* world.pool.restore({ ...thread, id: ThreadId.make("not-a-bot-thread") }),
      );
    }),
  ),
);

it.effect("a follow-up a restart interrupted between move and switch ends on its branch", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const sql = yield* BotDatabase.BotDatabase;
      const one = yield* world.runTask(1, {
        work: (worktreePath) =>
          world
            .write(`${worktreePath}/feature.txt`, "feature\n")
            .pipe(
              Effect.andThen(world.git(worktreePath, "add", "-A")),
              Effect.andThen(world.git(worktreePath, "commit", "-qm", "feature")),
            ),
      });
      yield* world.runTask(2);
      // What the restore had written and done when the server stopped: claim, then move.
      const [row] = yield* sql<{ readonly path: string }>`SELECT path FROM bot_worktrees`;
      yield* sql`UPDATE bot_worktrees SET claimed_by = ${one.thread}, claimed_path = ${one.worktreePath}`;
      yield* sql`UPDATE bot_tasks SET worktree_state = 'held' WHERE work_thread_id = ${one.thread}`;
      yield* world.git(world.root, "worktree", "move", row!.path, one.worktreePath);

      assert.isTrue(
        yield* world.pool.restore({
          id: one.thread,
          projectId,
          worktreePath: one.worktreePath,
          branch: one.branch,
        }),
      );
      assert.equal(yield* world.git(one.worktreePath, "branch", "--show-current"), one.branch);
      assert.isTrue(yield* world.exists(`${one.worktreePath}/feature.txt`));
    }),
  ),
);

it.effect("a release a restart interrupted after its move finishes on the next pass", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const sql = yield* BotDatabase.BotDatabase;
      yield* insertTask("moved");
      const claim = yield* world.take("moved");
      const worktreePath = claim._tag === "pooled" ? claim.worktreePath : "";
      // What the release had done when the server stopped: cleaned, detached, moved back.
      const [row] = yield* sql<{ readonly path: string }>`SELECT path FROM bot_worktrees`;
      yield* world.git(worktreePath, "switch", "-q", "--detach");
      yield* world.git(world.root, "worktree", "move", worktreePath, row!.path);

      assert.deepEqual(yield* world.release("moved"), {
        savedWork: false,
        savedOn: null,
        kept: null,
      });
      assert.deepEqual((yield* world.pool.inventory(projectId)).free, [row!.path]);
      assert.equal((yield* world.runTask(2)).claim._tag, "pooled");
      assert.equal(yield* world.worktreeCount, 1);
    }),
  ),
);

it.effect("a follow-up on a branch with other lockfiles makes the next task set up again", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const one = yield* world.runTask(1);
      yield* world.write(`${world.root}/pnpm-lock.yaml`, "lock: 2\n");
      yield* world.git(world.root, "commit", "-qam", "lock 2");
      yield* world.git(world.root, "push", "-q", "origin", "main");
      assert.deepInclude((yield* world.runTask(2)).claim, { setupNeeded: true });
      // Task one's setup is retried: its restore takes the worktree set up from lock 2, and the
      // setup installs lock 1 from task one's branch.
      assert.isTrue(
        yield* world.pool.restore({
          id: one.thread,
          projectId,
          worktreePath: one.worktreePath,
          branch: one.branch,
        }),
      );
      yield* world.release("task-1");
      yield* markReleased(one.thread);
      assert.deepInclude((yield* world.runTask(3)).claim, { setupNeeded: true });
    }),
  ),
);

it.effect("never takes or removes a free worktree that changed after it was parked", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.runTask(1);
      const [parked] = (yield* world.pool.inventory(projectId)).free;
      yield* world.write(`${parked}/README.md`, "written after parking\n");

      // The next task gets a new worktree; the changed one is set aside, the edit intact.
      yield* world.runTask(2);
      assert.equal(yield* world.git(parked!, "diff", "--name-only"), "README.md");
      assert.deepEqual((yield* world.pool.inventory(projectId)).kept, [
        { path: parked!, workThreadId: null, reason: "has uncommitted changes (1 file)" },
      ]);
      assert.equal(yield* world.pool.clear(projectId), 1);
      assert.equal(yield* world.git(parked!, "diff", "--name-only"), "README.md");

      // A commit made in a free worktree counts too; once both are undone, Clear removes it.
      yield* world.git(parked!, "commit", "-qam", "committed after parking");
      assert.equal(yield* world.pool.clear(projectId), 0);
      assert.isTrue(yield* world.exists(parked!));
      yield* world.git(parked!, "reset", "-q", "--hard", "HEAD~1");
      assert.equal(yield* world.pool.clear(projectId), 1);
      assert.isFalse(yield* world.exists(parked!));
      assert.equal(yield* world.worktreeCount, 0);
    }),
  ),
);

it.effect("the upgrade keeps claims for their threads and leaves free worktrees from before", () =>
  Effect.gen(function* () {
    const sql = yield* BotDatabase.BotDatabase;
    for (const column of ["claimed_path", "git_dir", "kept_reason", "parked_head", "pending_clean"])
      yield* sql`ALTER TABLE bot_worktrees DROP COLUMN ${sql(column)}`;
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 32`;
    yield* sql`INSERT INTO bot_worktrees (worktree_id, project_id, path, claimed_by, setup_signature, parked_at)
      VALUES ('a1', ${projectId}, '/w/project/bot-task-1', ${threadOf("task-1")}, 'unknown', ${NOW}),
        ('b2', ${projectId}, 'C:\\w\\project\\bot-task-2', ${threadOf("task-2")}, 'unknown', ${NOW}),
        ('c3', ${projectId}, '/w/project/bot-pool-c3', NULL, 'unknown', ${NOW})`;
    yield* BotMigrations.runMigrations().pipe(Effect.provideService(SqlClient.SqlClient, sql));
    assert.deepEqual(
      yield* sql<{
        readonly path: string;
        readonly claimed_path: string | null;
        readonly git_dir: string | null;
      }>`SELECT path, claimed_path, git_dir FROM bot_worktrees ORDER BY worktree_id`,
      [
        // Unmarked, so the pool takes no checkout by path for them; release adopts a verified one.
        { path: "/w/project/bot-pool-a1", claimed_path: "/w/project/bot-task-1", git_dir: "" },
        {
          path: "C:\\w\\project\\bot-pool-b2",
          claimed_path: "C:\\w\\project\\bot-task-2",
          git_dir: "",
        },
        // A free one could since be anyone's checkout at that path: it stays on disk, unpooled.
      ],
    );
  }).pipe(Effect.provide(database)),
);

it.effect("replaces a free worktree someone deleted, as storage cleanup lets them", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.runTask(1);
      const [parked] = (yield* world.pool.inventory(projectId)).free;
      yield* world.remove(parked!);
      const second = yield* world.runTask(2);
      assert.deepInclude(second.claim, { _tag: "pooled", setupNeeded: true });
      assert.equal(yield* world.worktreeCount, 1);
    }),
  ),
);

it.effect(
  "a follow-up takes in the task's own checkout at its folder and refuses anything else",
  () =>
    withRepository((world) =>
      Effect.gen(function* () {
        const task = yield* world.runTask(1);
        const thread = {
          id: task.thread,
          projectId,
          worktreePath: task.worktreePath,
          branch: task.branch,
        };
        // A copy of another worktree's `.git` file names that worktree, not this folder.
        const [parked] = (yield* world.pool.inventory(projectId)).free;
        yield* world.write(
          `${task.worktreePath}/.git`,
          yield* world
            .git(parked!, "rev-parse", "--absolute-git-dir")
            .pipe(Effect.map((dir) => `gitdir: ${dir}\n`)),
        );
        assert.equal((yield* world.pool.restore(thread).pipe(Effect.flip)).operation, "restore");
        yield* world.remove(task.worktreePath);
        // A link to another worktree's `.git` is not this folder's registration either.
        yield* world.write(`${task.worktreePath}/notes.txt`, "someone's\n");
        yield* world.link(`${parked!}/.git`, `${task.worktreePath}/.git`);
        assert.equal((yield* world.pool.restore(thread).pipe(Effect.flip)).operation, "restore");
        assert.equal(yield* world.git(parked!, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
        yield* world.remove(`${task.worktreePath}/.git`);
        assert.equal((yield* world.pool.restore(thread).pipe(Effect.flip)).operation, "restore");
        yield* world.remove(task.worktreePath);

        // A terminal recreated the task's branch at its folder: it joins the pool and goes back.
        yield* world.git(world.root, "worktree", "add", "-q", task.worktreePath, task.branch);
        assert.isTrue(yield* world.pool.restore(thread));
        assert.equal(yield* world.pool.claimedPath(task.thread), task.worktreePath);
        yield* world.release("task-1");
        assert.isFalse(yield* world.exists(task.worktreePath));
        assert.lengthOf((yield* world.pool.inventory(projectId)).free, 2);
      }),
    ),
);

it.effect("adopts a task worktree the launch made before the pool made them all", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const sql = yield* BotDatabase.BotDatabase;
      const thread = yield* insertTask("legacy");
      yield* sql`UPDATE bot_tasks SET worktree_state = 'held' WHERE work_thread_id = ${thread}`;
      const worktreePath = `${world.worktrees}/bot-legacy`;
      yield* world.git(
        world.root,
        "worktree",
        "add",
        "-q",
        "-b",
        "bot/legacy",
        worktreePath,
        "main",
      );
      yield* world.write(`${worktreePath}/draft.txt`, "draft\n");
      assert.deepEqual(yield* world.release("legacy", worktreePath), {
        savedWork: true,
        savedOn: null,
        kept: null,
      });
      assert.lengthOf((yield* world.pool.inventory(projectId)).free, 1);
      assert.equal(
        yield* world.git(world.root, "log", "-1", "--format=%s", "bot/legacy"),
        "WIP: Task",
      );
    }),
  ),
);

it.effect("a commit only a free worktree holds gets a ref before reuse or removal moves on", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const sql = yield* BotDatabase.BotDatabase;
      const kept = (commit: string) =>
        world.git(world.root, "rev-parse", "--verify", `refs/t3/bot-worktrees/${commit}`);
      // The task branch was deleted while its worktree was parked.
      const one = yield* world.runTask(1, {
        work: (worktreePath) =>
          world.git(worktreePath, "commit", "-q", "--allow-empty", "-m", "one"),
      });
      const first = yield* world.git(world.root, "rev-parse", one.branch);
      yield* world.git(world.root, "branch", "-D", one.branch);
      yield* world.runTask(2);
      assert.equal(yield* kept(first), first);
      assert.equal(yield* world.worktreeCount, 1);

      // A worktree from before parked commits were recorded, with a commit on no branch.
      const [parked] = (yield* world.pool.inventory(projectId)).free;
      yield* sql`UPDATE bot_worktrees SET parked_head = NULL`;
      yield* world.git(parked!, "commit", "-q", "--allow-empty", "-m", "on no branch");
      const loose = yield* world.git(parked!, "rev-parse", "HEAD");
      assert.equal(yield* world.pool.clear(projectId), 1);
      assert.equal(yield* kept(loose), loose);
    }),
  ),
);

it.effect("a task whose run never started does not leave its worktree for the next task", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* insertTask("unstarted");
      const claim = yield* world.take("unstarted");
      const worktreePath = claim._tag === "pooled" ? claim.worktreePath : "";
      yield* world.write(`${worktreePath}/partial.txt`, "written by a cancelled setup\n");
      assert.deepEqual(yield* world.release("unstarted", null, false), {
        savedWork: true,
        savedOn: null,
        kept: null,
      });
      assert.equal(yield* world.worktreeCount, 0);
      assert.deepEqual(yield* world.pool.inventory(projectId), { free: [], kept: [] });

      // Also when a restart left the claimed worktree at rest, before it moved.
      const sql = yield* BotDatabase.BotDatabase;
      yield* insertTask("unmoved");
      const again = yield* world.take("unmoved");
      const [row] = yield* sql<{ readonly path: string }>`SELECT path FROM bot_worktrees`;
      yield* world.git(
        world.root,
        "worktree",
        "move",
        again._tag === "pooled" ? again.worktreePath : "",
        row!.path,
      );
      yield* world.release("unmoved", null, false);
      assert.equal(yield* world.worktreeCount, 0);
      assert.deepEqual(yield* world.pool.inventory(projectId), { free: [], kept: [] });
    }),
  ),
);

it.effect("a commit a post-checkout hook makes in a new worktree is not left on no branch", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      const hook = `${world.root}/.git/hooks/post-checkout`;
      yield* world.write(
        hook,
        "#!/bin/sh\ngit symbolic-ref -q HEAD >/dev/null || git commit -q --allow-empty -m hooked\n",
      );
      yield* world.chmod(hook, 0o755);
      yield* world.runTask(1);
      const refs = yield* world.git(
        world.root,
        "for-each-ref",
        "--format=%(subject)",
        "refs/t3/bot-worktrees",
      );
      assert.include(refs, "hooked");
    }),
  ),
);

it.effect("a reused worktree keeps what a post-checkout hook writes", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.runTask(1);
      // Hooks live in the common Git directory, so every worktree runs them.
      const hook = `${world.root}/.git/hooks/post-checkout`;
      yield* world.write(hook, "#!/bin/sh\necho hook > hook.txt\n");
      yield* world.chmod(hook, 0o755);
      yield* world.runTask(2, {
        work: (worktreePath) =>
          world
            .exists(`${worktreePath}/hook.txt`)
            .pipe(Effect.map((present) => assert.isTrue(present, "the hook's file is gone"))),
      });
    }),
  ),
);

it.effect("fails instead of running in the project folder when the refs cannot be read", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.git(world.root, "pack-refs", "--all");
      const packed = `${world.root}/.git/packed-refs`;
      yield* Effect.acquireRelease(world.chmod(packed, 0o000), () => world.chmod(packed, 0o644));
      yield* insertTask("unreadable");
      const result = yield* world.take("unreadable").pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  ),
);

it.effect("sets a free worktree Git cannot move aside, and the task gets another", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.runTask(1);
      const [parked] = (yield* world.pool.inventory(projectId)).free;
      yield* world.git(world.root, "worktree", "lock", parked!);
      yield* world.runTask(2);
      const [kept, ...others] = (yield* world.pool.inventory(projectId)).kept;
      assert.deepEqual(others, []);
      assert.deepInclude(kept, { path: parked!, workThreadId: null });
      assert.include(kept?.reason, "locked");
    }),
  ),
);

it.effect("removes a free worktree after its idle time, and all of them on clear", () =>
  withRepository((world) =>
    Effect.gen(function* () {
      yield* world.runTask(1);
      const [parked] = (yield* world.pool.inventory(projectId)).free;
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
      assert.deepEqual(yield* world.pool.inventory(projectId), { free: [], kept: [] });
      assert.equal(yield* world.worktreeCount, 0);
    }),
  ),
);
