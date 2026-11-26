import {
  PROJECT_AREA_MAX_LENGTH,
  type ContextMenuItem,
  type ScopedProjectRef,
} from "@t3tools/contracts";

interface AreaGroup {
  readonly memberProjects: ReadonlyArray<{ readonly area?: string | null | undefined }>;
}

/** Checkouts on machines that were offline during a change can disagree, so a group can hold several. */
export function projectGroupAreas(group: AreaGroup): string[] {
  return [...new Set(group.memberProjects.flatMap((member) => (member.area ? [member.area] : [])))];
}

export function listProjectAreas(groups: ReadonlyArray<AreaGroup>): string[] {
  return [...new Set(groups.flatMap(projectGroupAreas))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

/** `null` is "No area". */
export function isProjectGroupInArea(group: AreaGroup, area: string | null): boolean {
  const areas = projectGroupAreas(group);
  return area === null ? areas.length === 0 : areas.includes(area);
}

/** `environmentId:projectId` keys an area lists, or null when it lists no project and so filters nothing. */
export function resolveAreaScopedProjectKeys(
  groups: ReadonlyArray<AreaGroup & { readonly memberProjectRefs: readonly ScopedProjectRef[] }>,
  area: string | null,
): ReadonlySet<string> | null {
  const keys = new Set(
    groups
      .filter((group) => isProjectGroupInArea(group, area))
      .flatMap((group) =>
        group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
      ),
  );
  return keys.size === 0 ? null : keys;
}

/** A Bot shows while any project it works in is listed. A Bot without a project always shows. */
export function isBotInProjectScope(
  botProjectKeys: readonly string[],
  scopedProjectKeys: ReadonlySet<string> | null,
): boolean {
  return (
    scopedProjectKeys === null ||
    botProjectKeys.length === 0 ||
    botProjectKeys.some((key) => scopedProjectKeys.has(key))
  );
}

export type ProjectAreaInput =
  | { readonly ok: true; readonly area: string }
  | { readonly ok: false; readonly error: string };

/** Typing an existing area in other letter case reuses its spelling instead of adding a near-duplicate. */
export function parseProjectAreaInput(
  text: string,
  existingAreas: readonly string[],
): ProjectAreaInput {
  const area = text.trim();
  if (area.length === 0) return { ok: false, error: "Enter an area name." };
  if (/[\r\n]/.test(area)) return { ok: false, error: "Use a single line." };
  if (area.length > PROJECT_AREA_MAX_LENGTH) {
    return { ok: false, error: `Use at most ${PROJECT_AREA_MAX_LENGTH} characters.` };
  }
  const existing = existingAreas.find(
    (candidate) => candidate.localeCompare(area, undefined, { sensitivity: "accent" }) === 0,
  );
  return { ok: true, area: existing ?? area };
}

export type ProjectAreaChoice =
  | { readonly kind: "set"; readonly area: string }
  | { readonly kind: "new" }
  | { readonly kind: "clear" };

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
