import { BotId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { defaultBotAppearance, resolveBotAppearance, savedBotAppearance } from "./botAppearance.ts";

describe("defaultBotAppearance", () => {
  // Every client derives an uncustomized Bot's look from its id; these must not drift.
  it.each([
    ["release-helper", { color: "sky", face: "curious", topper: "ears" }],
    ["docs-gardener", { color: "pink", face: "sleepy", topper: "ears" }],
    ["inbox-triage", { color: "violet", face: "curious", topper: "none" }],
    ["6a1f0b7e-3c2d-4e5f-8a9b-0c1d2e3f4a5b", { color: "amber", face: "curious", topper: "bow" }],
  ])("derives the same look for %s on every client", (botId, appearance) => {
    expect(defaultBotAppearance(botId)).toEqual(appearance);
  });
});

describe("savedBotAppearance", () => {
  const id = BotId.make("release-helper");

  it("keeps a Bot without a saved look on its default", () => {
    expect(savedBotAppearance({ id, appearance: null })).toBeNull();
    expect(savedBotAppearance({ id })).toBeNull();
    expect(resolveBotAppearance({ id })).toEqual(defaultBotAppearance(id));
  });

  it("replaces only the values this client does not know", () => {
    expect(
      savedBotAppearance({ id, appearance: { color: "teal", face: "grumpy", topper: "crown" } }),
    ).toEqual({ color: "teal", face: "curious", topper: "ears" });
  });
});
