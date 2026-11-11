import { describe, expect, it } from "vite-plus/test";

import {
  buildConversationSummaryPrompt,
  conversationSummaryChunks,
} from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("conversation summary source", () => {
  it("passes every message whole, split into calls instead of truncated", () => {
    const messages = Array.from({ length: 24 }, (_, index) => ({
      role: "assistant" as const,
      runOrdinal: index + 1,
      text: `${"x".repeat(9_000)} fact ${index + 1}`,
    }));
    const chunks = conversationSummaryChunks(messages);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(messages);
    for (const chunk of chunks) {
      const { prompt } = buildConversationSummaryPrompt({ messages: chunk });
      expect(prompt.length).toBeLessThan(170_000);
      for (const message of chunk)
        expect(prompt).toMatch(new RegExp(`fact ${message.runOrdinal}(\\n|$)`));
    }
  });

  it("continues a message longer than one call in the next, under the same label", () => {
    const text = `${"x".repeat(320_000)} decision at the end`;
    const chunks = conversationSummaryChunks([{ role: "user", runOrdinal: 7, text }]);
    expect(chunks.length).toBeGreaterThan(2);
    expect(
      chunks
        .flat()
        .map((piece) => piece.text)
        .join(""),
    ).toBe(text);
    const last = buildConversationSummaryPrompt({ messages: chunks.at(-1)! }).prompt;
    expect(last).toContain("[run 7, user]\n");
    expect(last).toMatch(/decision at the end$/);
  });
});

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});
