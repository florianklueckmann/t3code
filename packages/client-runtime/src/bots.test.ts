import {
  BotId,
  type BotSummary,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botOfHomeThread,
  botProjectContextChanges,
  botProjectContextDraft,
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
