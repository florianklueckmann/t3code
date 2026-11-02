import { describe, expect, it } from "vite-plus/test";
import {
  BotId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BotDetail,
  type ModelSelection,
} from "@t3tools/contracts";

import {
  attachBotProjectDraft,
  botDraftFromDetail,
  detachBotProjectDraft,
  emptyBotSourceDraft,
  hasBotDraftChanges,
  newBotDraft,
  planBotSave,
  updateBotProjectDraft,
} from "./botDraft";

const botId = BotId.make("bot-1");
const docs = ProjectId.make("docs");
const app = ProjectId.make("app");
const model: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const at = "2026-11-01T00:00:00.000Z";

function context(projectId: ProjectId, detached = false) {
  return {
    projectId,
    homeThreadId: ThreadId.make(`bot-home:${botId}:${projectId}`),
    attachedAt: at,
    detachedAt: detached ? at : null,
    guidance: "Answer briefly.",
    sources: [{ label: "Handbook", location: "docs/handbook.md" }],
    updatedAt: at,
  };
}

const detail: BotDetail = {
  id: botId,
  name: "Docs helper",
  instructions: "Be precise.",
  modelSelection: model,
  learningPolicy: "automatic",
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  projects: [context(docs), context(app, true)],
};

describe("planBotSave", () => {
  it("creates a new Bot before attaching its projects", () => {
    const draft = attachBotProjectDraft(
      { ...newBotDraft(botId, model), name: " Helper ", learningPolicy: "after_adoption" },
      docs,
    );
    expect(planBotSave(newBotDraft(botId, model), draft)).toEqual({
      steps: [
        {
          type: "create",
          input: {
            botId,
            name: "Helper",
            instructions: "",
            modelSelection: model,
            learningPolicy: "after_adoption",
          },
        },
        { type: "attach", input: { botId, projectId: docs, guidance: "", sources: [] } },
      ],
    });
  });

  it("requires an explicit learning policy", () => {
    const draft = { ...newBotDraft(botId, model), name: "Helper" };
    expect(planBotSave(newBotDraft(botId, model), draft)).toHaveProperty("error");
  });

  it("sends only the changed fields and contexts of an existing Bot", () => {
    const baseline = botDraftFromDetail(detail);
    const draft = updateBotProjectDraft({ ...baseline, name: "Docs bot" }, docs, {
      sources: [...baseline.projects[0]!.sources, emptyBotSourceDraft()],
    });
    expect(planBotSave(baseline, draft)).toEqual({
      steps: [{ type: "update", input: { botId, name: "Docs bot" } }],
    });
  });

  it("detaches, reattaches with kept context, and updates guidance", () => {
    const baseline = botDraftFromDetail(detail);
    const draft = updateBotProjectDraft(
      attachBotProjectDraft(detachBotProjectDraft(baseline, baseline, docs), app),
      app,
      { guidance: "New guidance" },
    );
    expect(planBotSave(baseline, draft)).toEqual({
      steps: [
        { type: "detach", input: { botId, projectId: docs } },
        {
          type: "attach",
          input: {
            botId,
            projectId: app,
            guidance: "New guidance",
            sources: [{ label: "Handbook", location: "docs/handbook.md" }],
          },
        },
      ],
    });
  });

  it("rejects a preferred source missing its location", () => {
    const baseline = botDraftFromDetail(detail);
    const draft = updateBotProjectDraft(baseline, docs, {
      sources: [{ id: "x", label: "Wiki", location: " " }],
    });
    expect(planBotSave(baseline, draft)).toHaveProperty("error");
  });
});

describe("hasBotDraftChanges", () => {
  it("matches a draft read twice from the same detail", () => {
    expect(hasBotDraftChanges(botDraftFromDetail(detail), botDraftFromDetail(detail))).toBe(false);
  });

  it("drops a never-saved project instead of leaving a change behind", () => {
    const baseline = botDraftFromDetail(detail);
    const added = attachBotProjectDraft(baseline, ProjectId.make("new"));
    expect(hasBotDraftChanges(baseline, added)).toBe(true);
    expect(
      hasBotDraftChanges(baseline, detachBotProjectDraft(added, baseline, ProjectId.make("new"))),
    ).toBe(false);
  });
});
