import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function homeListFilterEnvironments(environments: ReadonlyArray<WorkspaceEnvironment>) {
  return Arr.sort(
    environments
      .filter((environment) => environment.isEnabled)
      .map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.environmentLabel,
        connectionState: environment.connectionState,
      })),
    Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
  );
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

export type HomeProjectFilterChoice =
  | { readonly kind: "all" }
  | { readonly kind: "project"; readonly key: string }
  /** `null` is "No area". */
  | { readonly kind: "area"; readonly area: string | null };

export interface HomeProjectFilterMenu {
  readonly areas: readonly string[];
  /** Offered only when it narrows the list. */
  readonly noArea: boolean;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selected: HomeProjectFilterChoice;
}

export interface HomeProjectFilterRow {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly selected: boolean;
  readonly choice: HomeProjectFilterChoice;
}

/** The project filter's rows: all projects, each area, No area, then each project. */
export function homeProjectFilterRows(menu: HomeProjectFilterMenu): HomeProjectFilterRow[] {
  const { selected } = menu;
  return [
    {
      id: "project:all",
      title: "All projects",
      subtitle: "Show threads from every project",
      selected: selected.kind === "all",
      choice: { kind: "all" },
    },
    ...menu.areas.map((area, index) => ({
      id: `area:${index}`,
      title: area,
      subtitle: "Area",
      selected: selected.kind === "area" && selected.area === area,
      choice: { kind: "area", area } as const,
    })),
    ...(menu.noArea
      ? [
          {
            id: "area:none",
            title: "No area",
            subtitle: "Projects without an area",
            selected: selected.kind === "area" && selected.area === null,
            choice: { kind: "area", area: null } as const,
          },
        ]
      : []),
    ...menu.projects.map((project) => ({
      id: `project:${project.key}`,
      title: project.label,
      selected: selected.kind === "project" && selected.key === project.key,
      choice: { kind: "project", key: project.key } as const,
    })),
  ];
}

export function buildHomeListFilterMenuItems(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projectFilter: HomeProjectFilterMenu;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectFilterChange: (choice: HomeProjectFilterChoice) => void;
}): AppBarMenuItem[] {
  const items: AppBarMenuItem[] = [
    {
      id: "environment",
      title: "Environment",
      items: [
        {
          id: "environment:all",
          title: "All environments",
          subtitle: "Show threads from every environment",
          selected: props.selectedEnvironmentId === null,
          onPress: () => props.onEnvironmentChange(null),
        },
        ...props.environments.map((environment) => ({
          id: `environment:${environment.environmentId}`,
          title: environment.label,
          selected: props.selectedEnvironmentId === environment.environmentId,
          onPress: () => props.onEnvironmentChange(environment.environmentId),
        })),
      ],
    },
  ];

  if (props.projectFilter.projects.length > 0) {
    items.push({
      id: "project",
      title: "Project",
      items: homeProjectFilterRows(props.projectFilter).map(({ choice, ...row }) => ({
        ...row,
        onPress: () => props.onProjectFilterChange(choice),
      })),
    });
  }

  return items;
}
