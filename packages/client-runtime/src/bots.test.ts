import {
  BotId,
  type BotSummary,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTask,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botOfHomeThread,
  botProjectContextChanges,
  botProjectContextDraft,
  botRoutineDraft,
  botRoutineUpsertInput,
  botSourceDrafts,
  emptyBotSourceDraft,
  parseBotSourceDrafts,
} from "./bots.ts";

const draft = (label: string, location: string) => ({ ...emptyBotSourceDraft(), label, location });

describe("parseBotSourceDrafts", () => {
  it("trims rows and drops blank ones", () => {
    expect(
      parseBotSourceDrafts([
        draft("  Docs ", " https://docs.example.com "),
        draft("", "  "),
        draft("Runbook", "docs/runbook.md"),
      ]),
    ).toEqual({
      sources: [
        { label: "Docs", location: "https://docs.example.com" },
        { label: "Runbook", location: "docs/runbook.md" },
      ],
    });
  });

  it.each([
    ["label only", draft("Docs", " ")],
    ["location only", draft("", "https://docs.example.com")],
  ])("rejects a row with %s", (_case, row) => {
    expect(parseBotSourceDrafts([row])).toHaveProperty("error");
  });
});

describe("botProjectContextChanges", () => {
  const saved = {
    guidance: "Answer in English.",
    sources: [{ label: "Docs", location: "https://docs.example.com" }],
  };

  it("reports nothing for an untouched or whitespace-only edit", () => {
    expect(botProjectContextChanges(botProjectContextDraft(saved), saved)).toBeNull();
    expect(
      botProjectContextChanges(
        {
          guidance: " Answer in English.\n",
          sources: [...botSourceDrafts(saved.sources), emptyBotSourceDraft()],
        },
        saved,
      ),
    ).toBeNull();
  });

  it("sends only the fields that changed", () => {
    expect(
      botProjectContextChanges({ ...botProjectContextDraft(saved), guidance: "Be brief." }, saved),
    ).toEqual({ guidance: "Be brief." });
    expect(botProjectContextChanges({ guidance: saved.guidance, sources: [] }, saved)).toEqual({
      sources: [],
    });
  });
});

describe("botOfHomeThread", () => {
  const home = { id: "bot-home:companion:campaign-a", projectId: "campaign-a" };
  const bot = (overrides: { archivedAt?: string; detachedAt?: string } = {}): BotSummary => ({
    id: BotId.make("companion"),
    name: "Companion",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    learningPolicy: "after_adoption",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: overrides.archivedAt ?? null,
    pendingLearning: 0,
    projects: [
      {
        projectId: ProjectId.make(home.projectId),
        homeThreadId: ThreadId.make(home.id),
        attachedAt: "2026-01-01T00:00:00.000Z",
        detachedAt: overrides.detachedAt ?? null,
      },
    ],
  });

  it.each([
    ["an active home conversation", [bot()], home, "Companion"],
    ["a thread in another project", [bot()], { ...home, projectId: "campaign-b" }, null],
    ["an id that only looks like a home thread", [bot()], { ...home, id: "bot-home:x:y" }, null],
    ["a detached project", [bot({ detachedAt: "2026-01-02T00:00:00.000Z" })], home, null],
    ["an archived Bot", [bot({ archivedAt: "2026-01-02T00:00:00.000Z" })], home, null],
  ])("resolves %s", (_case, bots, thread, name) => {
    expect(botOfHomeThread(bots, thread)?.name ?? null).toBe(name);
  });
});

describe("botRoutineUpsertInput", () => {
  const target = {
    botId: BotId.make("campaign-companion"),
    projectId: ProjectId.make("project-campaign"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  };
  const sessionAtMs = Date.parse("2026-11-06T19:00:00.000Z");
  const now = Date.parse("2026-11-02T12:00:00.000Z");

  it("runs a session routine once, the lead time before the session", () => {
    const result = botRoutineUpsertInput(
      {
        title: " Session 12 ",
        prompt: "Prepare session 12.",
        allowChanges: false,
        timing: "session",
        sessionAtMs,
        leadMinutes: 90,
      },
      target,
      now,
    );
    if (!("input" in result)) throw new Error(result.error);
    expect(result.input.title).toBe("Session 12");
    expect(result.input.schedule).toEqual({ type: "once", runAt: "2026-11-06T17:30:00.000Z" });
    expect(result.input.bot).toEqual({
      botId: target.botId,
      sessionAt: "2026-11-06T19:00:00.000Z",
      allowChanges: false,
    });
    expect(result.input.runtimeMode).toBe("full-access");
    // Editing the saved routine starts from the same session and lead time.
    expect(
      botRoutineDraft({ ...result.input, bot: result.input.bot } as ScheduledTask),
    ).toMatchObject({ timing: "session", sessionAtMs, leadMinutes: 90, allowChanges: false });
  });

  it("refuses a preparation time that has already passed", () => {
    const result = botRoutineUpsertInput(
      {
        title: "Prep",
        prompt: "Prepare.",
        allowChanges: true,
        timing: "session",
        sessionAtMs,
        leadMinutes: 7 * 24 * 60,
      },
      target,
      now,
    );
    expect(result).toHaveProperty("error");
  });

  it("keeps a recurring routine on its time of day and weekdays", () => {
    const result = botRoutineUpsertInput(
      {
        title: "Weekly",
        prompt: "Prepare.",
        allowChanges: true,
        timing: "recurring",
        timeOfDay: "18:00",
        weekdays: [5],
      },
      target,
      now,
    );
    expect(result).toMatchObject({
      input: {
        schedule: { type: "fixed_time", timeOfDay: "18:00", weekdays: [5] },
        bot: { botId: target.botId, sessionAt: null, allowChanges: true },
      },
    });
  });
});
