import {
  BOT_WORK_THREAD_ID_PREFIX,
  type ProjectId,
  T3_PROJECT_FILE_NAME,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  resolveProjectFileBackedSetting,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
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

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { removeLinkedWorktree } from "../vcs/worktreeRemoval.ts";
import { makeWorktreeRemovalChecks } from "../vcs/worktreeRemovalChecks.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";

/**
 * Worktrees one project keeps for Bot tasks, in use and free, shared by every Bot and routine there.
 * It bounds disk use; how many tasks one Bot runs is its own task limit, checked before this.
 */
export const BOT_WORKTREE_POOL_LIMIT = 5;
/** A free worktree unused this long is removed. */
export const BOT_WORKTREE_IDLE_DAYS = 7;
/** `claimed_by` of a free worktree while Clear or expiry removes it. */
const REMOVING = "removing";
/** In a pool worktree's admin directory: the id of the row it belongs to. */
const OWNER_MARKER = "t3-bot-worktree";
/** In the same directory, written just before a claim's switch: older files are leftovers. */
const SWITCH_STAMP = "t3-bot-switch";
/** Not a commit, so a worktree with it always runs setup next. */
const SETUP_UNKNOWN = "unknown";
/** Untracked files are work; ignored ones, such as installed dependencies, are not. */
const KEEP_RULES = { worktreeKeepWhen: "uncommitted-changes" } as const;

/** Lockfiles at any depth; a change in one means the setup script must run again. */
const PendingJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodePendingOption = Schema.decodeUnknownOption(PendingJson);
const encodePending = Schema.encodeSync(PendingJson);
/** A clean-up a claim wrote down; unreadable, only the submodules are still owed. */
const decodePending = (text: string): ReadonlyArray<string> =>
  Option.getOrElse(decodePendingOption(text), () => []);

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

/** What a writing task gets: a worktree already on its branch. */
export type BotWorktreeClaim =
  | { readonly _tag: "pooled"; readonly worktreePath: string; readonly setupNeeded: boolean }
  | { readonly _tag: "full" }
  /** A folder without Git, or a repository without a commit yet: the task runs in the folder. */
  | { readonly _tag: "no-git" };

/** A worktree kept out of the pool; its thread is null when it was set aside while free. */
export interface KeptWorktree {
  readonly path: string;
  readonly workThreadId: ThreadId | null;
  readonly reason: string;
}

export interface BotWorktreeRelease {
  readonly savedWork: boolean;
  /** The branch work saved from a detached HEAD went to; the task and its thread name it. */
  readonly savedOn: string | null;
  /** Why the worktree stays in the thread's folder, out of the pool; null when it went back. */
  readonly kept: string | null;
}

/**
 * One worktree, from its creation to its removal. Free: no claim and nothing kept. A thread's
 * claim puts it at `claimed_path`, the thread's folder; release moves it back to `path`.
 */
interface WorktreeRow {
  readonly worktree_id: string;
  readonly project_id: string;
  readonly path: string;
  readonly claimed_by: string | null;
  readonly claimed_path: string | null;
  readonly git_dir: string | null;
  readonly kept_reason: string | null;
  readonly setup_signature: string;
  readonly parked_at: string;
  readonly parked_head: string | null;
  readonly pending_clean: string | null;
}

interface Repository {
  /** The project folder, where Git commands for the repository run. */
  readonly root: string;
  /** The repository's common Git directory, resolved; every worktree of it shares this one. */
  readonly common: string;
}

export class BotWorktreePool extends Context.Service<
  BotWorktreePool,
  {
    /**
     * Gives the work thread a worktree on a new branch from `baseBranch`, or the default branch,
     * and marks the task's worktree as held. A retry for the same thread continues its claim.
     */
    readonly take: (input: {
      readonly projectId: ProjectId;
      readonly workThreadId: ThreadId;
      readonly branch: string;
      readonly baseBranch: string | null;
    }) => Effect.Effect<BotWorktreeClaim, BotWorktreePoolError>;
    /**
     * Saves the thread's uncommitted work as a commit and parks the worktree, or removes it when
     * the pool is full. A worktree whose work cannot be saved stays where it is. The caller holds
     * the folder's workspace lease and has checked that nothing runs there; a release that
     * stopped halfway finishes on the next call.
     */
    readonly release: (input: {
      readonly projectId: ProjectId;
      readonly workThreadId: ThreadId;
      /** The task's branch, and the thread's folder: a worktree there not yet the pool's joins it. */
      readonly branch: string;
      readonly worktreePath: string | null;
      readonly commitMessage: string;
      /** Branch for work saved from a detached HEAD; it starts with `<branch>-wip-`. */
      readonly wipBranch: string;
      /** False removes the worktree instead of parking it. */
      readonly reuse: boolean;
    }) => Effect.Effect<BotWorktreeRelease, BotWorktreePoolError>;
    /**
     * Puts a work thread's worktree at its folder on its branch: the one it holds or kept, a
     * checkout of its branch already there, else a free one, else a new one. False for any other
     * thread; fails when the folder holds anything else. Runs under the folder's workspace lease,
     * as turn start does.
     */
    readonly restore: (thread: {
      readonly id: ThreadId;
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
      readonly branch: string | null;
    }) => Effect.Effect<boolean, BotWorktreePoolError>;
    /** The project's free worktrees, and those kept out of the pool. */
    readonly inventory: (projectId: ProjectId) => Effect.Effect<
      {
        readonly free: ReadonlyArray<string>;
        readonly kept: ReadonlyArray<KeptWorktree>;
      },
      BotWorktreePoolError
    >;
    /**
     * Keeps the worktree the thread holds where it is, out of the pool and its count, with why.
     * A message in the thread or a later release picks it up again. False when it holds none.
     */
    readonly keep: (input: {
      readonly workThreadId: ThreadId;
      readonly reason: string;
    }) => Effect.Effect<boolean, BotWorktreePoolError>;
    /** Worktrees kept for a thread, in every project. */
    readonly keptClaims: Effect.Effect<ReadonlyArray<KeptWorktree>, BotWorktreePoolError>;
    /** The folder of the worktree the thread holds or kept. */
    readonly claimedPath: (
      workThreadId: ThreadId,
    ) => Effect.Effect<string | null, BotWorktreePoolError>;
    /** Disk use of these folders, null when one could not be read. */
    readonly measure: (paths: ReadonlyArray<string>) => Effect.Effect<number | null>;
    /**
     * Removes the project's free worktrees, and those set aside that are clean again; returns how
     * many. A worktree changed since it was parked is set aside instead.
     */
    readonly clear: (projectId: ProjectId) => Effect.Effect<number, BotWorktreePoolError>;
    /** Removes free worktrees unused for {@link BOT_WORKTREE_IDLE_DAYS}, under the same checks. */
    readonly expire: Effect.Effect<void, BotWorktreePoolError>;
  }
>()("t3/bots/BotWorktreePool") {}

const make = Effect.gen(function* () {
  const sql = yield* BotDatabase.BotDatabase;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const checks = yield* makeWorktreeRemovalChecks;

  const fail = (operation: string, detail: string) => (cause?: unknown) =>
    new BotWorktreePoolError({
      operation,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const storage = fail("storage", "Bot worktree storage failed.");
  // A removal the last server run did not finish: the worktree is free again, and checked again
  // before anything uses or removes it.
  yield* sql`UPDATE bot_worktrees SET claimed_by = NULL WHERE claimed_by = ${REMOVING}`.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not free Bot worktrees a removal left reserved", { cause }),
    ),
  );
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const run = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: { readonly writesSharedConfig?: boolean; readonly timeoutMs?: null },
  ) =>
    git
      .execute({ operation: `BotWorktreePool.${operation}`, cwd, args, ...options })
      .pipe(Effect.mapError((cause) => fail(operation, cause.message)(cause)));
  const read = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation: `BotWorktreePool.${operation}`, cwd, args, allowNonZeroExit: true })
      .pipe(Effect.mapError((cause) => fail(operation, cause.message)(cause)));
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => true));
  const realPath = (target: string) =>
    fs.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
  const head = (cwd: string) =>
    run("head", cwd, ["rev-parse", "--verify", "HEAD^{commit}"]).pipe(
      Effect.map((result) => result.stdout.trim()),
    );
  const inspect = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError((cause) => fail(operation, String(cause))(cause)));

  /** The project's repository, or null for a folder without Git. A failed lookup fails. */
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
      .pipe(
        Effect.mapError(
          fail("resolve-repository", "Could not tell whether the project is a Git repository."),
        ),
      );
    if (root === null) return null;
    const common = yield* run("common-dir", project.workspaceRoot, [
      "rev-parse",
      "--git-common-dir",
    ]);
    return {
      root: project.workspaceRoot,
      common: yield* realPath(path.resolve(project.workspaceRoot, common.stdout.trim())),
    } satisfies Repository;
  });

  /** Where new worktrees of the project rest: the managed worktrees folder, as for others. */
  const poolDirectory = Effect.fn("BotWorktreePool.poolDirectory")(function* (root: string) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const parent = resolveWorktreesDirectory(
      settings?.worktreesDirectory ?? "",
      serverConfig.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    );
    if (parent === null)
      return yield* fail(
        "create",
        "The worktree location in Settings → Worktrees is not a folder on this machine.",
      )();
    return path.join(parent, path.basename(path.resolve(root)));
  });

  /**
   * The worktree's Git directory when `target` holds it: the top of a linked worktree of the
   * project's repository, registered at this folder, and the expected one once known. Null for a
   * folder without `.git` or with someone else's; a `.git` that cannot be read fails, so nothing
   * forgets a checkout it could not inspect.
   */
  const worktreeAt = Effect.fn("BotWorktreePool.worktreeAt")(function* (
    repo: Repository,
    target: string,
    gitDir: string | null,
  ) {
    const gitFile = path.join(target, ".git");
    const unreadable = fail("identify", `${target} could not be inspected.`);
    const info = yield* fs.lstat(gitFile).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.mapError(unreadable),
    );
    if (Option.isNone(info)) return null;
    // A linked worktree's `.git` is a file; a link or folder could name another checkout.
    if (info.value.type !== "File") return null;
    const result = yield* read("identify", target, [
      "rev-parse",
      "--show-toplevel",
      "--absolute-git-dir",
      "--git-common-dir",
    ]);
    const [top, dir, common] = result.stdout.split("\n");
    if (result.exitCode !== 0 || top === undefined || dir === undefined || common === undefined)
      return yield* unreadable();
    const actual = yield* realPath(dir);
    // The registration names this folder's own `.git`, not a copy of it elsewhere.
    const registered = yield* fs.readFileString(path.join(actual, "gitdir")).pipe(
      Effect.flatMap((pointer) => realPath(path.resolve(actual, pointer.trim()))),
      Effect.mapError(unreadable),
    );
    return (yield* realPath(top)) === (yield* realPath(target)) &&
      registered === path.join(yield* realPath(target), ".git") &&
      (yield* realPath(path.resolve(target, common))) === repo.common &&
      actual !== repo.common &&
      (gitDir === null || actual === gitDir)
      ? actual
      : null;
  });

  /**
   * Git reuses a worktree's admin directory for a new checkout at the same path, so the pool marks
   * its own in there: a replacement there is someone else's.
   */
  const markOwned = (gitDir: string, worktreeId: string) =>
    fs
      .writeFileString(path.join(gitDir, OWNER_MARKER), worktreeId)
      .pipe(Effect.mapError((cause) => fail("mark", `Could not mark ${gitDir}.`)(cause)));
  const owned = (gitDir: string, worktreeId: string) =>
    fs.readFileString(path.join(gitDir, OWNER_MARKER)).pipe(
      Effect.map((text) => text.trim() === worktreeId),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      Effect.mapError((cause) => fail("identify", `Could not read ${gitDir}.`)(cause)),
    );

  /** Where the worktree is now, at its claimed folder or at rest; null when neither holds it. */
  const locate = Effect.fn("BotWorktreePool.locate")(function* (
    repo: Repository,
    row: WorktreeRow,
  ) {
    // A claim carried over from before the pool marked its worktrees is never taken by path.
    if (row.git_dir === "") return null;
    // One never seen is only where the pool creates it, at rest, under its own id.
    const candidates = row.git_dir === null ? [row.path] : [row.claimed_path, row.path];
    for (const candidate of candidates) {
      if (candidate === null) continue;
      const gitDir = yield* worktreeAt(repo, candidate, row.git_dir);
      if (gitDir === null) continue;
      if (row.git_dir === null) {
        yield* markOwned(gitDir, row.worktree_id);
        yield* sql`UPDATE bot_worktrees SET git_dir = ${gitDir} WHERE worktree_id = ${row.worktree_id}`.pipe(
          Effect.mapError(storage),
        );
      } else if (!(yield* owned(gitDir, row.worktree_id))) continue;
      return { at: candidate, gitDir };
    }
    return null;
  });

  const forget = (row: WorktreeRow, root: string) =>
    sql`DELETE FROM bot_worktrees WHERE worktree_id = ${row.worktree_id}`.pipe(
      Effect.mapError(storage),
      Effect.andThen(gitWorkflow.pruneWorktrees({ cwd: root }).pipe(Effect.ignore)),
    );

  /** Whether a branch, remote branch or tag holds HEAD, so moving HEAD away loses no commit. */
  const headOnRef = (target: string) =>
    run("contained", target, [
      "for-each-ref",
      "--count=1",
      "--contains",
      "HEAD",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]).pipe(Effect.map((result) => result.stdout.trim() !== ""));

  /**
   * Before HEAD is switched away or the worktree removed: a commit no branch, remote branch or tag
   * holds, as when its task branch was deleted meanwhile, keeps a ref of its own.
   */
  const keepHead = Effect.fn("BotWorktreePool.keepHead")(function* (target: string) {
    if (yield* headOnRef(target)) return;
    const commit = yield* head(target);
    yield* run("keep-commit", target, ["update-ref", `refs/t3/bot-worktrees/${commit}`, commit]);
  });

  /**
   * Why resetting or removing the worktree would lose work; null when nothing would be lost. A
   * free worktree must also still be at the commit it was parked at.
   */
  const unsavedWork = Effect.fn("BotWorktreePool.unsavedWork")(function* (
    target: string,
    parkedHead: string | null,
  ) {
    const changes = yield* inspect("check", checks.localChangesReason(target, KEEP_RULES));
    if (changes !== null) return { reason: changes, force: false };
    if (parkedHead !== null && (yield* head(target)) !== parkedHead)
      return { reason: "is at another commit than when it was parked", force: false };
    return yield* checks.submoduleRemoval(target, KEEP_RULES);
  });

  /** Moves the worktree to a folder the caller checked is free, and verifies it arrived. */
  const move = Effect.fn("BotWorktreePool.move")(function* (
    repo: Repository,
    from: string,
    to: string,
    gitDir: string,
  ) {
    const moved = yield* read("move", repo.root, ["worktree", "move", from, to]);
    // Git's reason, such as a lock, is what a kept worktree shows.
    if (moved.exitCode !== 0)
      return yield* fail(
        "move",
        moved.stderr
          .trim()
          .split("\n")[0]
          ?.replace(/^fatal: /, "") || "git worktree move failed",
      )();
    if ((yield* worktreeAt(repo, to, gitDir)) === null)
      return yield* fail("verify", `The worktree moved to ${to} could not be verified.`)();
  });

  const remove = (repo: Repository, target: string, force: boolean) =>
    removeLinkedWorktree({
      operation: "BotWorktreePool.remove",
      cwd: repo.root,
      worktreePath: target,
      force,
      execute: git.execute,
      run: (args) => run("remove", repo.root, args),
    }).pipe(
      Effect.mapError((cause) => fail("remove", cause.message)(cause)),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  /**
   * Removes files under `entries`, ignored before the switch and untracked now, that are older
   * than the switch: the previous task's leftovers. A file a hook or anyone wrote since stays.
   */
  const removeLeftovers = Effect.fn("BotWorktreePool.removeLeftovers")(function* (
    target: string,
    gitDir: string,
    entries: ReadonlyArray<string>,
  ) {
    const stamp = yield* fs.stat(path.join(gitDir, SWITCH_STAMP)).pipe(
      Effect.map((info) => Option.getOrNull(info.mtime)),
      Effect.orElseSucceed(() => null),
    );
    // Without the stamp nothing tells old from new; keeping them costs only leftovers.
    if (stamp === null) return;
    const untracked = (yield* run("leftovers", target, [
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      "--",
      ...entries.map((entry) => `:(literal)${entry}`),
    ])).stdout
      .split("\0")
      // A folder listed whole holds a repository of its own; it is left alone.
      .filter((file) => file !== "" && !file.endsWith("/"));
    for (const file of untracked) {
      const full = path.join(target, file);
      const modified = Option.flatMap(
        yield* fs.lstat(full).pipe(Effect.option),
        (info) => info.mtime,
      );
      if (Option.isSome(modified) && modified.value.getTime() < stamp.getTime())
        yield* fs
          .remove(full)
          .pipe(Effect.mapError((cause) => fail("clean", `Could not remove ${file}.`)(cause)));
    }
  });

  /** As a new worktree does: Git leaves submodules empty on checkout. */
  const initSubmodules = Effect.fn("BotWorktreePool.initSubmodules")(function* (
    projectId: string,
    target: string,
  ) {
    if (
      !(yield* fs.exists(path.join(target, ".gitmodules")).pipe(Effect.orElseSucceed(() => false)))
    )
      return;
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const projectFile = yield* fs.readFileString(path.join(target, T3_PROJECT_FILE_NAME)).pipe(
      Effect.map(parseT3ProjectFile),
      Effect.orElseSucceed(() => null),
    );
    const mode = resolveProjectFileBackedSetting(
      "worktreeSubmodules",
      settings === null
        ? null
        : resolveProjectSettings(settings, projectId as ProjectId).settings.worktreeSubmodules,
      projectFile,
    ).value;
    if (mode === "none") return;
    yield* run(
      "submodules",
      target,
      ["submodule", "update", "--init", ...(mode === "recursive" ? ["--recursive"] : [])],
      { writesSharedConfig: true, timeoutMs: null },
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Bot worktree submodules may be incomplete", { target, cause }),
      ),
    );
  });

  /** The commit a setup installs from, recorded as the worktree's setup signature. */
  const lockfileSignature = (cwd: string, commit = "HEAD") =>
    run("setup-commit", cwd, ["rev-parse", "--verify", `${commit}^{commit}`]).pipe(
      Effect.map((result) => result.stdout.trim()),
    );
  /** Whether a lockfile differs from the commit the last setup installed from, or it is unknown. */
  const setupNeededAt = (cwd: string, setupCommit: string) =>
    setupCommit === SETUP_UNKNOWN
      ? Effect.succeed(true)
      : read("lockfiles", cwd, [
          "diff",
          "--quiet",
          setupCommit,
          "HEAD",
          "--",
          ...LOCKFILES.map((name) => `:(glob)**/${name}`),
        ]).pipe(Effect.map((result) => result.exitCode !== 0));
  /** The commit the worktree's last setup installed from; parking keeps it with the worktree. */
  const recordSetup = (workThreadId: ThreadId, signature: string) =>
    sql`UPDATE bot_tasks SET setup_signature = ${signature} WHERE work_thread_id = ${workThreadId}`.pipe(
      Effect.mapError(storage),
    );

  /**
   * The remote's copy of the base when there is a remote, fetched now; otherwise the local branch.
   * With a remote, a default branch it cannot name or fetch fails rather than guess a local one.
   */
  const resolveBase = Effect.fn("BotWorktreePool.resolveBase")(function* (
    cwd: string,
    baseBranch: string | null,
  ) {
    // No remote at all means local branches; a failed lookup must not mean that.
    const remotes = yield* run("remotes", cwd, ["remote"]);
    const remoteName =
      remotes.stdout.trim() === ""
        ? null
        : yield* gitWorkflow
            .resolvePrimaryRemoteName(cwd)
            .pipe(Effect.mapError((cause) => fail("resolve-base", cause.message)(cause)));
    if (remoteName !== null) {
      // The remote's HEAD now; the local `origin/HEAD` can be stale, so it only stands in offline.
      let branchName = baseBranch;
      if (branchName === null) {
        const advertised = yield* read("remote-head", cwd, [
          "ls-remote",
          "--symref",
          remoteName,
          "HEAD",
        ]).pipe(Effect.orElseSucceed(() => null));
        branchName =
          /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(advertised?.stdout ?? "")?.[1] ??
          (yield* gitWorkflow
            .resolveDefaultBranchName(cwd, remoteName)
            .pipe(Effect.orElseSucceed(() => null)));
        if (branchName === null)
          return yield* fail(
            "resolve-base",
            `Could not find the default branch of "${remoteName}": the remote did not answer and it was never fetched.`,
          )();
      }
      const fetched = yield* gitWorkflow
        .fetchWorktreeBaseCommit({
          cwd,
          refName: branchName,
          remote: { remoteName, branchName },
        })
        .pipe(Effect.result);
      if (fetched._tag === "Success" && fetched.success !== null) return fetched.success.commitSha;
      // Offline, the remote's branch as last fetched beats a local branch of the same name.
      const tracking = `refs/remotes/${remoteName}/${branchName}`;
      if (
        fetched._tag === "Failure" &&
        (yield* gitWorkflow
          .hasCommit({ cwd, refName: tracking })
          .pipe(Effect.orElseSucceed(() => false)))
      )
        return tracking;
      if (baseBranch === null)
        return yield* fail(
          "resolve-base",
          `Could not fetch "${branchName}" from "${remoteName}", and it was never fetched before.`,
        )();
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
        return `refs/heads/${candidate}`;
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

  /** A task's own folder beside the worktree's resting place, named after its branch. */
  const threadPathBeside = (rest: string, branch: string) =>
    path.join(path.dirname(rest), branch.replace(/[^A-Za-z0-9_-]+/g, "-"));

  const heldCount = (projectId: ProjectId) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM bot_tasks
      WHERE project_id = ${projectId} AND worktree_state = 'held'
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));
  const freeCount = (projectId: ProjectId) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM bot_worktrees
      WHERE project_id = ${projectId} AND claimed_by IS NULL AND kept_reason IS NULL
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));
  const markHeld = (workThreadId: ThreadId) =>
    sql`UPDATE bot_tasks SET worktree_state = 'held' WHERE work_thread_id = ${workThreadId}`;
  const readRow = (worktreeId: string) =>
    sql<WorktreeRow>`SELECT * FROM bot_worktrees WHERE worktree_id = ${worktreeId}`.pipe(
      Effect.map((rows) => rows[0]),
    );

  /**
   * The thread's claim, written before anything happens on disk: the worktree it holds or kept,
   * else a free one, else a new row the next step creates the worktree for. Undefined when the
   * pool is full and `admit` asks to respect its limit.
   */
  const claim = Effect.fn("BotWorktreePool.claim")(function* (input: {
    readonly projectId: ProjectId;
    readonly workThreadId: ThreadId;
    readonly branch: string;
    readonly directory: string;
    /** The thread's folder; by default beside the worktree's resting place. */
    readonly target: string | null;
    readonly admit: boolean;
  }) {
    const [own] = yield* sql<WorktreeRow>`
      SELECT * FROM bot_worktrees WHERE claimed_by = ${input.workThreadId}
    `;
    const targetFor = (rest: string) => input.target ?? threadPathBeside(rest, input.branch);
    if (own !== undefined) {
      yield* sql`
        UPDATE bot_worktrees SET kept_reason = NULL, claimed_path = ${targetFor(own.path)}
        WHERE worktree_id = ${own.worktree_id}
      `;
      yield* markHeld(input.workThreadId);
      return yield* readRow(own.worktree_id);
    }
    // Another worktree than the one the task last had: until its setup is recorded, nothing about
    // the old install applies, even if a restart stops this claim halfway.
    yield* sql`UPDATE bot_tasks SET setup_signature = ${SETUP_UNKNOWN}
      WHERE work_thread_id = ${input.workThreadId}`;
    const [free] = yield* sql<WorktreeRow>`
      SELECT * FROM bot_worktrees
      WHERE project_id = ${input.projectId} AND claimed_by IS NULL AND kept_reason IS NULL
      ORDER BY parked_at DESC LIMIT 1
    `;
    if (free !== undefined) {
      yield* sql`
        UPDATE bot_worktrees SET claimed_by = ${input.workThreadId},
          claimed_path = ${targetFor(free.path)}
        WHERE worktree_id = ${free.worktree_id}
      `;
      yield* markHeld(input.workThreadId);
      return yield* readRow(free.worktree_id);
    }
    const [task] = yield* sql<{ readonly worktree_state: string | null }>`
      SELECT worktree_state FROM bot_tasks WHERE work_thread_id = ${input.workThreadId}
    `;
    if (
      input.admit &&
      task?.worktree_state !== "held" &&
      (yield* heldCount(input.projectId)) + (yield* freeCount(input.projectId)) >=
        BOT_WORKTREE_POOL_LIMIT
    )
      return undefined;
    const id = (yield* random.uuidV4().pipe(Effect.orDie)).replaceAll("-", "").slice(0, 12);
    const rest = path.join(input.directory, `bot-pool-${id}`);
    yield* sql`
      INSERT INTO bot_worktrees (worktree_id, project_id, path, claimed_by, claimed_path,
        setup_signature, parked_at)
      VALUES (${id}, ${input.projectId}, ${rest}, ${input.workThreadId}, ${targetFor(rest)},
        ${SETUP_UNKNOWN}, ${yield* nowIso})
    `;
    yield* markHeld(input.workThreadId);
    return yield* readRow(id);
  });

  /**
   * Brings the claimed worktree to its thread's folder on `branch`, from `startPoint` when the
   * branch is new: created at rest if it never existed, checked, moved, switched. Each step finds
   * what an interrupted earlier attempt left and goes on from there. "gone" and "set-aside" mean
   * this row cannot serve the claim; the caller claims again.
   */
  const bringTo = Effect.fn("BotWorktreePool.bringTo")(function* (
    repo: Repository,
    row: WorktreeRow,
    branch: string,
    startPoint: string,
  ) {
    const target = row.claimed_path!;
    let located = yield* locate(repo, row);
    // Made just now, it holds nothing to lose, and a fault it shows would show in the next one too.
    const created = located === null;
    if (located === null) {
      // Seen before and gone: removed outside the pool.
      if (row.git_dir !== null) {
        yield* forget(row, repo.root);
        return "gone" as const;
      }
      if (yield* exists(row.path))
        return yield* fail("create", `${row.path} is in the way of a new worktree.`)();
      // Detached and without submodules: Git refuses to move a worktree that has them.
      yield* gitWorkflow
        .createWorktree(
          { cwd: repo.root, refName: startPoint, path: row.path },
          { submodules: "none" },
        )
        .pipe(Effect.mapError((cause) => fail("create", cause.message)(cause)));
      located = yield* locate(repo, row);
      if (located === null)
        return yield* fail("create", "The new worktree could not be verified.")();
    }
    const setAside = (reason: string) =>
      sql`
        UPDATE bot_worktrees SET claimed_by = NULL, claimed_path = NULL, kept_reason = ${reason}
        WHERE worktree_id = ${row.worktree_id}
      `.pipe(
        Effect.mapError(storage),
        Effect.andThen(
          Effect.logWarning("Set aside a free Bot worktree", { path: row.path, reason }),
        ),
        Effect.as("set-aside" as const),
      );
    const onBranch =
      (yield* read("current-branch", located.at, [
        "symbolic-ref",
        "-q",
        "--short",
        "HEAD",
      ])).stdout.trim() === branch;
    if (!onBranch && !created) {
      // A free worktree must be as it was parked; anything else is someone's work. One in the
      // thread's folder is the thread's own, left detached by a release that stopped.
      const unsaved = yield* unsavedWork(
        located.at,
        located.at === row.path ? row.parked_head : null,
      );
      if (unsaved.reason !== null) {
        if (located.at !== row.path)
          return yield* fail("checkout", `${located.at} ${unsaved.reason}.`)();
        return yield* setAside(unsaved.reason);
      }
    }
    if (located.at !== target) {
      // Git moves into a folder that exists; the task's folder must not.
      if (yield* exists(target)) return yield* fail("move", `${target} is already in use.`)();
      // Git does not create the folder it moves into.
      yield* fs
        .makeDirectory(path.dirname(target), { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            fail("move", `Could not create ${path.dirname(target)}.`)(cause),
          ),
        );
      // Git refusing to move a reused worktree, as for a lock, would fail every claim on it.
      const refused = yield* move(repo, located.at, target, located.gitDir).pipe(
        Effect.as(null),
        Effect.catchIf(
          (error) => error.operation === "move" && !created,
          (error) => Effect.succeed(error.detail),
        ),
      );
      if (refused !== null) return yield* setAside(refused);
    }
    // What the switch leaves to do, written down before it so a restart after it still does it.
    let pending: ReadonlyArray<string> | null =
      row.pending_clean === null ? null : decodePending(row.pending_clean);
    if (!onBranch) {
      // Ignored here, maybe not on the new branch: the previous task's leftovers.
      pending = (yield* run("ignored", target, [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
      ])).stdout
        .split("\0")
        .filter((entry) => entry !== "");
      yield* sql`
        UPDATE bot_worktrees SET pending_clean = ${encodePending(pending)}
        WHERE worktree_id = ${row.worktree_id}
      `.pipe(Effect.mapError(storage));
      // The filesystem's own clock: what is older than this was there before the switch.
      yield* fs
        .writeFileString(path.join(located.gitDir, SWITCH_STAMP), "")
        .pipe(Effect.mapError((cause) => fail("checkout", "Could not prepare the switch.")(cause)));
      yield* keepHead(target);
      yield* run(
        "checkout",
        target,
        startPoint === `refs/heads/${branch}`
          ? ["switch", "--quiet", branch]
          : // Never -C: an existing branch of that name holds another task's work.
            ["switch", "--quiet", "-c", branch, startPoint],
      );
    }
    if (pending !== null) {
      if (pending.length > 0) yield* removeLeftovers(target, located.gitDir, pending);
      yield* initSubmodules(row.project_id, target);
      yield* sql`UPDATE bot_worktrees SET pending_clean = NULL WHERE worktree_id = ${row.worktree_id}`.pipe(
        Effect.mapError(storage),
      );
    }
    return {
      changed: located.at !== target || !onBranch,
      signature: yield* lockfileSignature(target),
      setupNeeded: yield* setupNeededAt(target, row.setup_signature),
    };
  });

  const take: BotWorktreePool["Service"]["take"] = Effect.fn("BotWorktreePool.take")(
    function* (input) {
      const repo = yield* repositoryOf(input.projectId);
      if (repo === null) return { _tag: "no-git" } as const;
      // A repository without any commit has nothing to branch from, like a folder without Git. A
      // lookup that fails proves nothing, so it fails the task instead.
      const anyRef = yield* run("any-commit", repo.root, [
        "for-each-ref",
        "--count=1",
        "--format=%(objectname)",
        "refs/heads",
        "refs/remotes",
      ]);
      // No ref at all and HEAD naming a branch: that branch is unborn. A detached HEAD must name
      // a commit, and failing to read one fails.
      if (anyRef.stdout.trim() === "") {
        const symbolic = yield* read("unborn", repo.root, ["symbolic-ref", "-q", "HEAD"]);
        if (symbolic.exitCode === 0) return { _tag: "no-git" } as const;
        yield* head(repo.root);
      }
      const directory = yield* poolDirectory(repo.root);
      // A base that does not resolve fails the task before it claims anything.
      const baseRef = yield* resolveBase(repo.root, input.baseBranch);
      while (true) {
        const row = yield* sql
          .withTransaction(claim({ ...input, directory, target: null, admit: true }))
          .pipe(Effect.mapError(storage));
        if (row === undefined) return { _tag: "full" } as const;
        const brought = yield* bringTo(repo, row, input.branch, baseRef);
        if (brought === "gone" || brought === "set-aside") continue;
        yield* recordSetup(
          input.workThreadId,
          brought.setupNeeded ? brought.signature : row.setup_signature,
        );
        return {
          _tag: "pooled",
          worktreePath: row.claimed_path!,
          setupNeeded: brought.setupNeeded,
        } as const;
      }
    },
  );

  const commitIdentity = Effect.fn("BotWorktreePool.commitIdentity")(function* (cwd: string) {
    const email = yield* read("identity", cwd, ["config", "user.email"]);
    return email.stdout.trim() === ""
      ? ["-c", "user.name=T3 Code Bot", "-c", "user.email=bot@t3code.invalid"]
      : [];
  });

  /** Commits uncommitted work, and names a commit no ref holds; how much was saved, and where. */
  const saveWork = Effect.fn("BotWorktreePool.saveWork")(function* (
    target: string,
    input: {
      readonly branch: string;
      readonly commitMessage: string;
      readonly wipBranch: string;
    },
  ) {
    const current = (yield* read("current-branch", target, [
      "symbolic-ref",
      "-q",
      "--short",
      "HEAD",
    ])).stdout.trim();
    const detached = current === "";
    // A release that stopped after moving the work to its WIP branch left HEAD there.
    let savedOn: string | null = current.startsWith(`${input.branch}-wip-`) ? current : null;
    const status = yield* run("status", target, ["status", "--porcelain", "--untracked-files=all"]);
    let savedWork = false;
    if (status.stdout.trim() !== "") {
      if (detached) {
        yield* run("wip-branch", target, ["switch", "-c", input.wipBranch]);
        savedOn = input.wipBranch;
      }
      yield* run("stage", target, ["add", "-A"]);
      // Edits inside a submodule stage nothing here; the later check keeps the checkout for them.
      savedWork = (yield* read("staged", target, ["diff", "--cached", "--quiet"])).exitCode !== 0;
      if (savedWork)
        yield* run("commit", target, [
          ...(yield* commitIdentity(target)),
          "commit",
          "--no-verify",
          "--quiet",
          "-m",
          input.commitMessage,
        ]);
    } else if (detached && !(yield* headOnRef(target))) {
      // A clean detached HEAD can still hold commits; parking would leave them on no branch.
      yield* run("wip-branch", target, ["branch", input.wipBranch, "HEAD"]);
      savedOn = input.wipBranch;
    }
    return { savedWork, savedOn };
  });

  /**
   * Makes a checkout of the thread's branch at its folder the pool's, claimed by the thread: one
   * recreated there for a terminal or a side chat, or one made before the pool made them all.
   */
  const adopt = Effect.fn("BotWorktreePool.adopt")(function* (
    repo: Repository,
    projectId: ProjectId,
    workThreadId: ThreadId,
    target: string,
    branch: string,
  ) {
    const gitDir = yield* worktreeAt(repo, target, null);
    if (gitDir === null) return undefined;
    const current = yield* read("current-branch", target, [
      "symbolic-ref",
      "-q",
      "--short",
      "HEAD",
    ]);
    if (current.stdout.trim() !== branch) return undefined;
    const id = (yield* random.uuidV4().pipe(Effect.orDie)).replaceAll("-", "").slice(0, 12);
    yield* markOwned(gitDir, id);
    // Nothing says what is installed in it.
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO bot_worktrees (worktree_id, project_id, path, claimed_by, claimed_path,
              git_dir, setup_signature, parked_at)
            VALUES (${id}, ${projectId}, ${path.join(path.dirname(target), `bot-pool-${id}`)},
              ${workThreadId}, ${target}, ${gitDir}, ${SETUP_UNKNOWN}, ${yield* nowIso})
          `;
          yield* markHeld(workThreadId);
          yield* sql`UPDATE bot_tasks SET setup_signature = ${SETUP_UNKNOWN}
            WHERE work_thread_id = ${workThreadId}`;
        }),
      )
      .pipe(Effect.mapError(storage));
    return yield* readRow(id).pipe(Effect.mapError(storage));
  });

  /**
   * The claim the thread holds. One carried over from before the pool marked its worktrees is
   * dropped and its checkout left where it is; only a verified checkout of the thread's branch at
   * its folder joins the pool again.
   */
  const ownClaim = Effect.fn("BotWorktreePool.ownClaim")(function* (workThreadId: ThreadId) {
    const [own] = yield* sql<WorktreeRow>`
        SELECT * FROM bot_worktrees WHERE claimed_by = ${workThreadId}
      `;
    if (own?.git_dir !== "") return own;
    yield* sql`DELETE FROM bot_worktrees WHERE worktree_id = ${own.worktree_id}`;
    return undefined;
  }, Effect.mapError(storage));

  const release: BotWorktreePool["Service"]["release"] = Effect.fn("BotWorktreePool.release")(
    function* (input) {
      const none = { savedWork: false, savedOn: null, kept: null };
      const own = yield* ownClaim(input.workThreadId);
      if (own === undefined && input.worktreePath === null) return none;
      const repo = yield* repositoryOf(input.projectId);
      const row =
        own ??
        (repo === null
          ? undefined
          : yield* adopt(
              repo,
              input.projectId,
              input.workThreadId,
              input.worktreePath!,
              input.branch,
            ));
      if (row === undefined) return none;
      const keep = (reason: string) =>
        sql`UPDATE bot_worktrees SET kept_reason = ${reason} WHERE worktree_id = ${row.worktree_id}`.pipe(
          Effect.mapError(storage),
        );
      if (repo === null) {
        const reason = "the project is no longer a Git repository";
        yield* keep(reason);
        return { ...none, kept: reason };
      }
      let saved = { savedWork: false, savedOn: null as string | null };
      const outcome = yield* Effect.gen(function* () {
        const located = yield* locate(repo, row);
        // Removed outside the pool, or never created.
        if (located === null) {
          yield* forget(row, repo.root);
          return { kept: null };
        }
        if (located.at !== row.path) {
          saved = yield* saveWork(located.at, input);
          // Before the worktree moves, so a restart after the move still names the saved work.
          yield* sql`
            UPDATE bot_tasks SET unfinished_work = MAX(unfinished_work, ${saved.savedWork ? 1 : 0}),
              branch = COALESCE(${saved.savedOn}, branch)
            WHERE work_thread_id = ${input.workThreadId}
          `.pipe(Effect.mapError(storage));
          const unsaved = yield* unsavedWork(located.at, null);
          if (unsaved.reason !== null) return { kept: unsaved.reason };
          const room = yield* Effect.all([
            heldCount(input.projectId),
            freeCount(input.projectId),
            sql<{ readonly worktree_state: string | null }>`
              SELECT worktree_state FROM bot_tasks WHERE work_thread_id = ${input.workThreadId}
            `,
          ]).pipe(
            // The worktree being released counts as held only while its task does; one kept for
            // a terminal does not.
            Effect.map(
              ([held, free, [task]]) =>
                held - (task?.worktree_state === "held" ? 1 : 0) + free < BOT_WORKTREE_POOL_LIMIT,
            ),
            Effect.mapError(storage),
          );
          // Git cannot move a worktree with submodules, so such a worktree is not reused; nor one
          // whose run never started, where a cancelled setup may still be writing.
          if (unsaved.force || !room || !input.reuse) {
            yield* keepHead(located.at);
            yield* remove(repo, located.at, unsaved.force);
            yield* forget(row, repo.root);
            return { kept: null };
          }
          // Detached, so the branch is free for a follow-up in another worktree.
          yield* run("detach", located.at, ["switch", "--detach", "--quiet"]);
          // The switch runs the post-checkout hook, after the check above.
          const hooked = yield* unsavedWork(located.at, null);
          if (hooked.reason !== null) return { kept: hooked.reason };
          if (yield* exists(row.path)) return { kept: `${row.path} is in the way of parking it` };
          yield* move(repo, located.at, row.path, located.gitDir);
        } else {
          // A release that stopped after its move, or a claim before it: nothing may have changed
          // at rest since, and the same rule decides whether the worktree is reused.
          const unsaved = yield* unsavedWork(row.path, null);
          if (unsaved.reason !== null) return { kept: unsaved.reason };
          if (!input.reuse) {
            yield* keepHead(row.path);
            yield* remove(repo, row.path, unsaved.force);
            yield* forget(row, repo.root);
            return { kept: null };
          }
        }
        const [task] = yield* sql<{ readonly setup_signature: string | null }>`
          SELECT setup_signature FROM bot_tasks WHERE work_thread_id = ${input.workThreadId}
        `.pipe(Effect.mapError(storage));
        yield* sql`
          UPDATE bot_worktrees SET claimed_by = NULL, claimed_path = NULL, kept_reason = NULL,
            pending_clean = NULL, setup_signature = ${task?.setup_signature ?? SETUP_UNKNOWN},
            parked_at = ${yield* nowIso}, parked_head = ${yield* head(row.path)}
          WHERE worktree_id = ${row.worktree_id}
        `.pipe(Effect.mapError(storage));
        return { kept: null };
      }).pipe(
        // A worktree that cannot be released stays where it is, out of the pool's count.
        Effect.catchIf(
          (error) => error.operation !== "storage",
          (error) => Effect.succeed({ kept: error.detail }),
        ),
      );
      if (outcome.kept !== null) {
        yield* keep(outcome.kept);
        yield* Effect.logWarning("Kept a Bot task worktree out of the pool", {
          workThreadId: input.workThreadId,
          reason: outcome.kept,
        });
      }
      return { ...saved, kept: outcome.kept };
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
      const target = thread.worktreePath;
      const branch = thread.branch;
      const [task] = yield* sql<{ readonly worktree_state: string | null }>`
        SELECT worktree_state FROM bot_tasks WHERE work_thread_id = ${thread.id}
      `.pipe(Effect.mapError(storage));
      if (task?.worktree_state !== "held" && task?.worktree_state !== "released") return false;
      const repo = yield* repositoryOf(thread.projectId);
      if (repo === null) return false;
      const own = yield* ownClaim(thread.id);
      if (own === undefined && (yield* exists(target))) {
        // The thread's own checkout joins the pool; anything else there is not the task's to use.
        if ((yield* adopt(repo, thread.projectId, thread.id, target, branch)) !== undefined)
          return true;
        return yield* fail(
          "restore",
          `${target} holds something other than this task's worktree.`,
        )();
      }
      const directory = yield* poolDirectory(repo.root);
      while (true) {
        const row = yield* sql
          .withTransaction(
            claim({
              projectId: thread.projectId,
              workThreadId: thread.id,
              branch,
              directory,
              target,
              admit: false,
            }),
          )
          .pipe(Effect.mapError(storage));
        if (row === undefined) return yield* Effect.die("an unbounded claim always succeeds");
        const brought = yield* bringTo(repo, row, branch, `refs/heads/${branch}`);
        if (brought === "gone" || brought === "set-aside") continue;
        // Already in place, as at turn start after the launch: its setup stands. Brought here, the
        // install matches HEAD only if the lockfiles did not change; a follow-up runs no setup.
        if (brought.changed)
          yield* recordSetup(thread.id, brought.setupNeeded ? SETUP_UNKNOWN : row.setup_signature);
        return true;
      }
    },
  );

  const claimedPath: BotWorktreePool["Service"]["claimedPath"] = (workThreadId) =>
    sql<{ readonly claimed_path: string | null }>`
      SELECT claimed_path FROM bot_worktrees WHERE claimed_by = ${workThreadId}
    `.pipe(
      Effect.map((rows) => rows[0]?.claimed_path ?? null),
      Effect.mapError(storage),
    );

  const keptOf = (row: WorktreeRow): KeptWorktree => ({
    path: row.claimed_path ?? row.path,
    workThreadId: row.claimed_by as ThreadId | null,
    reason: row.kept_reason ?? "",
  });

  const inventory: BotWorktreePool["Service"]["inventory"] = (projectId) =>
    sql<WorktreeRow>`SELECT * FROM bot_worktrees WHERE project_id = ${projectId}`.pipe(
      Effect.map((rows) => ({
        free: rows
          .filter((row) => row.claimed_by === null && row.kept_reason === null)
          .map((row) => row.path),
        kept: rows.filter((row) => row.kept_reason !== null).map(keptOf),
      })),
      Effect.mapError(storage),
    );

  const keep: BotWorktreePool["Service"]["keep"] = (input) =>
    sql<{ readonly worktree_id: string }>`
      UPDATE bot_worktrees SET kept_reason = ${input.reason} WHERE claimed_by = ${input.workThreadId}
      RETURNING worktree_id
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(storage),
    );

  const keptClaims: BotWorktreePool["Service"]["keptClaims"] = sql<WorktreeRow>`
    SELECT * FROM bot_worktrees
    WHERE kept_reason IS NOT NULL AND claimed_by IS NOT NULL AND claimed_by <> ${REMOVING}
  `.pipe(
    Effect.map((rows) => rows.map(keptOf)),
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
      fs.exists(target).pipe(
        Effect.orElseSucceed(() => false),
        Effect.flatMap((present) => (present ? sizeOf(target) : Effect.succeed(0))),
      ),
    ).pipe(
      Effect.map((sizes) => sizes.reduce((sum, size) => sum + size, 0)),
      Effect.orElseSucceed(() => null),
      Effect.withSpan("BotWorktreePool.measure"),
    );

  /**
   * Removes unclaimed worktrees at rest that hold nothing to lose; returns how many. One with
   * changes since it was parked is set aside instead. Picked and reserved in one statement, so a
   * worktree claimed and parked again meanwhile is not picked.
   */
  const removeResting = Effect.fn("BotWorktreePool.removeResting")(function* (
    filter: { readonly projectId: ProjectId } | { readonly before: string },
  ) {
    const rows = yield* (
      "projectId" in filter
        ? sql<WorktreeRow>`
          UPDATE bot_worktrees SET claimed_by = ${REMOVING}
          WHERE project_id = ${filter.projectId} AND claimed_by IS NULL
          RETURNING *
        `
        : sql<WorktreeRow>`
          UPDATE bot_worktrees SET claimed_by = ${REMOVING}
          WHERE parked_at < ${filter.before} AND claimed_by IS NULL AND kept_reason IS NULL
          RETURNING *
        `
    ).pipe(Effect.mapError(storage));
    let removed = 0;
    for (const row of rows) {
      const outcome = yield* Effect.gen(function* () {
        const repo = yield* repositoryOf(row.project_id as ProjectId);
        if (repo === null) return { kept: row.kept_reason };
        if (!(yield* exists(row.path))) {
          yield* forget(row, repo.root);
          return "removed" as const;
        }
        // A row never seen has its worktree under its own id at rest; one seen carries the mark.
        const gitDir = yield* worktreeAt(repo, row.path, row.git_dir || null);
        if (gitDir === null || (row.git_dir !== null && !(yield* owned(gitDir, row.worktree_id))))
          return { kept: "is not the worktree the pool made" };
        const unsaved = yield* unsavedWork(row.path, row.parked_head);
        if (unsaved.reason !== null) return { kept: unsaved.reason };
        yield* keepHead(row.path);
        yield* remove(repo, row.path, unsaved.force);
        yield* forget(row, repo.root);
        return "removed" as const;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not remove a free Bot worktree", { path: row.path, cause }).pipe(
            Effect.as({ kept: row.kept_reason }),
          ),
        ),
      );
      if (outcome === "removed") {
        removed++;
        continue;
      }
      yield* sql`
        UPDATE bot_worktrees SET claimed_by = NULL, kept_reason = ${outcome.kept}
        WHERE worktree_id = ${row.worktree_id}
      `.pipe(Effect.mapError(storage));
    }
    return removed;
  });

  const clear: BotWorktreePool["Service"]["clear"] = (projectId) => removeResting({ projectId });

  const expire: BotWorktreePool["Service"]["expire"] = Effect.gen(function* () {
    const before = DateTime.formatIso(
      DateTime.subtract(yield* DateTime.now, { days: BOT_WORKTREE_IDLE_DAYS }),
    );
    yield* removeResting({ before });
  }).pipe(Effect.withSpan("BotWorktreePool.expire"));

  return BotWorktreePool.of({
    take,
    release,
    restore,
    inventory,
    keep,
    keptClaims,
    claimedPath,
    measure,
    clear,
    expire,
  });
});

export const layer = Layer.effect(BotWorktreePool, make);
