import { isBotHomeProjectId, type ProjectMutation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { type ProjectCloneTracker } from "./ProjectCloneTracker.ts";
import { ProjectInvalidError, type ProjectService } from "./ProjectService.ts";

type ProjectMutations = Pick<ProjectService["Service"], "create" | "delete" | "update">;

export const BOT_HOME_PROJECT_REFUSAL =
  "This project holds a Bot's own Home and is managed by T3 Code, so it cannot be created, changed or deleted here.";

export const projectMutationOperation = Effect.fn("projectMutationOperation")(function* (
  projects: ProjectMutations,
  mutation: ProjectMutation,
) {
  // Only BotHomeFolders creates these, through ProjectService directly.
  if (isBotHomeProjectId(mutation.projectId)) {
    return yield* new ProjectInvalidError({
      projectId: mutation.projectId,
      detail: BOT_HOME_PROJECT_REFUSAL,
    });
  }
  switch (mutation.type) {
    case "project.create":
      return yield* projects.create({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        title: mutation.title,
        workspaceRoot: mutation.workspaceRoot,
        ...(mutation.createWorkspaceRootIfMissing === undefined
          ? {}
          : { createWorkspaceRootIfMissing: mutation.createWorkspaceRootIfMissing }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
        ...(mutation.area == null ? {} : { area: mutation.area }),
      });

    case "project.update":
      return yield* projects.update({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
        ...(mutation.workspaceRoot === undefined ? {} : { workspaceRoot: mutation.workspaceRoot }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.autoPull === undefined ? {} : { autoPull: mutation.autoPull }),
        ...(mutation.projectIcon === undefined ? {} : { projectIcon: mutation.projectIcon }),
        ...(mutation.faviconPath === undefined ? {} : { faviconPath: mutation.faviconPath }),
        ...(mutation.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: mutation.defaultThreadEnvMode }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
        ...(mutation.pinned === undefined ? {} : { pinned: mutation.pinned }),
        ...(mutation.archived === undefined ? {} : { archived: mutation.archived }),
        ...(mutation.area === undefined ? {} : { area: mutation.area }),
      });

    case "project.delete":
      return yield* projects.delete({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.force === undefined ? {} : { force: mutation.force }),
      });
  }
});

// A disconnect after deletion commits must not leave the in-memory clone record behind.
export const mutateProjectWithClone = Effect.fn("mutateProjectWithClone")(function* (
  projects: ProjectMutations,
  clones: Pick<ProjectCloneTracker["Service"], "discard">,
  mutation: ProjectMutation,
) {
  if (mutation.type !== "project.delete")
    return yield* projectMutationOperation(projects, mutation);
  return yield* projectMutationOperation(projects, mutation).pipe(
    Effect.tap(() => clones.discard(mutation.projectId)),
    Effect.uninterruptible,
  );
});
