import { expect, it } from "@effect/vitest";

import { CASES } from "./cases.ts";
import { batchFor, casePasses, gradeSample } from "./grade.ts";

const caseOf = (id: string) => CASES.find((testCase) => testCase.id === id)!;
const conflict = caseOf("conflict-replaces-not-adds");
const grade = (id: string, operations: ReadonlyArray<unknown>) =>
  gradeSample(caseOf(id), batchFor(caseOf(id)), { operations });
const quote = "They run on Cloudflare Pages now";
const replaceKey = () =>
  [...batchFor(conflict).targets].find(([, target]) => target.entryId === "entry-previews")![0];

it("fails a sample the engine's verifier rejects, whatever its checks say", () => {
  const result = grade("conflict-replaces-not-adds", [
    {
      op: "replace",
      target: replaceKey(),
      text: "Deploy previews run on Cloudflare Pages.",
      rationale: "",
      evidence: [{ source: "i1", quote: "They moved to Netlify" }],
    },
  ]);
  expect(result.verifier).toBe("quote_not_in_source");
  expect(result.pass).toBe(false);
});

it("credits a replace of the outdated entry and fails an add beside it", () => {
  const lesson = {
    text: "Deploy previews run on Cloudflare Pages.",
    rationale: "",
    evidence: [{ source: "i1", quote }],
  };
  expect(
    grade("conflict-replaces-not-adds", [{ op: "replace", target: replaceKey(), ...lesson }]).pass,
  ).toBe(true);
  const added = grade("conflict-replaces-not-adds", [{ op: "add", kind: "fact", ...lesson }]);
  expect(added.checks.map((check) => check.pass)).toEqual([false, false]);
});

it("matches cited sources by id and kinds by the operation", () => {
  const procedure = (key: string, quoteText: string) =>
    grade("failed-task-not-procedure", [
      {
        op: "add",
        kind: "procedure",
        text: "Shard tests four ways in CI.",
        rationale: "",
        evidence: [{ source: key, quote: quoteText }],
      },
    ]).checks[0]!.pass;
  expect(procedure("t1", "pnpm test --shard=4")).toBe(false);
  expect(
    grade("ordinary-conversation-empty", [
      {
        op: "add",
        kind: "preference",
        text: "Summaries of yesterday's PRs each morning.",
        rationale: "",
        evidence: [{ source: "i1", quote: "summarize what changed" }],
      },
    ]).pass,
  ).toBe(false);
  expect(grade("ordinary-conversation-empty", []).pass).toBe(true);
});

it("fails a case when half or more of its samples fail", () => {
  const samples = (...passes: ReadonlyArray<boolean>) => passes.map((pass) => ({ pass }));
  expect(casePasses(samples(true, true, false))).toBe(true);
  expect(casePasses(samples(true, false, false))).toBe(false);
  expect(casePasses(samples(true, false))).toBe(false);
  expect(casePasses([])).toBe(false);
});
