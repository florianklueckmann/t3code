// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DAY_CASE_ID, type scoreDay } from "./homeDay.ts";
import type { DayUsage } from "./homeDayRun.ts";
import type { judgeDay } from "./dayJudge.ts";

type Started = { readonly phase: "started" };
type Finished =
  | { readonly pass: boolean; readonly error: string }
  | (ReturnType<typeof scoreDay> & {
      readonly usage: DayUsage;
      readonly decisions: Awaited<ReturnType<typeof judgeDay>>;
    });
type Attempt = { readonly id: string; readonly sample: number; readonly attemptId: string } & (
  | Started
  | (Finished & { readonly phase: "finished" })
);
const markdown = (value: string) => value.replace(/\s+/g, " ").replaceAll("|", "\\|");
export function dayLedger(out: string, live: boolean) {
  const journal = NodePath.join(out, "results.jsonl");
  const summary = NodePath.join(out, "summary.md");
  const attempts = new Map<string, Started | Finished>();
  const remember = (row: Attempt) => {
    if (row.id === (live ? DAY_CASE_ID + "-live-workers" : DAY_CASE_ID))
      attempts.set(row.attemptId ?? "legacy-" + row.sample, row);
  };
  if (NodeFS.existsSync(journal))
    for (const line of NodeFS.readFileSync(journal, "utf8").split("\n").filter(Boolean))
      remember(JSON.parse(line));
  const days = () => [...attempts.values()];
  return {
    days,
    write(row: Attempt) {
      NodeFS.appendFileSync(journal, JSON.stringify(row) + "\n");
      remember(row);
      const lines = [
        ...(live ? ["Live-worker integration (excluded from pass counts)."] : []),
        ...daySummary(days()),
      ];
      NodeFS.writeFileSync(summary + ".tmp", lines.join("\n"));
      NodeFS.renameSync(summary + ".tmp", summary);
    },
  };
}

export const daySummary = (days: ReadonlyArray<Started | Finished>) => {
  if (days.length === 0) return [];
  const rows = days.map((day, sample) => {
    if (!("pass" in day))
      return `| ${sample + 1} | interrupted (started without a result) | | | | |`;
    if ("error" in day) return `| ${sample + 1} | error | | | | ${day.error.slice(0, 80)} |`;
    const { usage } = day;
    const failed = day.checks.filter((check) => !check.pass).map((check) => check.check);
    return `| ${sample + 1} | ${day.invalid ? "invalid" : day.pass ? "pass" : "fail"} | ${usage.homeTurns} | ${usage.inputTokens} (${usage.cachedInputTokens} cached) | ${usage.outputTokens} | ${day.invalid?.replace(/\s+/g, " ").replaceAll("|", "\\|") ?? failed.join("; ")} |`;
  });
  const scored = days.flatMap((day) => ("briefs" in day ? [day] : []));
  const names = new Set(scored.flatMap((day) => day.checks.map((check) => check.check)));
  return [
    `${DAY_CASE_ID}: ${scored.filter((day) => day.pass).length}/${days.length} samples passed. Invalid: ${scored.filter((day) => day.invalid !== null).length}. Errors: ${days.filter((day) => "error" in day).length}. Interrupted: ${days.filter((day) => !("pass" in day)).length}.`,
    "",
    "| Sample | Result | Home turns | Home input tokens | Home output tokens | Failed checks or invalid reason |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "| Brief measure | Count |",
    "| --- | --- |",
    ...(["project", "request", "doneCondition", "baseBranch", "settled"] as const).map((key) => {
      const briefs = scored
        .flatMap((day) => day.briefs)
        .filter((brief) => key !== "settled" || brief.openChoice);
      const label = key === "settled" ? "Settled an open choice (informational)" : key;
      return `| ${label} | ${briefs.filter((brief) => brief[key]).length}/${briefs.length} |`;
    }),
    "",
    "| Sample | Open choice | Verdict (Luna judge) | Quoted requirement or default |",
    "| --- | --- | --- | --- |",
    ...days.flatMap((day, i) =>
      "briefs" in day
        ? day.briefs.flatMap((brief) =>
            brief.decision
              ? [
                  `| ${i + 1} | ${brief.task} | ${brief.settled ? "settled" : "open"} | ${markdown(brief.decision.quote) || "—"} |`,
                ]
              : [],
          )
        : [],
    ),
    "",
    "| Sample | Judge input | Cached input | Judge output |",
    "| --- | --- | --- | --- |",
    ...days.flatMap((day, i) => {
      if (!("decisions" in day)) return [];
      const usage = Object.values(day.decisions).map((d) => d.usage);
      const sum = (key: keyof (typeof usage)[number]) => usage.reduce((n, row) => n + row[key], 0);
      return [
        `| ${i + 1} | ${sum("inputTokens")} | ${sum("cachedInputTokens")} | ${sum("outputTokens")} |`,
      ];
    }),
    "",
    "| Check | " + days.map((_, i) => `Sample ${i + 1}`).join(" | ") + " | Total |",
    "| --- | " + days.map(() => "---").join(" | ") + " | --- |",
    ...Array.from(names, (name) => {
      const results = days.map((day) =>
        "checks" in day ? day.checks.find((check) => check.check === name)?.pass : undefined,
      );
      return `| ${name} | ${results.map((pass) => (pass === undefined ? "—" : pass ? "pass" : "fail")).join(" | ")} | ${results.filter(Boolean).length}/${results.filter((pass) => pass !== undefined).length} |`;
    }),
    "",
  ];
};
