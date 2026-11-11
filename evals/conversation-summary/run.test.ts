import { describe, expect, it } from "vite-plus/test";
import { grade, section } from "./grade.ts";

const summary = [
  "## Decisions",
  "- Use advisory locks.",
  "",
  "## Open items",
  "- Move the billing cron.",
].join("\n");

describe("grade", () => {
  it("reads only the named section", () => {
    expect(section(summary, "Open items")).toBe("- Move the billing cron.");
    expect(section(summary, "Progress")).toBe("");
  });

  it.each([
    ["present in the section", /billing cron/, "Open items", true, true],
    ["present elsewhere only", /advisory/, "Open items", true, false],
    ["absent as required", /double/, "summary", false, true],
    ["present but forbidden", /advisory/, "summary", false, false],
    ["present in the handoff", /tail message/, "handoff", true, true],
  ] as const)("%s", (_name, pattern, where, present, pass) => {
    expect(
      grade({ summary, handoff: `${summary}\n[run 9, user]\ntail message` }, [
        { label: "check", pattern, where, present },
      ]).pass,
    ).toBe(pass);
  });
});
