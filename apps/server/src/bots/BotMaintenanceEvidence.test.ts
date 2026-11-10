import { assert, it } from "@effect/vitest";
import type { BotLearningStatus } from "@t3tools/contracts";
import type * as BotStore from "./BotStore.ts";
import * as Evidence from "./BotMaintenanceEvidence.ts";

const home = (id: string, text: string, at = "2026-11-09T10:00:00.000Z"): Evidence.Source => ({
  kind: "home-input",
  id,
  at,
  text,
});
const taskResult = (id: string, text: string): Evidence.Source => ({
  kind: "task-result",
  id,
  at: "2026-11-09T11:00:00.000Z",
  text,
});
const learning = (
  entry: string,
  options: {
    readonly project?: string | null;
    readonly origin?: "instruction" | "correction";
    readonly status?: BotLearningStatus;
    readonly revision?: number;
    readonly kind?: string;
    readonly text?: string;
  } = {},
): BotStore.BotLearningRow => ({
  entry_id: entry,
  revision: options.revision ?? 1,
  bot_id: "bot",
  project_id: options.project === undefined ? "project" : options.project,
  kind: options.kind ?? "fact",
  text: options.text ?? `Lesson ${entry}`,
  normalized_text: (options.text ?? `Lesson ${entry}`).toLowerCase(),
  rationale: "",
  evidence: "",
  origin: options.origin ?? "correction",
  source_json: '{"kind":"user"}',
  learned_in_project_id: "project",
  status: options.status ?? "active",
  base_revision: null,
  conflicts_with_instruction: 0,
  created_at: "2026-11-01T00:00:00.000Z",
  decided_at: null,
});
const build = (
  sources: ReadonlyArray<Evidence.Source>,
  rows: ReadonlyArray<BotStore.BotLearningRow> = [],
) => Evidence.buildBatch({ projectId: "project", policy: "automatic", sources, learning: rows });
const ready = (result: Evidence.BuildResult) =>
  result._tag === "ready" ? result.batch : assert.fail(`blocked: ${result.reason}`);

it("selects whole sources oldest first and leaves the rest pending when the budget fills", () => {
  const big = "x".repeat(20_000);
  const filled = ready(build([home("m1", big), home("m2", big), home("m3", big)]));
  assert.deepEqual(
    filled.packet.sources.map((source) => source.key),
    ["i1", "i2"],
  );
  assert.isTrue(filled.more);
  assert.equal(filled.sources.get("i2")?.id, "m2");

  const capped = ready(
    build([
      ...Array.from({ length: 41 }, (_, index) => home(`m${index}`, "short")),
      taskResult("task", "done"),
    ]),
  );
  assert.equal(capped.packet.sources.length, 40);
  assert.isTrue(capped.more);

  const mixed = ready(build([home("m1", "hello"), taskResult("task", "done")]));
  assert.deepEqual(
    mixed.packet.sources.map((source) => [source.key, source.kind]),
    [
      ["i1", "home-input"],
      ["t1", "task-result"],
    ],
  );
  assert.isFalse(mixed.more);

  // A source that cannot fit an empty packet is never clipped or skipped.
  assert.deepEqual(build([home("huge", "x".repeat(48_001)), home("m2", "fits")]), {
    _tag: "blocked",
    reason: "oversized_evidence",
  });
});

it("puts every applicable standing instruction first, leaves other projects out, and blocks when instructions alone overflow", () => {
  const batch = ready(
    build(
      [home("m1", "hello")],
      [
        learning("own"),
        learning("other-project", { project: "elsewhere" }),
        learning("shared", { project: null }),
        learning("old", { status: "superseded" }),
        learning("rejected", { status: "rejected" }),
        learning("waiting", { status: "pending" }),
        learning("rule", { origin: "instruction", kind: "preference" }),
      ],
    ),
  );
  assert.deepEqual(
    batch.packet.learning.map((entry) => [entry.key, entry.scope, entry.origin, entry.status]),
    [
      ["e1", "project", "instruction", "active"],
      ["e2", "project", "correction", "active"],
      ["e3", "bot", "correction", "active"],
      ["e4", "project", "correction", "pending"],
    ],
  );
  assert.equal(batch.targets.get("e1")?.entryId, "rule");
  assert.isTrue(batch.packet.learningComplete);

  const inferred = Array.from({ length: 81 }, (_, index) => learning(`inferred-${index}`));
  const partial = ready(build([home("m1", "hello")], inferred));
  assert.equal(partial.packet.learning.length, 80);
  assert.isFalse(partial.packet.learningComplete);

  const instructions = Array.from({ length: 81 }, (_, index) =>
    learning(`rule-${index}`, { origin: "instruction" }),
  );
  assert.deepEqual(build([home("m1", "hello")], instructions), {
    _tag: "blocked",
    reason: "instructions_exceed_packet",
  });
});

