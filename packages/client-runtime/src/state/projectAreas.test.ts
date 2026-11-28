import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botProjectKeys,
  botRailKeys,
  isBotInProjectScope,
  listProjectAreas,
  newProjectAreaFor,
  offersNoAreaFilter,
  parseProjectAreaInput,
  resolveAreaScopedProjectKeys,
  resolveProjectAreaScope,
  threadsHiddenByProjectScope,
} from "./projectAreas.ts";

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

describe("resolveProjectAreaScope", () => {
  const work = group([local, "api", "Work"]);
  const loose = group([local, "scratch", null]);

  it("keeps an area or No area only while it lists a project and narrows the list", () => {
    expect(resolveProjectAreaScope([work, loose], { area: "Work" })).toEqual({ area: "Work" });
    expect(resolveProjectAreaScope([work, loose], { area: null })).toEqual({ area: null });
    expect(resolveProjectAreaScope([work, loose], { area: "Gone" })).toBeNull();
    expect(resolveProjectAreaScope([loose], { area: null })).toBeNull();
    expect(resolveProjectAreaScope([work, loose], null)).toBeNull();
    expect(offersNoAreaFilter([work, loose])).toBe(true);
    expect(offersNoAreaFilter([work])).toBe(false);
    expect(offersNoAreaFilter([loose])).toBe(false);
  });

  it("gives a new project the selected area only", () => {
    expect(newProjectAreaFor({ area: "Work" })).toBe("Work");
    expect(newProjectAreaFor({ area: null })).toBeUndefined();
    expect(newProjectAreaFor(null)).toBeUndefined();
  });
});

describe("isBotInProjectScope", () => {
  const scoped = new Set([`${local}:api`]);

  it("shows a Bot while any of its projects is in the area, and always without a project", () => {
    expect(isBotInProjectScope([`${local}:garden`, `${local}:api`], scoped)).toBe(true);
    expect(isBotInProjectScope([`${local}:garden`], scoped)).toBe(false);
    expect(isBotInProjectScope([], scoped)).toBe(true);
    expect(isBotInProjectScope([`${local}:garden`], null)).toBe(true);
    // Only attached projects count; a Bot detached from the area's project is hidden.
    const bot = {
      projects: [
        { projectId: "api", detachedAt: "2026-11-01T00:00:00.000Z" },
        { projectId: "garden", detachedAt: null },
      ],
    };
    expect(botProjectKeys(bot, local)).toEqual([`${local}:garden`]);
    expect(isBotInProjectScope(botProjectKeys(bot, local), scoped)).toBe(false);
  });
});

describe("threadsHiddenByProjectScope", () => {
  const scoped = new Set([`${local}:api`]);
  const thread = (id: string, projectId: string, archivedAt: string | null = null) => ({
    environmentId: local,
    id,
    projectId,
    archivedAt,
  });
  const bot = (id: string, projectIds: readonly string[], archivedAt: string | null = null) => ({
    environmentId: local,
    bot: {
      id,
      archivedAt,
      projects: projectIds.map((projectId) => ({ projectId, detachedAt: null })),
    },
  });

  it("hides out-of-area threads, and Homes only of Bots off the rail", () => {
    const outside = thread("t-1", "garden");
    // Its Bot also works in `api`, whose Home was trimmed from the loaded threads.
    const railHome = thread("bot-home:both:garden", "garden");
    const offRailHome = thread("bot-home:elsewhere:garden", "garden");
    // A Bot's own Home sits in no area's project, so it follows its Bot.
    const railOwnHome = thread("bot-home:both:bot-home-both", "bot-home-both");
    const offRailOwnHome = thread("bot-home:elsewhere:bot-home-elsewhere", "bot-home-elsewhere");
    const threads = [
      thread("t-0", "api"),
      outside,
      thread("t-2", "garden", "2026-11-01T00:00:00.000Z"),
      railHome,
      offRailHome,
      railOwnHome,
      offRailOwnHome,
    ];
    const rail = botRailKeys(
      [bot("both", ["api", "garden"]), bot("elsewhere", ["garden"]), bot("gone", ["api"], "x")],
      scoped,
    );
    expect(rail).toEqual(new Set([`${local}:both`]));
    expect(threadsHiddenByProjectScope(threads, scoped, rail)).toEqual([
      outside,
      offRailHome,
      offRailOwnHome,
    ]);
  });

  it("keeps a Bot with a loaded Home in the area on the rail while its Bots load", () => {
    const outsideHome = thread("bot-home:both:garden", "garden");
    expect(
      threadsHiddenByProjectScope(
        [thread("bot-home:both:api", "api"), outsideHome],
        scoped,
        new Set(),
      ),
    ).toEqual([]);
    expect(threadsHiddenByProjectScope([outsideHome], scoped, new Set())).toEqual([outsideHome]);
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
    expect(parseProjectAreaInput("a\u2028b", []).ok).toBe(false);
    expect(parseProjectAreaInput("x".repeat(40), []).ok).toBe(true);
    expect(parseProjectAreaInput("x".repeat(41), []).ok).toBe(false);
  });
});
