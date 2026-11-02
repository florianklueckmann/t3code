import { describe, expect, it } from "vite-plus/test";

import {
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
