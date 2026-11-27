import { type BotId, botHomeProjectId, CommandId, type ProjectId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export class BotHomeFolderError extends Schema.TaggedError<BotHomeFolderError>()(
  "BotHomeFolderError",
  {
    folder: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prepare the Bot's Home folder ${this.folder}.`;
  }
}

/** Each Bot-level Home's folder and the hidden project rooted there. */
export class BotHomeFolders extends Context.Service<
  BotHomeFolders,
  {
    /** `<T3 home>/bots`, with one folder per Bot below it. */
    readonly root: string;
    /** Creates what is missing; a repeated call finds the same folder and project. */
    readonly ensureProject: (
      botId: BotId,
    ) => Effect.Effect<
      { readonly projectId: ProjectId; readonly workspaceRoot: string },
      BotHomeFolderError
    >;
  }
>()("t3/bots/BotHomeFolders") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectService.ProjectService;
  const root = path.resolve(config.baseDir, "bots");
  // Concurrent `git init` runs in one folder collide on Git's lock and template files.
  const locks = yield* KeyedLock.make<BotId>();

  const ensureProject: BotHomeFolders["Service"]["ensureProject"] = Effect.fn(
    "BotHomeFolders.ensureProject",
  )(
    function* (botId) {
      const folder = path.join(root, botId);
      const projectId = botHomeProjectId(botId);
      const fail = (cause: unknown) => new BotHomeFolderError({ folder, cause });
      yield* fileSystem.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(fail));
      // Its own repository: a T3 home inside a checkout (every dev worktree's .t3) would
      // otherwise put the Home's checkpoints and diffs on that checkout. Asking Git, not
      // checking for .git, also completes an empty .git that an interrupted init left.
      const topLevel = yield* git
        .execute({
          operation: "BotHomeFolders.topLevel",
          cwd: folder,
          args: ["rev-parse", "--show-toplevel"],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        })
        .pipe(Effect.mapError(fail));
      const real = (target: string) => fileSystem.realPath(target).pipe(Effect.mapError(fail));
      const ownRepository =
        topLevel.exitCode === 0 &&
        (yield* real(topLevel.stdout.replace(/\r?\n$/, ""))) === (yield* real(folder));
      if (!ownRepository) {
        yield* git
          .execute({
            operation: "BotHomeFolders.init",
            cwd: folder,
            args: ["init", "--quiet"],
            timeoutMs: 10_000,
          })
          .pipe(Effect.mapError(fail));
      }
      const { project } = yield* projects
        .bootstrap({
          commandId: CommandId.make(`bot-home-project:${botId}`),
          projectId,
          title: "Bot Home",
          workspaceRoot: folder,
        })
        .pipe(Effect.mapError(fail));
      if (project.id !== projectId) {
        return yield* fail(`The folder already belongs to project ${project.id}.`);
      }
      return { projectId, workspaceRoot: project.workspaceRoot };
    },
    (effect, botId) => locks.withLock(botId, effect),
  );

  return BotHomeFolders.of({ root, ensureProject });
});

export const layer = Layer.effect(BotHomeFolders, make);
