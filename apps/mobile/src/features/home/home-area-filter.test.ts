import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { opensOutsideHomeArea, resolveHomeAreaDot } from "./home-area-filter";
import { homeProjectFilterRows } from "./home-list-filter-menu";
import {
  buildHomeProjectScopes,
  homeAreaFilterOptions,
  resolveHomeAreaFilter,
} from "./homeThreadList";

const env = EnvironmentId.make("local");
const now = "2026-06-02T00:00:00.000Z";

function project(id: string, area: string | null): EnvironmentProject {
  return {
    environmentId: env,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/workspaces/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    area,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function thread(
  id: string,
  projectId: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId: env,
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    latestUserMessageAt: null,
    hasPendingApprovals: true,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  });
}

function bot(id: string, projectIds: readonly string[]) {
  return {
    environmentId: env,
    bot: {
      id,
      archivedAt: null,
      projects: projectIds.map((projectId) => ({
        projectId,
        homeThreadId: `bot-home:${id}:${projectId}`,
        detachedAt: null,
      })),
      home: { homeThreadId: `bot-home:${id}:bot-home-${id}` },
    },
  };
}

const projects = [project("api", "Work"), project("web", "Work"), project("garden", null)];
const scopes = buildHomeProjectScopes({
  projects,
  environmentId: null,
  projectGroupingMode: "separate",
});
const work = resolveHomeAreaFilter(scopes, { area: "Work" })!;

describe("home area filter", () => {
  it("offers each area and No area, and lists the area's projects", () => {
    const options = homeAreaFilterOptions(scopes);
    expect(options).toEqual({ areas: ["Work"], noArea: true });
    expect(work.projectRefs.map((ref) => ref.projectId)).toEqual(["api", "web"]);
    expect(
      resolveHomeAreaFilter(scopes, { area: null })?.projectRefs.map((ref) => ref.projectId),
    ).toEqual(["garden"]);
    // An area no project carries reads as all projects.
    expect(resolveHomeAreaFilter(scopes, { area: "Gone" })).toBeNull();
    const rows = homeProjectFilterRows({
      ...options,
      projects: [{ key: "api", label: "api" }],
      selected: { kind: "area", area: "Work" },
    });
    expect(rows.map((row) => [row.title, row.selected])).toEqual([
      ["All projects", false],
      ["Work", true],
      ["No area", false],
      ["api", false],
    ]);
  });

  it("dots the filter for hidden work, but not settled threads or Homes on the row", () => {
    const resolve = (threads: EnvironmentThreadShell[]) =>
      resolveHomeAreaDot({
        threads,
        scopedProjectKeys: work.scopedProjectKeys,
        bots: [bot("both", ["api", "garden"]), bot("gardener", ["garden"])],
        environmentId: null,
        now,
      });
    expect(resolve([thread("in", "api")])).toBeNull();
    expect(resolve([thread("out", "garden")])).toBe("approval");
    expect(resolve([thread("out", "garden", { settledOverride: "settled" })])).toBeNull();
    // The rail shows this Bot for `api`, though its `api` Home is not loaded.
    expect(resolve([thread("bot-home:both:garden", "garden")])).toBeNull();
    expect(resolve([thread("bot-home:gardener:garden", "garden")])).toBe("approval");
    // A Bot's own Home follows its Bot, whatever area it is in.
    expect(resolve([thread("bot-home:both:bot-home-both", "bot-home-both")])).toBeNull();
    expect(resolve([thread("bot-home:gardener:bot-home-gardener", "bot-home-gardener")])).toBe(
      "approval",
    );
    // Another environment's list threads follow the environment filter; the Bot row does not.
    const onlyOther = (threads: EnvironmentThreadShell[]) =>
      resolveHomeAreaDot({
        threads,
        scopedProjectKeys: work.scopedProjectKeys,
        bots: [bot("gardener", ["garden"])],
        environmentId: EnvironmentId.make("other"),
        now,
      });
    expect(onlyOther([thread("out", "garden")])).toBeNull();
    expect(onlyOther([thread("bot-home:gardener:garden", "garden")])).toBe("approval");
    // A cached Home whose Bot is not on any connected row stays quiet.
    expect(resolve([thread("bot-home:offline:garden", "garden")])).toBeNull();
  });

  it("leaves the area for an outside thread or a hidden Bot's Home, and waits for unknown Homes", () => {
    const opens = (id: string, projectId: string) =>
      opensOutsideHomeArea({
        thread: thread(id, projectId),
        scopedProjectKeys: work.scopedProjectKeys,
        bots: [bot("both", ["api", "garden"]), bot("gardener", ["garden"])],
      });
    expect(opens("in", "api")).toBe(false);
    expect(opens("out", "garden")).toBe(true);
    expect(opens("bot-home:both:garden", "garden")).toBe(false);
    expect(opens("bot-home:gardener:garden", "garden")).toBe(true);
    expect(opens("bot-home:unknown:garden", "garden")).toBeNull();
    expect(opens("bot-home:both:bot-home-both", "bot-home-both")).toBe(false);
    expect(opens("bot-home:gardener:bot-home-gardener", "bot-home-gardener")).toBe(true);
  });
});
