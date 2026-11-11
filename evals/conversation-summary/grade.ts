import type { SummaryCheck } from "./cases.ts";

/** The text under a `## title` heading, up to the next heading. */
export const section = (markdown: string, title: string): string => {
  const parts = markdown.split(/^## /m);
  const match = parts.find((part) => part.split("\n", 1)[0]?.trim() === title);
  return match === undefined ? "" : match.slice(match.indexOf("\n") + 1);
};

export const grade = (
  output: { readonly summary: string; readonly handoff: string },
  checks: ReadonlyArray<SummaryCheck>,
) => {
  const failures = checks
    .filter((check) => {
      const text =
        check.where === "handoff"
          ? output.handoff
          : check.where === "summary"
            ? output.summary
            : section(output.summary, check.where);
      return check.pattern.test(text) !== check.present;
    })
    .map((check) => check.label);
  return { pass: failures.length === 0, failures };
};
