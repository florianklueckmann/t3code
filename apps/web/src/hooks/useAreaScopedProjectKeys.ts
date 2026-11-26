import type { EnvironmentId } from "@t3tools/contracts";
import {
  newProjectAreaFor,
  resolveAreaScopedProjectKeys,
  resolveProjectAreaScope,
} from "@t3tools/client-runtime/state/project-areas";
import {
  pickableProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";

import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useServerConfigs } from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

/** The sidebar's area as it applies, or null while it filters nothing. */
function useSidebarAreaScope() {
  const savedScope = useUiStateStore((store) => store.sidebarAreaScope);
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (savedScope === null) return null;
  const pickable = pickableProjectGroups(
    buildSidebarProjectSnapshots({
      projects,
      groupScratchProjects: true,
      settings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    }),
  );
  const scope = resolveProjectAreaScope(pickable, savedScope);
  return scope === null
    ? null
    : { scope, scopedProjectKeys: resolveAreaScopedProjectKeys(pickable, scope.area) };
}

/** The sidebar's selected area as `environmentId:projectId` keys, or null while it filters nothing. */
export function useAreaScopedProjectKeys(): ReadonlySet<string> | null {
  return useSidebarAreaScope()?.scopedProjectKeys ?? null;
}

/**
 * The area a project added now starts in, for `project.create`: the sidebar's selected area, on
 * servers that keep areas.
 */
export function useNewProjectArea(): (environmentId: EnvironmentId) => string | undefined {
  const area = newProjectAreaFor(useSidebarAreaScope()?.scope ?? null);
  const serverConfigs = useServerConfigs();
  return (environmentId) =>
    serverConfigs.get(environmentId)?.environment.capabilities.projectAreas === true
      ? area
      : undefined;
}
