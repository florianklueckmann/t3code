import type { ProjectAreaChoice } from "@t3tools/client-runtime/state/project-areas";
import type { ContextMenuItem } from "@t3tools/contracts";

/** The Area submenu for a project: each existing area, a new one, or none. */
export function buildProjectAreaMenu(input: {
  readonly areas: readonly string[];
  readonly current: readonly string[];
}): {
  readonly item: ContextMenuItem;
  readonly choiceFor: (id: string) => ProjectAreaChoice | null;
} {
  return {
    item: {
      id: "area",
      label: "Area",
      icon: "tag",
      children: [
        ...input.areas.map((area, index) => ({
          id: `area:${index}`,
          label: area,
          checked: input.current.includes(area),
        })),
        { id: "area:new", label: "New area…", separatorBefore: input.areas.length > 0 },
        { id: "area:none", label: "No area", checked: input.current.length === 0 },
      ],
    },
    choiceFor: (id) => {
      if (id === "area:new") return { kind: "new" };
      if (id === "area:none") return { kind: "clear" };
      const area = id.startsWith("area:") ? input.areas[Number(id.slice(5))] : undefined;
      return area === undefined ? null : { kind: "set", area };
    },
  };
}
