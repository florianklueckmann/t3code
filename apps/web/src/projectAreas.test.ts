import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectAreaMenu,
  isBotInProjectScope,
  listProjectAreas,
  parseProjectAreaInput,
  resolveAreaScopedProjectKeys,
} from "./projectAreas";

const local = EnvironmentId.make("environment-local");
const remote = EnvironmentId.make("environment-remote");

function group(...members: ReadonlyArray<readonly [EnvironmentId, string, string | null]>) {
  return {
    memberProjects: members.map(([, , area]) => ({ area })),
    memberProjectRefs: members.map(([environmentId, projectId]) => ({
      environmentId,
      projectId: ProjectId.make(projectId),
    })),
  };
}

describe("resolveAreaScopedProjectKeys", () => {
  const work = group([local, "api", "Work"], [remote, "api-remote", "Work"]);
  const home = group([local, "garden", "Home"]);
  const loose = group([local, "scratch", null]);
  // A checkout changed while its machine was offline keeps the old area.
  const split = group([local, "docs", "Work"], [remote, "docs-remote", "Home"]);
  const groups = [work, home, loose, split];

  it("lists every checkout of the projects in an area", () => {
    expect(resolveAreaScopedProjectKeys(groups, "Work")).toEqual(
      new Set([`${local}:api`, `${remote}:api-remote`, `${local}:docs`, `${remote}:docs-remote`]),
    );
    expect(resolveAreaScopedProjectKeys(groups, "Home")).toEqual(
      new Set([`${local}:garden`, `${local}:docs`, `${remote}:docs-remote`]),
    );
  });

  it("lists projects without an area for No area, and nothing for an area no project carries", () => {
    expect(resolveAreaScopedProjectKeys(groups, null)).toEqual(new Set([`${local}:scratch`]));
    expect(resolveAreaScopedProjectKeys(groups, "Gone")).toBeNull();
    expect(listProjectAreas(groups)).toEqual(["Home", "Work"]);
  });
});

describe("isBotInProjectScope", () => {
  const scoped = new Set([`${local}:api`]);

  it("shows a Bot while any of its projects is in the area, and always without a project", () => {
    expect(isBotInProjectScope([`${local}:garden`, `${local}:api`], scoped)).toBe(true);
    expect(isBotInProjectScope([`${local}:garden`], scoped)).toBe(false);
    expect(isBotInProjectScope([], scoped)).toBe(true);
    expect(isBotInProjectScope([`${local}:garden`], null)).toBe(true);
  });
});

describe("parseProjectAreaInput", () => {
  it("trims, enforces one line and the length limit, and reuses an existing spelling", () => {
    expect(parseProjectAreaInput("  Side projects ", [])).toEqual({
      ok: true,
      area: "Side projects",
    });
    expect(parseProjectAreaInput("work", ["Work"])).toEqual({ ok: true, area: "Work" });
    expect(parseProjectAreaInput("   ", []).ok).toBe(false);
    expect(parseProjectAreaInput("a\nb", []).ok).toBe(false);
    expect(parseProjectAreaInput("x".repeat(40), []).ok).toBe(true);
    expect(parseProjectAreaInput("x".repeat(41), []).ok).toBe(false);
  });
});

describe("buildProjectAreaMenu", () => {
  it("checks the current area and maps each row back to its choice", () => {
    const menu = buildProjectAreaMenu({ areas: ["Home", "Work"], current: ["Work"] });
    expect(
      menu.item.children?.map((child) => [child.label, child.checked ?? false] as const),
    ).toEqual([
      ["Home", false],
      ["Work", true],
      ["New area…", false],
      ["No area", false],
    ]);
    expect(menu.choiceFor("area:0")).toEqual({ kind: "set", area: "Home" });
    expect(menu.choiceFor("area:new")).toEqual({ kind: "new" });
    expect(menu.choiceFor("area:none")).toEqual({ kind: "clear" });
    expect(menu.choiceFor("project-settings")).toBeNull();
  });
});
