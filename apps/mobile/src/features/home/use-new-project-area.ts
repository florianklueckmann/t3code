import { newProjectAreaFor } from "@t3tools/client-runtime/state/project-areas";
import type { EnvironmentId } from "@t3tools/contracts";

import { useProjects, useServerConfigs } from "../../state/entities";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useHomeListOptions } from "./home-list-options";
import { buildHomeProjectScopes, resolveHomeAreaFilter } from "./homeThreadList";

/**
 * The thread list's area as the list applies it, within its selected environment, for screens
 * that do not render the list. Null while no area applies.
 */
export function useHomeAreaFilter() {
  const projects = useProjects();
  const environments = useWorkspaceEnvironments();
  const { options, setSelectedProjectKey } = useHomeListOptions(
    new Set(
      environments
        .filter((environment) => environment.isEnabled)
        .map((environment) => environment.environmentId),
    ),
  );
  const areaFilter =
    options.selectedArea === null
      ? null
      : resolveHomeAreaFilter(
          buildHomeProjectScopes({
            projects,
            environmentId: options.selectedEnvironmentId,
            projectGroupingMode: options.projectGroupingMode,
          }),
          options.selectedArea,
        );
  return { options, projects, areaFilter, setSelectedProjectKey };
}

/**
 * The area a project added now starts in, for `project.create`: the thread list's selected area,
 * on servers that keep areas.
 */
export function useNewProjectArea(): (environmentId: EnvironmentId) => string | undefined {
  const serverConfigs = useServerConfigs();
  const area = newProjectAreaFor(useHomeAreaFilter().areaFilter?.scope ?? null);
  return (environmentId) =>
    serverConfigs.get(environmentId)?.environment.capabilities.projectAreas === true
      ? area
      : undefined;
}
