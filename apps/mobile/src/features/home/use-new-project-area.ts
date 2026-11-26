import { newProjectAreaFor } from "@t3tools/client-runtime/state/project-areas";
import type { EnvironmentId } from "@t3tools/contracts";

import { useProjects, useServerConfigs } from "../../state/entities";
import { useHomeListOptions } from "./home-list-options";
import { buildHomeProjectScopes, resolveHomeAreaFilter } from "./homeThreadList";

// The area applies on every environment, so it is judged across all of them.
export const ALL_ENVIRONMENTS: ReadonlySet<EnvironmentId> = new Set();

/**
 * The area a project added now starts in, for `project.create`: the thread list's selected area,
 * on servers that keep areas.
 */
export function useNewProjectArea(): (environmentId: EnvironmentId) => string | undefined {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { options } = useHomeListOptions(ALL_ENVIRONMENTS);
  const areaFilter =
    options.selectedArea === null
      ? null
      : resolveHomeAreaFilter(
          buildHomeProjectScopes({
            projects,
            environmentId: null,
            projectGroupingMode: options.projectGroupingMode,
          }),
          options.selectedArea,
        );
  const area = newProjectAreaFor(areaFilter?.scope ?? null);
  return (environmentId) =>
    serverConfigs.get(environmentId)?.environment.capabilities.projectAreas === true
      ? area
      : undefined;
}