it("changes the learning basis when policy or applicable learning changes, not for other projects", () => {
  const rows = [learning("own"), learning("other", { project: "elsewhere" })];
  const basis = Evidence.learningBasis("automatic", rows, "project");
  assert.equal(
    Evidence.learningBasis("automatic", [learning("own")], "project"),
    basis,
    "another project's learning is not part of this basis",
  );
  assert.notEqual(Evidence.learningBasis("after_adoption", rows, "project"), basis);
  assert.notEqual(
    Evidence.learningBasis("automatic", [...rows, learning("own", { revision: 2 })], "project"),
    basis,
  );
  assert.notEqual(
    Evidence.learningBasis(
      "automatic",
      [...rows, learning("new", { status: "pending" })],
      "project",
    ),
    basis,
  );
});

it("verifies proposals against the exact packet and rejects the whole batch on any bad reference", () => {
  const batch = ready(
    build(
      [
        home("m1", "Please always cite the rulebook page when you answer."),
        taskResult("task", "Converted the notes. The vault index lives in Index.md."),
      ],
      [learning("own", { text: "Cite sources." }), learning("waiting", { status: "pending" })],
    ),
  );
  const add = {
    op: "add",
    kind: "preference",
    text: "Cite the rulebook page in answers.",
    rationale: "The user asked for it.",
    evidence: [{ source: "i1", quote: "always cite the rulebook page" }],
  };
  const verified = Evidence.verifyProposal(batch, {
    operations: [
      add,
      {
        op: "replace",
        target: "e1",
        text: "Cite the rulebook page.",
        rationale: "Sharper.",
        evidence: [{ source: "i1", quote: "cite the rulebook page" }],
      },
      {
        op: "add",
        kind: "fact",
        text: "The vault index lives in Index.md.",
        rationale: "",
        evidence: [{ source: "t1", quote: "The vault index lives in Index.md." }],
      },
    ],
  });
  if (verified._tag !== "verified") return assert.fail(verified.reason);
  assert.deepEqual(
    verified.proposal.operations.map((operation) =>
      operation.op === "add"
        ? [operation.op, operation.kind, operation.evidence[0]?.source.id]
        : [operation.op, operation.target.entryId, operation.evidence[0]?.source.id],
    ),
    [
      ["add", "preference", "m1"],
      ["replace", "own", "m1"],
      ["add", "fact", "task"],
    ],
  );
  const empty = Evidence.verifyProposal(batch, { operations: [] });
  assert.equal(empty._tag === "verified" && empty.proposal.operations.length, 0);

  const rejected = (output: unknown) => {
    const result = Evidence.verifyProposal(batch, output);
    return result._tag === "rejected" ? result.reason : "verified";
  };
  const withOperation = (operation: object) => ({ operations: [add, operation] });
  for (const [output, reason] of [
    [{ operations: [{ ...add, evidence: [] }] }, "invalid_schema"],
    [{ operations: Array.from({ length: 9 }, () => add) }, "invalid_schema"],
    [withOperation({ ...add, evidence: [{ source: "i9", quote: "always" }] }), "unknown_evidence"],
    // Learning and assistant output are never evidence; only server-issued source keys are.
    [withOperation({ ...add, evidence: [{ source: "e1", quote: "Cite" }] }), "unknown_evidence"],
    [
      withOperation({ ...add, evidence: [{ source: "i1", quote: "never cite" }] }),
      "quote_not_in_source",
    ],
    [withOperation({ ...add, op: "replace", kind: undefined, target: "e9" }), "unknown_target"],
    [withOperation({ ...add, op: "replace", kind: undefined, target: "e2" }), "unknown_target"],
    [
      withOperation({
        op: "replace",
        target: "e1",
        text: "x",
        rationale: "",
        evidence: [{ source: "t1", quote: "Converted the notes." }],
      }),
      "task_evidence_limit",
    ],
    [
      withOperation({ ...add, evidence: [{ source: "t1", quote: "Converted the notes." }] }),
      "task_evidence_limit",
    ],
  ] as const) {
    assert.equal(rejected(output), reason, JSON.stringify(output));
  }
});
