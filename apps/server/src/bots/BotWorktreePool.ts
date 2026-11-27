import { BOT_WORK_THREAD_ID_PREFIX, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";

/** Worktrees one project keeps for Bot tasks, in use and free. T3B-122 replaces it with a per-Bot limit. */
export const BOT_WORKTREE_POOL_LIMIT = 5;
/** A free worktree unused this long is removed. */
export const BOT_WORKTREE_IDLE_DAYS = 7;

/** Lockfiles at the repository root; a change in one means the setup script must run again. */
const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "go.sum",
  "mix.lock",
  "pubspec.lock",
  "Podfile.lock",
  "flake.lock",
];

export class BotWorktreePoolError extends Schema.TaggedError<BotWorktreePoolError>()(
  "BotWorktreePoolError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** What a writing task gets: a free worktree already on its branch, or a base to create one from. */
export type BotWorktreeClaim =
  | { readonly _tag: "pooled"; readonly worktreePath: string; readonly setupNeeded: boolean }
  | { readonly _tag: "create"; readonly baseRef: string }
  | { readonly _tag: "full" }
  | { readonly _tag: "no-git" };

interface WorktreeRow {
  readonly worktree_id: string;
  readonly project_id: string;
  readonly path: string;
  readonly claimed_by: string | null;
  readonly setup_signature: string;
  readonly parked_at: string;
}

export class BotWorktreePool extends Context.Service<
  BotWorktreePool,
  {
    /**
     * Gives the work thread a worktree on a new branch from `baseBranch`, or the default branch.
     * Marks the task's worktree as held. A retry for the same thread continues its claim.
     */
    readonly take: (input: {
      readonly projectId: ProjectId;
      readonly workThreadId: ThreadId;
      readonly branch: string;
      readonly baseBranch: string | null;
    }) => Effect.Effect<BotWorktreeClaim, BotWorktreePoolError>;
    /**
     * Saves uncommitted work as a commit, cleans the worktree down to tracked and ignored files and
     * parks it, or removes it when the pool is full. The caller holds the path's workspace lease and
     * has checked that nothing runs there.
     */
    readonly park: (input: {
      readonly projectId: ProjectId;
      readonly workThreadId: ThreadId;
      readonly worktreePath: string;
      readonly commitMessage: string;
      /** Branch for work saved from a detached HEAD. */
      readonly wipBranch: string;
    }) => Effect.Effect<{ readonly savedWork: boolean }, BotWorktreePoolError>;
    /**
     * Puts a released work thread's worktree back at its path on its branch, from the pool when one
     * is free. False for any other thread. Runs under the path's workspace lease, as turn start does.
     */
    readonly restore: (thread: {
      readonly id: ThreadId;
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
      readonly branch: string | null;
    }) => Effect.Effect<boolean, BotWorktreePoolError>;
    readonly parkedPaths: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<string>, BotWorktreePoolError>;
    /** Disk use of these folders, null when one could not be read. */
    readonly measure: (paths: ReadonlyArray<string>) => Effect.Effect<number | null>;
    /** Removes the project's free worktrees; returns how many. */
    readonly clear: (projectId: ProjectId) => Effect.Effect<number, BotWorktreePoolError>;
    /** Removes free worktrees unused for {@link BOT_WORKTREE_IDLE_DAYS}. */
    readonly expire: Effect.Effect<void, BotWorktreePoolError>;
  }
>()("t3/bots/BotWorktreePool") {}

const make = Effect.gen(function* () {
  const sql = yield* BotDatabase.BotDatabase;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;

  const fail = (operation: string, detail: string) => (cause?: unknown) =>
    new BotWorktreePoolError({
      operation,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const storage = fail("storage", "Bot worktree storage failed.");
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const run = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation: `BotWorktreePool.${operation}`, cwd, args })
      .pipe(Effect.mapError((cause) => fail(operation, cause.message)(cause)));
  const read = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation: `BotWorktreePool.${operation}`, cwd, args, allowNonZeroExit: true })
      .pipe(Effect.mapError((cause) => fail(operation, cause.message)(cause)));
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));

  /** The project's repository root, or null for a folder without Git. */
  const repositoryOf = Effect.fn("BotWorktreePool.repositoryOf")(function* (projectId: ProjectId) {
    const project = yield* projects
      .getById(projectId)
      .pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(fail("resolve-project", "Could not read the project.")),
      );
    if (project === undefined) return yield* fail("resolve-project", "Project not found.")();
    const root = yield* gitWorkflow
      .repositoryRoot(project.workspaceRoot)
      .pipe(Effect.orElseSucceed(() => null));
    return root === null ? null : project.workspaceRoot;
  });

  const lockfileSignature = (cwd: string) =>
    read("lockfiles", cwd, ["ls-tree", "HEAD", "--", ...LOCKFILES]).pipe(
      Effect.map((result) => result.stdout.trim()),
    );

  /** The remote's copy of the base when there is a remote, fetched now; otherwise the local branch. */
  const resolveBase = Effect.fn("BotWorktreePool.resolveBase")(function* (
    cwd: string,
    baseBranch: string | null,
  ) {
    const remoteName = yield* gitWorkflow
      .resolvePrimaryRemoteName(cwd)
      .pipe(Effect.orElseSucceed(() => null));
    if (remoteName !== null) {
      const branchName =
        baseBranch ??
        (yield* gitWorkflow
          .resolveDefaultBranchName(cwd, remoteName)
          .pipe(Effect.orElseSucceed(() => null)));
      if (branchName !== null) {
        const fetched = yield* gitWorkflow
          .fetchWorktreeBaseCommit({
            cwd,
            refName: branchName,
            remote: { remoteName, branchName },
          })
          .pipe(Effect.orElseSucceed(() => null));
        if (fetched !== null) return fetched.commitSha;
      }
    }
    const candidates =
      baseBranch === null
        ? [
            "main",
            "master",
            yield* gitWorkflow.currentBranch(cwd).pipe(Effect.orElseSucceed(() => null)),
          ]
        : [baseBranch];
    for (const candidate of candidates) {
      if (
        candidate !== null &&
        (yield* gitWorkflow
          .hasCommit({ cwd, refName: `refs/heads/${candidate}` })
          .pipe(Effect.orElseSucceed(() => false)))
      )
        return candidate;
    }
    if (
      baseBranch === null &&
      (yield* gitWorkflow
        .hasCommit({ cwd, refName: "HEAD" })
        .pipe(Effect.orElseSucceed(() => false)))
    )
      return "HEAD";
    return yield* fail(
      "resolve-base",
      baseBranch === null
        ? "The project has no commit to start a task branch from."
        : `Base branch "${baseBranch}" was not found.`,
    )();
  });

  /** A task's own folder next to the free worktree it gets, named after its branch. */
  const threadPathBeside = (parked: string, branch: string) =>
    path.join(path.dirname(parked), branch.replace(/[^A-Za-z0-9_-]+/g, "-"));

  const heldCount = (projectId: ProjectId) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM bot_tasks
      WHERE project_id = ${projectId} AND worktree_state = 'held'
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));
  const freeCount = (projectId: ProjectId) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM bot_worktrees
      WHERE project_id = ${projectId} AND claimed_by IS NULL
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

  const markHeld = (workThreadId: ThreadId) =>
    sql`UPDATE bot_tasks SET worktree_state = 'held' WHERE work_thread_id = ${workThreadId}`;

  /** Claims a free worktree for the thread, or continues the claim a retry left. */
  const claimParked = Effect.fn("BotWorktreePool.claimParked")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
  ) {
    const claimed = yield* sql<WorktreeRow>`
      SELECT * FROM bot_worktrees WHERE claimed_by = ${threadId}
    `;
    if (claimed[0] !== undefined) return claimed[0];
    const free = yield* sql<WorktreeRow>`
      SELECT * FROM bot_worktrees WHERE project_id = ${projectId} AND claimed_by IS NULL
      ORDER BY parked_at DESC LIMIT 1
    `;
    if (free[0] === undefined) return undefined;
    yield* sql`UPDATE bot_worktrees SET claimed_by = ${threadId} WHERE worktree_id = ${free[0].worktree_id}`;
    return free[0];
  });

  /**
   * Moves a claimed worktree to the thread's folder and checks out `branch` there, from `startPoint`
   * when given. A retry finds it moved and already on the branch, and leaves its work alone.
   */
  const moveClaimed = Effect.fn("BotWorktreePool.moveClaimed")(function* (
    root: string,
    row: WorktreeRow,
    target: string,
    branch: string,
    startPoint: string | null,
  ) {
    if (row.path !== target) {
      if (!(yield* exists(row.path))) {
        yield* sql`DELETE FROM bot_worktrees WHERE worktree_id = ${row.worktree_id}`.pipe(
          Effect.mapError(storage),
        );
        yield* gitWorkflow.pruneWorktrees({ cwd: root }).pipe(Effect.ignore);
        return null;
      }
      yield* run("move", root, ["worktree", "move", row.path, target]);
      yield* sql`UPDATE bot_worktrees SET path = ${target} WHERE worktree_id = ${row.worktree_id}`.pipe(
        Effect.mapError(storage),
      );
    }
    const current = yield* read("current-branch", target, [
      "symbolic-ref",
      "-q",
      "--short",
      "HEAD",
    ]);
    if (current.stdout.trim() !== branch) {
      yield* run(
        "checkout",
        target,
        startPoint === null
          ? ["switch", "--discard-changes", "--quiet", branch]
          : ["switch", "--discard-changes", "--quiet", "-C", branch, startPoint],
      );
    }
    const signature = yield* lockfileSignature(target);
    return { setupNeeded: signature !== row.setup_signature };
  });

  const take: BotWorktreePool["Service"]["take"] = Effect.fn("BotWorktreePool.take")(
    function* (input) {
      const root = yield* repositoryOf(input.projectId);
      if (root === null) return { _tag: "no-git" } as const;
      while (true) {
        const decided = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const task = yield* sql<{ readonly worktree_state: string | null }>`
                SELECT worktree_state FROM bot_tasks WHERE work_thread_id = ${input.workThreadId}
              `;
              const held = task[0]?.worktree_state === "held";
              const row = yield* claimParked(input.projectId, input.workThreadId);
              if (row !== undefined) {
                if (!held) yield* markHeld(input.workThreadId);
                return { _tag: "claimed", row } as const;
              }
              if (!held) {
                if (
                  (yield* heldCount(input.projectId)) + (yield* freeCount(input.projectId)) >=
                  BOT_WORKTREE_POOL_LIMIT
                )
                  return { _tag: "full" } as const;
                yield* markHeld(input.workThreadId);
              }
              return { _tag: "create" } as const;
            }),
          )
          .pipe(Effect.mapError(storage));
        if (decided._tag === "full") return decided;
        const baseRef = yield* resolveBase(root, input.baseBranch);
        if (decided._tag === "create") return { _tag: "create", baseRef } as const;
        const target = threadPathBeside(decided.row.path, input.branch);
        const moved = yield* moveClaimed(root, decided.row, target, input.branch, baseRef);
        // The free worktree was gone from disk; try the next one.
        if (moved === null) continue;
        return { _tag: "pooled", worktreePath: target, setupNeeded: moved.setupNeeded } as const;
      }
    },
  );

  const commitIdentity = Effect.fn("BotWorktreePool.commitIdentity")(function* (cwd: string) {
    const email = yield* read("identity", cwd, ["config", "user.email"]);
    return email.stdout.trim() === ""
      ? ["-c", "user.name=T3 Code Bot", "-c", "user.email=bot@t3code.invalid"]
      : [];
  });

  const removeWorktree = (root: string, target: string) =>
    gitWorkflow
      .removeWorktree({ cwd: root, path: target, force: true })
      .pipe(Effect.mapError((cause) => fail("remove", cause.message)(cause)));

  const park: BotWorktreePool["Service"]["park"] = Effect.fn("BotWorktreePool.park")(
    function* (input) {
      const root = yield* repositoryOf(input.projectId);
      const target = input.worktreePath;
      if (root === null || !(yield* exists(target))) return { savedWork: false };
      const status = yield* run("status", target, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      const savedWork = status.stdout.trim() !== "";
      if (savedWork) {
        const onBranch = yield* read("current-branch", target, ["symbolic-ref", "-q", "HEAD"]);
        if (onBranch.stdout.trim() === "")
          yield* run("wip-branch", target, ["switch", "-c", input.wipBranch]);
        yield* run("stage", target, ["add", "-A"]);
        yield* run("commit", target, [
          ...(yield* commitIdentity(target)),
          "commit",
          "--no-verify",
          "--quiet",
          "-m",
          input.commitMessage,
        ]);
      }
      // Tracked files back to the commit, untracked ones gone, ignored ones kept for the next task.
      yield* run("reset", target, ["reset", "--hard", "--quiet"]);
      yield* run("clean", target, ["clean", "-fdq"]);
      // Detached, so the branch is free for a follow-up in another worktree.
      yield* run("detach", target, ["switch", "--detach", "--quiet"]);
      const signature = yield* lockfileSignature(target);
      const claimed = yield* sql<WorktreeRow>`
        SELECT * FROM bot_worktrees WHERE claimed_by = ${input.workThreadId}
      `.pipe(Effect.mapError(storage));
      const forget =
        claimed[0] === undefined
          ? Effect.void
          : sql`DELETE FROM bot_worktrees WHERE worktree_id = ${claimed[0].worktree_id}`.pipe(
              Effect.mapError(storage),
            );
      // The worktree being parked still counts as held.
      const room = yield* Effect.all([heldCount(input.projectId), freeCount(input.projectId)]).pipe(
        Effect.map(([held, free]) => held - 1 + free < BOT_WORKTREE_POOL_LIMIT),
        Effect.mapError(storage),
      );
      if (!room) {
        yield* removeWorktree(root, target);
        yield* forget;
        return { savedWork };
      }
      const id =
        claimed[0]?.worktree_id ??
        (yield* random.uuidV4().pipe(Effect.orDie)).replaceAll("-", "").slice(0, 12);
      const parkedPath = path.join(path.dirname(target), `bot-pool-${id}`);
      const moved = yield* run("park", root, ["worktree", "move", target, parkedPath]).pipe(
        Effect.as(true),
        // Git refuses to move a worktree with submodules; such a worktree is not reused.
        Effect.catch(() => removeWorktree(root, target).pipe(Effect.as(false))),
      );
      if (!moved) {
        yield* forget;
        return { savedWork };
      }
      yield* sql`
        INSERT INTO bot_worktrees (worktree_id, project_id, path, claimed_by, setup_signature, parked_at)
        VALUES (${id}, ${input.projectId}, ${parkedPath}, NULL, ${signature}, ${yield* nowIso})
        ON CONFLICT (worktree_id) DO UPDATE SET path = excluded.path, claimed_by = NULL,
          setup_signature = excluded.setup_signature, parked_at = excluded.parked_at
      `.pipe(Effect.mapError(storage));
      return { savedWork };
    },
  );

  const restore: BotWorktreePool["Service"]["restore"] = Effect.fn("BotWorktreePool.restore")(
    function* (thread) {
      if (
        !thread.id.startsWith(BOT_WORK_THREAD_ID_PREFIX) ||
        thread.worktreePath === null ||
        thread.branch === null
      )
        return false;
      const task = yield* sql<{ readonly worktree_state: string | null }>`
        SELECT worktree_state FROM bot_tasks WHERE work_thread_id = ${thread.id}
      `.pipe(Effect.mapError(storage));
      if (task[0]?.worktree_state !== "released" || (yield* exists(thread.worktreePath)))
        return false;
      const root = yield* repositoryOf(thread.projectId);
      if (root === null) return false;
      while (true) {
        const row = yield* sql
          .withTransaction(
            claimParked(thread.projectId, thread.id).pipe(Effect.tap(() => markHeld(thread.id))),
          )
          .pipe(Effect.mapError(storage));
        if (row === undefined) {
          yield* gitWorkflow
            .createWorktree({ cwd: root, refName: thread.branch, path: thread.worktreePath })
            .pipe(Effect.mapError((cause) => fail("create", cause.message)(cause)));
          return true;
        }
        const moved = yield* moveClaimed(root, row, thread.worktreePath, thread.branch, null);
        if (moved !== null) return true;
      }
    },
  );

  const parkedPaths: BotWorktreePool["Service"]["parkedPaths"] = (projectId) =>
    sql<{ readonly path: string }>`
      SELECT path FROM bot_worktrees WHERE project_id = ${projectId} AND claimed_by IS NULL
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.path)),
      Effect.mapError(storage),
    );

  // Untraced: it runs once per file, and `measure` is the span. Symlinks are not followed: pnpm
  // links packages, and a link can point outside the worktree.
  const sizeOf: (target: string) => Effect.Effect<number, PlatformError> = Effect.fnUntraced(
    function* (target: string) {
      const info = yield* fs.lstat(target);
      const own = Option.match(info.blocks, {
        onNone: () => Number(info.size),
        onSome: (blocks) => Number(blocks * 512n),
      });
      if (info.type !== "Directory") return own;
      const sizes = yield* Effect.forEach(
        yield* fs.readDirectory(target),
        (name) => sizeOf(path.join(target, name)),
        { concurrency: 16 },
      );
      return sizes.reduce((sum, size) => sum + size, own);
    },
  );

  const measure: BotWorktreePool["Service"]["measure"] = (paths) =>
    Effect.forEach(paths, (target) =>
      exists(target).pipe(
        Effect.flatMap((present) => (present ? sizeOf(target) : Effect.succeed(0))),
      ),
    ).pipe(
      Effect.map((sizes) => sizes.reduce((sum, size) => sum + size, 0)),
      Effect.orElseSucceed(() => null),
      Effect.withSpan("BotWorktreePool.measure"),
    );

  /** Removes unclaimed free worktrees parked before `cutoff`, or all of them; returns how many. */
  const removeParked = Effect.fn("BotWorktreePool.removeParked")(function* (
    filter: { readonly projectId: ProjectId } | { readonly before: string },
  ) {
    const rows = yield* (
      "projectId" in filter
        ? sql<WorktreeRow>`
          SELECT * FROM bot_worktrees WHERE project_id = ${filter.projectId} AND claimed_by IS NULL
        `
        : sql<WorktreeRow>`
          SELECT * FROM bot_worktrees WHERE parked_at < ${filter.before} AND claimed_by IS NULL
        `
    ).pipe(Effect.mapError(storage));
    let removed = 0;
    for (const row of rows) {
      const claimed = yield* sql<{ readonly worktree_id: string }>`
        DELETE FROM bot_worktrees WHERE worktree_id = ${row.worktree_id} AND claimed_by IS NULL
        RETURNING worktree_id
      `.pipe(Effect.mapError(storage));
      if (claimed.length === 0) continue;
      const root = yield* repositoryOf(row.project_id as ProjectId).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (root !== null) {
        const removal = (yield* exists(row.path))
          ? removeWorktree(root, row.path)
          : gitWorkflow
              .pruneWorktrees({ cwd: root })
              .pipe(Effect.mapError((cause) => fail("prune", cause.message)(cause)));
        yield* removal.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not remove a free Bot worktree", { path: row.path, cause }),
          ),
        );
      }
      removed++;
    }
    return removed;
  });

  const clear: BotWorktreePool["Service"]["clear"] = (projectId) => removeParked({ projectId });

  const expire: BotWorktreePool["Service"]["expire"] = Effect.gen(function* () {
    const before = DateTime.formatIso(
      DateTime.subtract(yield* DateTime.now, { days: BOT_WORKTREE_IDLE_DAYS }),
    );
    yield* removeParked({ before });
  }).pipe(Effect.withSpan("BotWorktreePool.expire"));

  return BotWorktreePool.of({
    take,
    park,
    restore,
    parkedPaths,
    measure,
    clear,
    expire,
  });
});

export const layer = Layer.effect(BotWorktreePool, make);
