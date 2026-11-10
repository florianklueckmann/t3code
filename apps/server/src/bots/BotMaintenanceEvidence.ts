// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure verification needs a synchronous digest.
import * as NodeCrypto from "node:crypto";
import {
  BotLearningKind,
  type BotLearningPolicy,
  isCompactionCommandMessage,
  type OrchestrationV2ConversationMessage,
  TrimmedNonEmptyString,
  TrimmedString,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type * as BotStore from "./BotStore.ts";
import { isDirectHomeInput } from "./homeReturn.ts";

/** Proposed defaults, counted in serialized UTF-16 units; not measured token or cost bounds. */
const LIMITS = {
  homeInputs: 40,
  taskResults: 6,
  evidenceUnits: 48_000,
  learningEntries: 80,
  learningUnits: 16_000,
} as const;

/** The most sources one batch can hold. */
export const MAX_BATCH_SOURCES = LIMITS.homeInputs + LIMITS.taskResults;

export type SourceKind = "home-input" | "task-result";

/** One whole piece of evidence, keyed like its `bot_maintenance_sources` receipt. */
export interface Source {
  readonly kind: SourceKind;
  readonly id: string;
  readonly text: string;
}

/** What a proposal is generated under; a change to any of it discards the proposal. */
export interface Authority {
  readonly policy: BotLearningPolicy;
  readonly bot: BotStore.BotRow;
  readonly context: BotStore.BotContextRow;
}

interface Target {
  readonly entryId: string;
  readonly revision: number;
  readonly kind: BotLearningKind;
  readonly origin: string;
  readonly status: "active" | "pending";
  readonly shared: boolean;
  readonly text: string;
}

/** Exactly what the generator sees. Keys are server-issued so long ids cannot be garbled. */
export interface Packet {
  readonly projectId: string;
  readonly learningPolicy: BotLearningPolicy;
  /** The user's standing Bot instructions and project guidance: constraints, not evidence. */
  readonly instructions: string;
  readonly guidance: string;
  readonly sources: ReadonlyArray<{
    readonly key: string;
    readonly kind: SourceKind;
    readonly text: string;
  }>;
  readonly learning: ReadonlyArray<{
    readonly key: string;
    readonly kind: string;
    readonly scope: "project" | "bot";
    readonly origin: string;
    readonly status: "active" | "pending";
    readonly text: string;
  }>;
  /** False when inferred entries were left out, so reconciliation saw only part of them. */
  readonly learningComplete: boolean;
}

export interface Batch {
  readonly packet: Packet;
  readonly sources: ReadonlyMap<string, Source>;
  readonly targets: ReadonlyMap<string, Target>;
  readonly basis: string;
  /** More eligible sources wait beyond this batch. */
  readonly more: boolean;
}

export type BuildResult =
  | { readonly _tag: "ready"; readonly batch: Batch }
  | {
      readonly _tag: "blocked";
      readonly reason: "oversized_evidence" | "instructions_exceed_packet";
    };

export const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

export type Classified =
  | { readonly _tag: "eligible"; readonly source: Source }
  /** Not settled yet; it and everything admitted after it wait for a later pass. */
  | { readonly _tag: "settling" }
  /**
   * Its run ended before the model received it, so it is not part of what the model saw.
   * It stays pending without holding back later input, and joins once a retry delivers it.
   */
  | { readonly _tag: "undelivered" }
  | { readonly _tag: "excluded"; readonly reason: string };

const settlingRuns = new Set(["queued", "preparing", "starting", "running", "waiting"]);

/**
 * Narrower than the Home-return predicate: only a person's own web or mobile message that
 * reached the model counts. Agent, guest, task-return and compact input never do.
 */
export const classifyHomeInput = (input: {
  readonly message: OrchestrationV2ConversationMessage | undefined;
  /** The provider accepted it natively; an admission turn item alone is not delivery. */
  readonly delivered: boolean;
  readonly runStatus: string | null;
}): Classified => {
  const { message } = input;
  if (message === undefined) return { _tag: "excluded", reason: "missing" };
  if (
    !isDirectHomeInput(message) ||
    message.createdBy !== "user" ||
    message.context?.guest !== undefined ||
    isCompactionCommandMessage(message)
  )
    return { _tag: "excluded", reason: "not_user_input" };
  if (input.runStatus === "rolled_back") return { _tag: "excluded", reason: "rolled_back" };
  if (input.runStatus !== null && settlingRuns.has(input.runStatus)) return { _tag: "settling" };
  if (input.delivered)
    return { _tag: "eligible", source: { kind: "home-input", id: message.id, text: message.text } };
  // A cancelled run is never retried; a failed one can be.
  if (input.runStatus === "cancelled")
    return { _tag: "excluded", reason: "cancelled_before_delivery" };
  return { _tag: "undelivered" };
};

const units = (text: string) => JSON.stringify(text).length;

/** Current learning a project sees: each entry's active head and any pending revisions. */
const isKind = Schema.is(BotLearningKind);
const applicable = (rows: ReadonlyArray<BotStore.BotLearningRow>, projectId: string) =>
  rows.filter(
    (
      row,
    ): row is BotStore.BotLearningRow & {
      readonly status: "active" | "pending";
      readonly kind: BotLearningKind;
    } =>
      (row.project_id === null || row.project_id === projectId) &&
      (row.status === "active" || row.status === "pending") &&
      isKind(row.kind),
  );

/**
 * Changes whenever the policy, the Bot's instructions or model, the project's guidance or
 * sources, or any learning this project sees changes. Content, not revisions, so an edit
 * that skips a revision bump still counts.
 */
export const basis = (authority: Authority, rows: ReadonlyArray<BotStore.BotLearningRow>) =>
  JSON.stringify([
    authority.policy,
    authority.bot.instructions,
    authority.bot.model_selection_json,
    authority.context.revision,
    authority.context.guidance,
    authority.context.sources_json,
    applicable(rows, authority.context.project_id)
      .map((row) => `${row.entry_id}:${row.revision}:${row.status}`)
      .toSorted(),
  ]);

export const buildBatch = (input: {
  readonly authority: Authority;
  /** Eligible sources in admission order, ending before the first one still settling. */
  readonly sources: ReadonlyArray<Source>;
  readonly learning: ReadonlyArray<BotStore.BotLearningRow>;
}): BuildResult => {
  const { authority } = input;
  const projectId = authority.context.project_id;
  const selected: Array<Source> = [];
  const counts = { "home-input": 0, "task-result": 0 };
  const caps = { "home-input": LIMITS.homeInputs, "task-result": LIMITS.taskResults };
  let evidenceUnits = 0;
  for (const source of input.sources) {
    const size = units(source.text);
    if (counts[source.kind] >= caps[source.kind] || evidenceUnits + size > LIMITS.evidenceUnits)
      break;
    selected.push(source);
    counts[source.kind] += 1;
    evidenceUnits += size;
  }
  if (selected.length === 0 && input.sources.length > 0)
    return { _tag: "blocked", reason: "oversized_evidence" };

  const rows = applicable(input.learning, projectId).toSorted(
    (a, b) =>
      Number(b.origin === "instruction" && b.status === "active") -
        Number(a.origin === "instruction" && a.status === "active") ||
      b.created_at.localeCompare(a.created_at),
  );
  const included: Array<(typeof rows)[number]> = [];
  let learningUnits = 0;
  for (const row of rows) {
    const fits =
      included.length < LIMITS.learningEntries &&
      learningUnits + units(row.text) <= LIMITS.learningUnits;
    // Every standing instruction must be visible, or precedence cannot be honored.
    if (!fits && row.origin === "instruction" && row.status === "active")
      return { _tag: "blocked", reason: "instructions_exceed_packet" };
    if (!fits) break;
    included.push(row);
    learningUnits += units(row.text);
  }

  const counters = { "home-input": 0, "task-result": 0 };
  const sources = new Map(
    selected.map((source) => {
      counters[source.kind] += 1;
      return [`${source.kind === "home-input" ? "i" : "t"}${counters[source.kind]}`, source];
    }),
  );
  const targets = new Map(
    included.map((row, index) => [
      `e${index + 1}`,
      {
        entryId: row.entry_id,
        revision: row.revision,
        kind: row.kind,
        origin: row.origin,
        status: row.status,
        shared: row.project_id === null,
        text: row.text,
      } satisfies Target,
    ]),
  );
  return {
    _tag: "ready",
    batch: {
      packet: {
        projectId,
        learningPolicy: authority.policy,
        instructions: authority.bot.instructions,
        guidance: authority.context.guidance,
        sources: [...sources].map(([key, source]) => ({
          key,
          kind: source.kind,
          text: source.text,
        })),
        learning: [...targets].map(([key, target]) => ({
          key,
          kind: target.kind,
          scope: target.shared ? "bot" : "project",
          origin: target.origin,
          status: target.status,
          text: target.text,
        })),
        learningComplete: included.length === rows.length,
      },
      sources,
      targets,
      basis: basis(authority, input.learning),
      more: selected.length < input.sources.length,
    },
  };
};

const Evidence = Schema.Array(
  Schema.Struct({
    source: Schema.String,
    quote: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(3));
const LessonText = TrimmedNonEmptyString.check(Schema.isMaxLength(1_000));
const Rationale = TrimmedString.check(Schema.isMaxLength(1_000));
const Proposal = Schema.Struct({
  operations: Schema.Array(
    Schema.Union([
      Schema.Struct({
        op: Schema.Literal("add"),
        kind: BotLearningKind,
        text: LessonText,
        rationale: Rationale,
        evidence: Evidence,
      }),
      Schema.Struct({
        op: Schema.Literal("replace"),
        target: Schema.String,
        text: LessonText,
        rationale: Rationale,
        evidence: Evidence,
      }),
    ]),
  ).check(Schema.isMaxLength(8)),
});
const decodeProposal = Schema.decodeUnknownExit(Proposal);

export interface VerifiedRef {
  readonly source: Source;
  readonly quote: string;
}
export type VerifiedOperation =
  | {
      readonly op: "add";
      readonly kind: BotLearningKind;
      readonly text: string;
      readonly rationale: string;
      readonly evidence: ReadonlyArray<VerifiedRef>;
    }
  | {
      readonly op: "replace";
      readonly target: Target;
      readonly text: string;
      readonly rationale: string;
      readonly evidence: ReadonlyArray<VerifiedRef>;
    };

const verified = Symbol("VerifiedProposal");
/** Only `verifyProposal` can build one, so apply never sees an unchecked reference. */
export interface VerifiedProposal {
  readonly [verified]: true;
  readonly operations: ReadonlyArray<VerifiedOperation>;
}

export type RejectReason =
  | "invalid_schema"
  | "unknown_evidence"
  | "quote_not_in_source"
  | "unknown_target"
  | "task_evidence_limit";

export type VerifyResult =
  | { readonly _tag: "verified"; readonly proposal: VerifiedProposal }
  | { readonly _tag: "rejected"; readonly reason: RejectReason };

/** One bad operation rejects the whole proposal, so none of the batch is consumed. */
export const verifyProposal = (batch: Batch, output: unknown): VerifyResult => {
  const decoded = decodeProposal(output);
  if (Exit.isFailure(decoded)) return { _tag: "rejected", reason: "invalid_schema" };
  const operations: Array<VerifiedOperation> = [];
  for (const operation of decoded.value.operations) {
    const evidence: Array<VerifiedRef> = [];
    for (const ref of operation.evidence) {
      const source = batch.sources.get(ref.source);
      if (source === undefined) return { _tag: "rejected", reason: "unknown_evidence" };
      if (!source.text.includes(ref.quote))
        return { _tag: "rejected", reason: "quote_not_in_source" };
      evidence.push({ source, quote: ref.quote });
    }
    const taskOnly = evidence.every((ref) => ref.source.kind === "task-result");
    if (operation.op === "replace") {
      const target = batch.targets.get(operation.target);
      if (target === undefined || target.status !== "active")
        return { _tag: "rejected", reason: "unknown_target" };
      // A work report is untrusted agent output: it may add a project lesson, never rewrite one.
      if (taskOnly) return { _tag: "rejected", reason: "task_evidence_limit" };
      operations.push({ ...operation, target, evidence });
      continue;
    }
    if (taskOnly && operation.kind === "preference")
      return { _tag: "rejected", reason: "task_evidence_limit" };
    operations.push({ ...operation, evidence });
  }
  return { _tag: "verified", proposal: { [verified]: true, operations } };
};
