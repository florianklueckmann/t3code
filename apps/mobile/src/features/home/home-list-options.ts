import type { EnvironmentId, SidebarProjectGroupingMode } from "@t3tools/contracts";
import { DEFAULT_SIDEBAR_PROJECT_SORT_ORDER } from "@t3tools/contracts";
import type { ProjectAreaScope } from "@t3tools/client-runtime/state/project-areas";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { createContext, createElement, useContext, useState, type PropsWithChildren } from "react";

import type { ThreadListFilters } from "../../persistence/mobile-preferences";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import type { HomeProjectSortOrder } from "./homeThreadList";

export interface HomeListOptions {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  /** Exclusive with `selectedProjectKey`: setting one clears the other. */
  readonly selectedArea: ProjectAreaScope | null;
  readonly projectSortOrder: HomeProjectSortOrder;
}

export interface ResolvedHomeListOptions extends HomeListOptions {
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

function defaultHomeListOptions(filters?: ThreadListFilters): HomeListOptions {
  return {
    selectedEnvironmentId: filters?.environmentId ?? null,
    selectedProjectKey: filters?.areaScope ? null : (filters?.projectKey ?? null),
    selectedArea: filters?.areaScope ?? null,
    projectSortOrder:
      DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
        ? "updated_at"
        : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  };
}

interface HomeListOptionsContextValue {
  readonly options: HomeListOptions;
  readonly updateOptions: (patch: Partial<HomeListOptions>) => void;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

const HomeListOptionsContext = createContext<HomeListOptionsContextValue | null>(null);

export function HomeListOptionsProvider({
  children,
  projectGroupingMode,
  savedFilters,
}: PropsWithChildren<{
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly savedFilters?: ThreadListFilters | undefined;
}>) {
  const registry = useContext(RegistryContext);
  const [optionsAtom] = useState(() => Atom.make(defaultHomeListOptions(savedFilters)));
  const options = useAtomValue(optionsAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  // Only the scope persists; the sort order is per session. Updates read the
  // registry, so several in one event each build on the last and save it.
  const updateOptions = (patch: Partial<HomeListOptions>) => {
    const current = registry.get(optionsAtom);
    const next = { ...current, ...patch };
    registry.set(optionsAtom, next);
    if (
      next.selectedEnvironmentId !== current.selectedEnvironmentId ||
      next.selectedProjectKey !== current.selectedProjectKey ||
      JSON.stringify(next.selectedArea) !== JSON.stringify(current.selectedArea)
    ) {
      savePreferences({
        threadListFilters: {
          environmentId: next.selectedEnvironmentId,
          projectKey: next.selectedProjectKey,
          areaScope: next.selectedArea,
        },
      });
    }
  };
  const value = { options, updateOptions, projectGroupingMode };
  return createElement(HomeListOptionsContext, { value }, children);
}

export function useHomeListOptions(availableEnvironmentIds: ReadonlySet<EnvironmentId>) {
  const shared = useContext(HomeListOptionsContext);
  const [localOptions, setLocalOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const options = shared?.options ?? localOptions;
  const updateOptions =
    shared?.updateOptions ??
    ((patch: Partial<HomeListOptions>) => setLocalOptions((current) => ({ ...current, ...patch })));
  const selectedEnvironmentId =
    options.selectedEnvironmentId !== null &&
    availableEnvironmentIds.has(options.selectedEnvironmentId)
      ? options.selectedEnvironmentId
      : null;
  const availableOptions =
    selectedEnvironmentId === options.selectedEnvironmentId
      ? options
      : { ...options, selectedEnvironmentId };
  const resolvedOptions: ResolvedHomeListOptions = {
    ...availableOptions,
    projectGroupingMode: shared?.projectGroupingMode ?? "repository",
  };

  const setSelectedEnvironmentId = (value: EnvironmentId | null) => {
    updateOptions({ selectedEnvironmentId: value });
  };
  const setSelectedProjectKey = (value: string | null) => {
    updateOptions({ selectedProjectKey: value, selectedArea: null });
  };
  const setSelectedArea = (area: string | null) => {
    updateOptions({ selectedProjectKey: null, selectedArea: { area } });
  };
  const setProjectSortOrder = (value: HomeProjectSortOrder) => {
    updateOptions({ projectSortOrder: value });
  };
  return {
    options: resolvedOptions,
    setSelectedEnvironmentId,
    setSelectedProjectKey,
    setSelectedArea,
    setProjectSortOrder,
  } as const;
}
