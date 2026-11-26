import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useEffect, useMemo, useRef } from "react";

import { useProjects } from "../../state/entities";
import { ALL_ENVIRONMENTS } from "./use-new-project-area";
import { useConnectedBots } from "../bots/bots-across-environments";
import { useThreadListNow } from "../threads/use-thread-list-now";
import { opensOutsideHomeArea, resolveHomeAreaDot } from "./home-area-filter";
import type { HomeProjectFilterChoice, HomeProjectFilterMenu } from "./home-list-filter-menu";
import { useHomeListOptions, type ResolvedHomeListOptions } from "./home-list-options";
import {
  buildHomeProjectScopes,
  homeAreaFilterOptions,
  resolveHomeAreaFilter,
  resolveHomeProjectFilterScope,
  sortHomeProjectScopes,
} from "./homeThreadList";

/**
 * The thread list's project filter: a single project, an area, or every project. Home, the
 * workspace sidebar and new tasks read it the same way.
 */
export function useHomeProjectFilter(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly options: ResolvedHomeListOptions;
  readonly setSelectedProjectKey: (key: string | null) => void;
  readonly setSelectedArea: (area: string | null) => void;
}) {
  const { projects, threads, options } = input;
  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        environmentId: options.selectedEnvironmentId,
        projectGroupingMode: options.projectGroupingMode,
      }),
    [projects, options.selectedEnvironmentId, options.projectGroupingMode],
  );
  const projectScope =
    options.selectedArea === null
      ? resolveHomeProjectFilterScope(projectScopes, projects, options)
      : null;
  const { selectedArea } = options;
  // Memoized: the list's derivation keys on the identity of the refs it shows.
  const areaFilter = useMemo(
    () => (selectedArea === null ? null : resolveHomeAreaFilter(projectScopes, selectedArea)),
    [projectScopes, selectedArea],
  );
  const { areas, noArea } = homeAreaFilterOptions(projectScopes);
  const menu: HomeProjectFilterMenu = {
    areas,
    noArea,
    projects: pickableProjectGroups(
      sortHomeProjectScopes({
        scopes: projectScopes,
        threads,
        pendingTasks: [],
        projectSortOrder: "updated_at",
      }),
    ).map((scope) => ({ key: scope.key, label: scope.title })),
    selected:
      areaFilter !== null
        ? { kind: "area", area: areaFilter.scope.area }
        : projectScope !== null
          ? { kind: "project", key: projectScope.key }
          : { kind: "all" },
  };
  const bots = useConnectedBots();
  const now = useThreadListNow(threads);
  const dot =
    areaFilter === null
      ? null
      : resolveHomeAreaDot({
          threads,
          scopedProjectKeys: areaFilter.scopedProjectKeys,
          bots,
          environmentId: options.selectedEnvironmentId,
          now,
        });
  const choose = (choice: HomeProjectFilterChoice) => {
    if (choice.kind === "area") input.setSelectedArea(choice.area);
    else input.setSelectedProjectKey(choice.kind === "project" ? choice.key : null);
  };
  return {
    projectScopes,
    /** The single project the list shows, if one is picked. */
    projectScope,
    areaFilter,
    /** The projects the list shows; null shows every project. */
    projectRefs: projectScope?.projectRefs ?? areaFilter?.projectRefs ?? null,
    label: projectScope?.title ?? (areaFilter ? (areaFilter.scope.area ?? "No area") : null),
    menu,
    dot,
    choose,
  };
}

/**
 * Opening a thread the area hides, or the Home of a Bot the Bot row hides, shows all projects
 * again. Judged once per opened thread, so an area picked while it stays open sticks.
 */
export function useLeaveAreaForOpenThread(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId"> | null,
) {
  const projects = useProjects();
  const bots = useConnectedBots();
  const { options, setSelectedProjectKey } = useHomeListOptions(ALL_ENVIRONMENTS);
  const judgedKey = useRef<string | null>(null);
  const threadKey = thread === null ? null : `${thread.environmentId}:${thread.id}`;
  const areaFilter =
    options.selectedArea === null || projects.length === 0
      ? null
      : resolveHomeAreaFilter(
          buildHomeProjectScopes({
            projects,
            environmentId: null,
            projectGroupingMode: options.projectGroupingMode,
          }),
          options.selectedArea,
        );
  // Null waits: for the thread, for an area saved before the projects loaded, or for a Home's Bot.
  const leaves =
    thread === null
      ? null
      : options.selectedArea === null
        ? false
        : projects.length === 0
          ? null
          : areaFilter === null
            ? false
            : opensOutsideHomeArea({
                thread,
                scopedProjectKeys: areaFilter.scopedProjectKeys,
                bots,
              });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes an opened thread's reveal to the saved thread list filter, which lives outside this screen
  useEffect(() => {
    if (threadKey === null || leaves === null || judgedKey.current === threadKey) return;
    judgedKey.current = threadKey;
    if (leaves) setSelectedProjectKey(null);
  }, [leaves, setSelectedProjectKey, threadKey]);
}
