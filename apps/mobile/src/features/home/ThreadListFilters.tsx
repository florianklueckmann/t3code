import { Pressable, ScrollView } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  homeProjectFilterRows,
  type HomeListFilterMenuEnvironment,
  type HomeProjectFilterChoice,
  type HomeProjectFilterMenu,
} from "./home-list-filter-menu";

export function ThreadListFilters(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projectFilter: HomeProjectFilterMenu;
  /** The project filter's label while it narrows the list. */
  readonly projectFilterLabel: string | null;
  /** Something the area hides needs the user, as a dot color class. */
  readonly projectFilterDotClassName: string | null;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectFilterChange: (choice: HomeProjectFilterChoice) => void;
  /** List padding the scroller bleeds through so pills start where row content does. */
  readonly gutter: number;
}) {
  const selectedEnvironment = props.environments.find(
    (environment) => environment.environmentId === props.selectedEnvironmentId,
  );
  const projectRows = homeProjectFilterRows(props.projectFilter);
  const projectFiltered = props.projectFilter.selected.kind !== "all";
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginHorizontal: -props.gutter, overflow: "visible" }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 2, paddingBottom: 10, gap: 8 }}
    >
      <ListFilterMenu
        label={selectedEnvironment?.label ?? "All environments"}
        accessibilityLabel="Filter threads by environment"
        active={selectedEnvironment !== undefined}
        actions={[
          {
            id: "all",
            title: "All environments",
            state: props.selectedEnvironmentId === null ? "on" : "off",
          },
          ...props.environments.map((environment) => ({
            id: JSON.stringify(environment.environmentId),
            title: environment.label,
            state:
              environment.environmentId === props.selectedEnvironmentId
                ? ("on" as const)
                : ("off" as const),
          })),
        ]}
        onSelect={(id) => {
          if (id === "all") props.onEnvironmentChange(null);
          else {
            const environment = props.environments.find(
              (candidate) => JSON.stringify(candidate.environmentId) === id,
            );
            if (environment) props.onEnvironmentChange(environment.environmentId);
          }
        }}
      />
      <ListFilterMenu
        label={props.projectFilterLabel ?? "All projects"}
        accessibilityLabel={
          props.projectFilterDotClassName === null
            ? "Filter threads by project"
            : "Filter threads by project, something outside needs you"
        }
        active={projectFiltered}
        dotClassName={props.projectFilterDotClassName}
        actions={projectRows.map((row) => ({
          id: row.id,
          title: row.title,
          ...(row.subtitle === undefined || row.choice.kind === "all"
            ? {}
            : { subtitle: row.subtitle }),
          state: row.selected ? ("on" as const) : ("off" as const),
        }))}
        onSelect={(id) => {
          const row = projectRows.find((candidate) => candidate.id === id);
          if (row) props.onProjectFilterChange(row.choice);
        }}
      />
      {props.selectedEnvironmentId !== null || projectFiltered ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset thread filters"
          className="h-8 w-8 items-center justify-center"
          onPress={() => {
            props.onEnvironmentChange(null);
            props.onProjectFilterChange({ kind: "all" });
          }}
        >
          <SymbolView name="xmark.circle.fill" size={18} tintColorClassName="accent-icon-muted" />
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
