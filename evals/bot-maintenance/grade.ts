import * as Evidence from "../../apps/server/src/bots/BotMaintenanceEvidence.ts";
import type * as BotStore from "../../apps/server/src/bots/BotStore.ts";
import { type Check, type MaintenanceCase, WORLD, type Where } from "./cases.ts";

const AT = "2026-11-01T00:00:00.000Z";

export const batchFor = (testCase: MaintenanceCase): Evidence.Batch => {
  const learning = (testCase.learning ?? []).map((entry): BotStore.BotLearningRow => ({
    entry_id: entry.id,
    revision: 1,
    bot_id: WORLD.botId,
    project_id: WORLD.projectId,
    kind: entry.kind,
    text: entry.text,
    normalized_text: entry.text.toLowerCase(),
    rationale: "",
    evidence: "",
    origin: entry.origin,
    source_json: '{"kind":"user"}',
    learned_in_project_id: WORLD.projectId,
    status: "active",
    base_revision: null,
    conflicts_with_instruction: 0,
    created_at: AT,
    decided_at: null,
  }));
  const built = Evidence.buildBatch({
    authority: {
      policy: WORLD.policy,
      bot: {
        bot_id: WORLD.botId,
        name: "Acme helper",
        instructions: WORLD.instructions,
        model_selection_json: "{}",
        learning_policy: WORLD.policy,
        appearance_json: null,
        created_at: AT,
        updated_at: AT,
        archived_at: null,
      },
      context: {
        home_thread_id: `bot-home:${WORLD.botId}:${WORLD.projectId}`,
        bot_id: WORLD.botId,
        project_id: WORLD.projectId,
        guidance: WORLD.guidance,
        sources_json: "[]",
        revision: 1,
        thread_sync: null,
        attached_at: AT,
        detached_at: null,
        updated_at: AT,
      },
    },
    sources: testCase.sources,
    learning,
  });
  if (built._tag === "blocked")
    throw new Error(`Case ${testCase.id} does not fit one packet: ${built.reason}.`);
  return built.batch;
};

export interface GradedOperation {
  readonly op: "add" | "replace";
  readonly kind: string;
  readonly text: string;
  readonly target: string | null;
  readonly cites: ReadonlyArray<string>;
}

export interface SampleGrade {
  /** The engine's own verdict; a rejected proposal would consume nothing in a real pass. */
  readonly verifier: "verified" | Evidence.RejectReason;
  readonly operations: ReadonlyArray<GradedOperation>;
  readonly checks: ReadonlyArray<{ readonly check: string; readonly pass: boolean }>;
  readonly pass: boolean;
}

const matches = (where: Where, operation: GradedOperation) =>
  (where.op === undefined || where.op === operation.op) &&
  (where.target === undefined || where.target === operation.target) &&
  (where.kinds === undefined || where.kinds.some((kind) => kind === operation.kind)) &&
  (where.text === undefined || where.text.every((pattern) => pattern.test(operation.text))) &&
  (where.cites === undefined || operation.cites.some((id) => where.cites!.includes(id)));

const holds = (check: Check, operations: ReadonlyArray<GradedOperation>) => {
  if (check.expect === "empty") return operations.length === 0;
  const found = operations.some((operation) => matches(check.where, operation));
  return check.expect === "some" ? found : !found;
};

export const gradeSample = (
  testCase: MaintenanceCase,
  batch: Evidence.Batch,
  output: unknown,
): SampleGrade => {
  const verified = Evidence.verifyProposal(batch, output);
  if (verified._tag === "rejected")
    return { verifier: verified.reason, operations: [], checks: [], pass: false };
  const operations = verified.proposal.operations.map((operation): GradedOperation => ({
    op: operation.op,
    kind: operation.op === "add" ? operation.kind : operation.target.kind,
    text: operation.text,
    target: operation.op === "replace" ? operation.target.entryId : null,
    cites: operation.evidence.map((ref) => ref.source.id),
  }));
  const checks = testCase.checks.map((check) => ({
    check: check.name,
    pass: holds(check, operations),
  }));
  return {
    verifier: "verified",
    operations,
    checks,
    pass: checks.every((check) => check.pass),
  };
};

/** A case fails when half or more of its samples fail. */
export const casePasses = (samples: ReadonlyArray<{ readonly pass: boolean }>) =>
  samples.length > 0 && samples.filter((sample) => !sample.pass).length * 2 < samples.length;
