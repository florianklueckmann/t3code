import {
  pickableProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";

import { listProjectAreas, resolveAreaScopedProjectKeys } from "../projectAreas";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useProjects } from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

/** The sidebar's selected area as `environmentId:projectId` keys, or null while it filters nothing. */
export function useAreaScopedProjectKeys(): ReadonlySet<string> | null {
  const areaScope = useUiStateStore((store) => store.sidebarAreaScope);
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (areaScope === null) return null;
  const groups = buildSidebarProjectSnapshots({
    projects,
    groupScratchProjects: true,
    settings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: () => null,
  });
  const pickable = pickableProjectGroups(groups);
  // Like the sidebar: "No area" is offered only while an area exists.
  if (areaScope.area === null && listProjectAreas(pickable).length === 0) return null;
  return resolveAreaScopedProjectKeys(pickable, areaScope.area);
}
