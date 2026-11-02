import {
  BotError,
  type BotDecideLearningInput,
  BotLearningEntryId,
  type BotLearningKind,
  type BotLearningOrigin,
  type BotLearningPolicy,
  type BotLearningSource,
  type BotLearningStatus,
  type BotRecordLearningInput,
  type BotRestoreLearningInput,
  type BotRetireLearningInput,
  type BotTaskId,
  type BotTaskStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BotStore from "./BotStore.ts";

export interface RecordLearningInput extends BotRecordLearningInput {
  readonly origin: BotLearningOrigin;
  readonly source: BotLearningSource;
}

export interface RecordLearningResult {
  readonly entryId: BotLearningEntryId;
  readonly revision: number;
  readonly status: BotLearningStatus;
  /** The same lesson was already active, pending or rejected, so nothing was recorded. */
  readonly duplicate: boolean;
}

/** Active entries supplied to one turn; the rest stay reviewable in settings and `t3_bot read`. */
const ACTIVE_LEARNING_MAX_ENTRIES = 40;
const ACTIVE_LEARNING_MAX_CHARS = 8_000;

const normalizeLearningText = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

const fail = (message: string) => new BotError({ message });

const revisionsOf = (rows: ReadonlyArray<BotStore.BotLearningRow>, entryId: string) =>
  rows.filter((row) => row.entry_id === entryId).toSorted((a, b) => a.revision - b.revision);

const activeOf = (revisions: ReadonlyArray<BotStore.BotLearningRow>) =>
  revisions.find((row) => row.status === "active");

/**
 * The status a new, non-stale revision starts in. A user's standing instruction applies at once.
 * Inferred lessons wait for the user when they would override a standing instruction or reach
 * every project; otherwise the Bot's policy decides.
 */
const initialStatus = (input: {
  readonly origin: BotLearningOrigin;
  readonly shared: boolean;
  readonly conflictsWithInstruction: boolean;
  readonly policy: BotLearningPolicy;
  /** A task's lesson waits until the server sees that task completed. */
  readonly fromTask: boolean;
}): BotLearningStatus => {
  if (input.origin === "instruction") return "active";
  if (input.fromTask || input.shared || input.conflictsWithInstruction) return "pending";
  return input.policy === "automatic" ? "active" : "pending";
};

const confirmsInference = (input: RecordLearningInput, row: BotStore.BotLearningRow) =>
  input.origin === "instruction" && row.origin === "correction" && row.status === "active";

/**
 * An inferred lesson already waiting for the user, or one the user rejected. A user's own
 * instruction is never a repeat: it applies even after an identical lesson was rejected.
 */
const repeats = (input: RecordLearningInput, normalized: string, row: BotStore.BotLearningRow) =>
  input.origin === "correction" &&
  row.normalized_text === normalized &&
  (row.status === "pending" || row.status === "rejected");

export const make = (deps: {
  readonly store: BotStore.BotStore["Service"];
  readonly now: Effect.Effect<string>;
  readonly newEntryId: Effect.Effect<string, BotError>;
  readonly taskStatus: (taskId: BotTaskId) => Effect.Effect<BotTaskStatus, BotError>;
}) => {
  const { store } = deps;

  /**
   * Makes a stored revision current: the entry's previous revision is superseded, proposals
   * against it go stale, and identical proposals elsewhere in the same scope are settled.
   */
  const activate = Effect.fn("BotLearning.activate")(function* (
    rows: ReadonlyArray<BotStore.BotLearningRow>,
    activated: BotStore.BotLearningRow,
    now: string,
  ) {
    for (const row of rows) {
      if (row.entry_id === activated.entry_id && row.revision === activated.revision) continue;
      const sameEntry = row.entry_id === activated.entry_id;
      const next: BotLearningStatus | undefined =
        sameEntry && row.status === "active"
          ? "superseded"
          : row.status === "pending" &&
              (sameEntry ||
                (row.project_id === activated.project_id &&
                  row.kind === activated.kind &&
                  row.normalized_text === activated.normalized_text))
            ? "stale"
            : undefined;
      if (next !== undefined) {
        yield* store.setLearningStatus({
          entryId: row.entry_id,
          revision: row.revision,
          status: next,
          decidedAt: now,
        });
      }
    }
    if (activated.status !== "active") {
      yield* store.setLearningStatus({
        entryId: activated.entry_id,
        revision: activated.revision,
        status: "active",
        decidedAt: now,
      });
    }
  });

  const insertRevision = Effect.fn("BotLearning.insertRevision")(function* (
    rows: ReadonlyArray<BotStore.BotLearningRow>,
    row: BotStore.BotLearningRow,
  ) {
    yield* store.insertLearning(row);
    if (row.status === "active") yield* activate(rows, row, row.created_at);
  });

  const record = Effect.fn("BotLearning.record")(function* (
    policy: BotLearningPolicy,
    input: RecordLearningInput,
  ): Effect.fn.Return<RecordLearningResult, BotError | BotStore.BotStoreError> {
    const rows = yield* store.listLearning(input.botId);
    const normalized = normalizeLearningText(input.text);
    const now = yield* deps.now;
    const base = {
      bot_id: input.botId,
      text: input.text,
      normalized_text: normalized,
      rationale: input.rationale ?? "",
      evidence: input.evidence ?? "",
      origin: input.origin,
      source_json: BotStore.encodeLearningSource(input.source),
      learned_in_project_id: input.projectId,
      created_at: now,
    };
    const fromTask = input.source.kind === "task";
    if (fromTask) {
      if (input.origin !== "correction") {
        return yield* fail(
          'A task proposes lessons; standing instructions come from the user. Record it with origin "correction"; it counts once this task completes.',
        );
      }
      // A task proposes at most one lesson.
      const earlier = rows.find((row) => row.source_json === base.source_json);
      if (earlier !== undefined) return duplicateOf(earlier);
    }

    if (input.replaces !== undefined) {
      const revisions = revisionsOf(rows, input.replaces.entryId);
      const first = revisions[0];
      if (first === undefined) return yield* fail("Learning entry not found.");
      if (first.project_id !== null && first.project_id !== input.projectId) {
        return yield* fail("That learning entry belongs to another project.");
      }
      const head = activeOf(revisions);
      const stale = head === undefined || head.revision !== input.replaces.revision;
      // The user restating an inferred lesson makes it their instruction, which later
      // inferred lessons cannot override, so it gets its own revision.
      if (!stale && head.normalized_text === normalized && !confirmsInference(input, head)) {
        return duplicateOf(head);
      }
      const repeated = revisions.find((revision) => repeats(input, normalized, revision));
      if (repeated !== undefined) return duplicateOf(repeated);
      const conflictsWithInstruction =
        !stale && input.origin === "correction" && head.origin === "instruction";
      const status = stale
        ? "stale"
        : initialStatus({
            origin: input.origin,
            shared: first.project_id === null,
            conflictsWithInstruction,
            policy,
            fromTask,
          });
      const row: BotStore.BotLearningRow = {
        ...base,
        entry_id: first.entry_id,
        revision: Math.max(...revisions.map((revision) => revision.revision)) + 1,
        project_id: first.project_id,
        kind: first.kind,
        status,
        base_revision: input.replaces.revision,
        conflicts_with_instruction: conflictsWithInstruction ? 1 : 0,
        decided_at: status === "pending" ? null : now,
      };
      yield* insertRevision(rows, row);
      return resultOf(row);
    }

    const shared = input.scope === "bot";
    if (shared && input.kind === "fact") {
      return yield* fail("Facts stay with the project they were learned in; use scope project.");
    }
    const projectId = shared ? null : input.projectId;
    const duplicate = rows.find(
      (row) =>
        row.project_id === projectId &&
        row.kind === input.kind &&
        ((row.status === "active" && row.normalized_text === normalized) ||
          repeats(input, normalized, row)),
    );
    if (duplicate !== undefined) {
      return confirmsInference(input, duplicate)
        ? yield* record(policy, {
            ...input,
            replaces: {
              entryId: BotLearningEntryId.make(duplicate.entry_id),
              revision: duplicate.revision,
            },
          })
        : duplicateOf(duplicate);
    }
    const status = initialStatus({
      origin: input.origin,
      shared,
      conflictsWithInstruction: false,
      policy,
      fromTask,
    });
    const row: BotStore.BotLearningRow = {
      ...base,
      entry_id: yield* deps.newEntryId,
      revision: 1,
      project_id: projectId,
      kind: input.kind satisfies BotLearningKind,
      status,
      base_revision: null,
      conflicts_with_instruction: 0,
      decided_at: status === "pending" ? null : now,
    };
    yield* insertRevision(rows, row);
    return resultOf(row);
  });

  const requireRevision = (
    rows: ReadonlyArray<BotStore.BotLearningRow>,
    entryId: BotLearningEntryId,
    revision: number,
  ) => {
    const match = rows.find((row) => row.entry_id === entryId && row.revision === revision);
    return match === undefined
      ? Effect.fail(fail(`Learning entry ${entryId} has no revision ${revision}.`))
      : Effect.succeed(match);
  };

  /** Adopting a proposal whose entry changed since it was made marks it stale instead. */
  const decide = Effect.fn("BotLearning.decide")(function* (input: BotDecideLearningInput) {
    const rows = yield* store.listLearning(input.botId);
    const row = yield* requireRevision(rows, input.entryId, input.revision);
    if (row.status !== "pending") {
      return yield* fail(`Revision ${row.revision} is ${row.status}, not pending.`);
    }
    const source = yield* BotStore.learningSourceOf(row);
    if (input.decision === "adopt" && source.kind === "task") {
      if ((yield* deps.taskStatus(source.taskId)) !== "completed") {
        return yield* fail(
          "The task that proposed this has not completed, so it cannot be adopted.",
        );
      }
    }
    const now = yield* deps.now;
    const head = activeOf(revisionsOf(rows, row.entry_id));
    const status: BotLearningStatus =
      input.decision === "reject"
        ? "rejected"
        : row.base_revision !== null && head?.revision !== row.base_revision
          ? "stale"
          : "active";
    if (status === "active") yield* activate(rows, row, now);
    else {
      yield* store.setLearningStatus({
        entryId: row.entry_id,
        revision: row.revision,
        status,
        decidedAt: now,
      });
    }
  });

  /**
   * Settles a finished task's waiting lesson: a completed task makes it eligible under the
   * policy, and any other ending leaves it as diagnostic evidence. True when something changed.
   */
  const settleTask = Effect.fn("BotLearning.settleTask")(function* (input: {
    readonly botId: string;
    readonly policy: BotLearningPolicy;
    readonly taskId: BotTaskId;
    readonly status: BotTaskStatus;
  }) {
    const rows = yield* store.listLearning(input.botId);
    const sourceJson = BotStore.encodeLearningSource({ kind: "task", taskId: input.taskId });
    const waiting = rows.filter(
      (row) => row.source_json === sourceJson && row.status === "pending",
    );
    const now = yield* deps.now;
    let changed = false;
    for (const row of waiting) {
      const head = activeOf(revisionsOf(rows, row.entry_id));
      const status: BotLearningStatus | undefined =
        input.status !== "completed"
          ? "diagnostic"
          : row.base_revision !== null && head?.revision !== row.base_revision
            ? "stale"
            : initialStatus({
                  origin: "correction",
                  shared: row.project_id === null,
                  conflictsWithInstruction: row.conflicts_with_instruction !== 0,
                  policy: input.policy,
                  fromTask: false,
                }) === "active"
              ? "active"
              : undefined;
      if (status === undefined) continue;
      changed = true;
      if (status === "active") yield* activate(rows, row, now);
      else {
        yield* store.setLearningStatus({
          entryId: row.entry_id,
          revision: row.revision,
          status,
          decidedAt: now,
        });
      }
    }
    return changed;
  });

  const retire = Effect.fn("BotLearning.retire")(function* (input: BotRetireLearningInput) {
    const rows = yield* store.listLearning(input.botId);
    const revisions = revisionsOf(rows, input.entryId);
    if (revisions.length === 0) return yield* fail("Learning entry not found.");
    const head = activeOf(revisions);
    if (head === undefined) return yield* fail("This learning entry has nothing active to retire.");
    const now = yield* deps.now;
    for (const row of revisions) {
      const status = row === head ? "retired" : row.status === "pending" ? "stale" : undefined;
      if (status === undefined) continue;
      yield* store.setLearningStatus({
        entryId: row.entry_id,
        revision: row.revision,
        status,
        decidedAt: now,
      });
    }
  });

  const restore = Effect.fn("BotLearning.restore")(function* (
    input: BotRestoreLearningInput & { readonly source: BotLearningSource },
  ) {
    const rows = yield* store.listLearning(input.botId);
    const target = yield* requireRevision(rows, input.entryId, input.revision);
    if (target.status === "active" || target.status === "pending") {
      return yield* fail(
        `Revision ${target.revision} is ${target.status}; restore an earlier revision instead.`,
      );
    }
    const revisions = revisionsOf(rows, input.entryId);
    const now = yield* deps.now;
    const row: BotStore.BotLearningRow = {
      ...target,
      revision: Math.max(...revisions.map((revision) => revision.revision)) + 1,
      rationale: `Restored revision ${target.revision}.`,
      // Restoring is the user's own decision, so it counts as a standing instruction.
      origin: "instruction",
      source_json: BotStore.encodeLearningSource(input.source),
      status: "active",
      base_revision: activeOf(revisions)?.revision ?? null,
      conflicts_with_instruction: 0,
      created_at: now,
      decided_at: now,
    };
    yield* insertRevision(rows, row);
  });

  return { record, decide, retire, restore, settleTask };
};

const resultOf = (row: BotStore.BotLearningRow): RecordLearningResult => ({
  entryId: BotLearningEntryId.make(row.entry_id),
  revision: row.revision,
  status: row.status,
  duplicate: false,
});

const duplicateOf = (row: BotStore.BotLearningRow): RecordLearningResult => ({
  ...resultOf(row),
  duplicate: true,
});

/**
 * The active learning one turn in a project sees: its own entries and the Bot's shared ones,
 * standing instructions first, bounded so history never floods the context.
 */
export function activeLearningLines(
  rows: ReadonlyArray<BotStore.BotLearningRow>,
  projectId: string,
): { readonly lines: ReadonlyArray<string>; readonly omitted: number } {
  const active = rows
    .filter(
      (row) => row.status === "active" && (row.project_id === null || row.project_id === projectId),
    )
    .toSorted(
      (a, b) =>
        Number(b.origin === "instruction") - Number(a.origin === "instruction") ||
        b.created_at.localeCompare(a.created_at),
    );
  const lines: Array<string> = [];
  let chars = 0;
  for (const row of active) {
    const line = `- [${row.entry_id} r${row.revision}; ${row.kind}${
      row.project_id === null ? ", all projects" : ""
    }${row.origin === "instruction" ? ", standing instruction" : ""}] ${row.text}`;
    if (
      lines.length >= ACTIVE_LEARNING_MAX_ENTRIES ||
      chars + line.length > ACTIVE_LEARNING_MAX_CHARS
    ) {
      break;
    }
    lines.push(line);
    chars += line.length;
  }
  return { lines, omitted: active.length - lines.length };
}
