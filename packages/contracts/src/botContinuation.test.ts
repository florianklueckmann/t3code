import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { BotContinuationNoteInput } from "./botContinuation.ts";

const note = (requests: readonly { readonly text: string; readonly quote?: string }[]) => ({
  requests,
  waiting: [],
  decided: [],
  context: [],
});
const decode = Schema.decodeUnknownSync(BotContinuationNoteInput);

describe("working-note budgets", () => {
  it.each([
    { name: "item count", items: Array.from({ length: 20 }, () => ({ text: "x" })) },
    { name: "text length", items: [{ text: "x".repeat(400) }] },
    { name: "total text", items: Array.from({ length: 10 }, () => ({ text: "x".repeat(400) })) },
    { name: "UTF-16 text length", items: [{ text: "😀".repeat(200) }] },
    { name: "quote length", items: [{ text: "Request", quote: "😀".repeat(200) }] },
  ])("accepts the exact $name limit", ({ items }) => {
    expect(decode(note(items))).toEqual(note(items));
  });

  it.each([
    {
      name: "item count",
      items: Array.from({ length: 21 }, () => ({ text: "x" })),
      message: /21 items \(limit 20\)/,
    },
    {
      name: "text length",
      items: [{ text: "x".repeat(401) }],
      message: /longest text 401 units \(limit 400\)/,
    },
    {
      name: "total text",
      items: [...Array.from({ length: 10 }, () => ({ text: "x".repeat(400) })), { text: "x" }],
      message: /4001 total text units \(limit 4000\)/,
    },
    {
      name: "UTF-16 text length",
      items: [{ text: `${"😀".repeat(200)}x` }],
      message: /longest text 401 units \(limit 400\)/,
    },
    {
      name: "quote length",
      items: [{ text: "Request", quote: `${"😀".repeat(200)}x` }],
      message: /longest quote 401 units \(limit 400\)/,
    },
  ])("reports counts above the $name limit", ({ items, message }) => {
    expect(() => decode(note(items))).toThrow(message);
  });

  it("reports every exceeded dimension in one rejection without disclosing note text", () => {
    const input = note([
      { text: "p".repeat(401), quote: "q".repeat(402) },
      ...Array.from({ length: 20 }, () => ({ text: "r".repeat(200) })),
    ]);
    expect(() => decode(input)).toThrow(
      "Working notes exceed budget (UTF-16 code units): 21 items (limit 20); 4401 total text units (limit 4000); longest text 401 units (limit 400); longest quote 402 units (limit 400).",
    );
  });
});
