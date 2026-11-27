import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BotId, botHomeProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as BotHomeFolders from "./BotHomeFolders.ts";

const layer = (baseDir: string) =>
  BotHomeFolders.layer.pipe(
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(
      ProjectEnrichmentService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
              resolve: () => Effect.succeed(null),
            }),
            Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
              invalidate: () => Effect.void,
              resolvePath: () => Effect.succeed(null),
            }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(
      GitWorkflow.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
        Layer.provide(Layer.mock(GitManager.GitManager)({})),
      ),
    ),
    Layer.provideMerge(GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const git = (cwd: string, args: ReadonlyArray<string>) =>
  ProcessRunner.ProcessRunner.pipe(
    Effect.flatMap((runner) => runner.run({ command: "git", args: ["-C", cwd, ...args] })),
    Effect.provide(ProcessRunner.layer),
  );

it.effect(
  "gives a Bot a hidden project in its own repository, even when the T3 home is inside a checkout",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bot-home-repo-" });
      yield* git(checkout, ["init", "--quiet"]);
      const baseDir = path.join(checkout, ".t3");
      yield* fileSystem.makeDirectory(baseDir);
      const botId = BotId.make("companion");
      // What an interrupted first init can leave; Git would resolve the checkout from it.
      yield* fileSystem.makeDirectory(path.join(baseDir, "bots", botId, ".git"), {
        recursive: true,
      });
      yield* Effect.gen(function* () {
        const folders = yield* BotHomeFolders.BotHomeFolders;
        const projects = yield* ProjectService.ProjectService;
        const [first, racing] = yield* Effect.all(
          [folders.ensureProject(botId), folders.ensureProject(botId)],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(racing, first);
        assert.equal(first.projectId, botHomeProjectId(botId));
        const repositoryRoot = (yield* git(first.workspaceRoot, ["rev-parse", "--show-toplevel"]))
          .stdout;
        assert.equal(
          yield* fileSystem.realPath(repositoryRoot.trim()),
          yield* fileSystem.realPath(path.join(baseDir, "bots", botId)),
        );

        assert.deepStrictEqual(yield* folders.ensureProject(botId), first);
        const project = Option.getOrThrow(yield* projects.getById(first.projectId));
        assert.equal(project.workspaceRoot, first.workspaceRoot);
        const listed = yield* projects.listPage({ cursor: 0, limit: 20 });
        assert.deepStrictEqual(listed.projects, []);
      }).pipe(Effect.provide(layer(baseDir)));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
