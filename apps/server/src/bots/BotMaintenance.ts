import {
  BOT_TASK_TERMINAL_STATUSES,
  type BotConfigureMaintenanceInput,
  type BotConfigureMaintenanceResult,
  type BotContinuationScope,
  BotError,
  BotLearningEntryId,
  type BotMaintenanceView,
  BotTaskId,
  MessageId,
  OrchestrationV2ConversationMessageJson,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as Evidence from "./BotMaintenanceEvidence.ts";
import * as BotService from "./BotService.ts";
import * as BotStore from "./BotStore.ts";
import * as BotTaskService from "./BotTaskService.ts";

/** Turns one bounded packet into an unverified proposal. Never sees Home history or tools. */
export type Generator = (packet: Evidence.Packet) => Effect.Effect<unknown, BotError>;

/** Production stays unavailable until the sealed tool-free generator exists. */
type Generation =
  | { readonly unavailableReason: string }
  | { readonly unavailableReason: null; readonly generate: Generator };

export interface Outcome {
  readonly sources: number;
  readonly active: number;
  readonly pending: number;
  readonly stale: number;
  readonly duplicate: number;
}

export type DeferReason =
  | "oversized_evidence"
  | "instructions_exceed_packet"
  | "source_changed"
  /** Learning, policy, Bot instructions or model, or project guidance or sources changed. */
  | "basis_changed"
  | "settings_changed";

export type BotMaintenancePass =
  /** Nothing new to learn from; no model call and no run row. */
  | { readonly status: "idle" }
  | {
      readonly status: "applied" | "partial" | "noop";
      readonly runId: string;
      readonly outcome: Outcome;
    }
  | { readonly status: "deferred"; readonly runId: string; readonly reason: DeferReason }
  | {
      readonly status: "failed";
      readonly runId: string;
      readonly reason: "generation_failed" | Evidence.RejectReason;
    };

interface StateRow {
  readonly settings_revision: number;
  readonly enabled: number;
  readonly started_at: string | null;
}

interface SourceRef {
  readonly kind: Evidence.SourceKind;
  readonly source_id: string;
}

interface PendingRow extends SourceRef {
  readonly admission: number;
}

export class BotMaintenance extends Context.Service<
  BotMaintenance,
  {
    readonly get: (scope: BotContinuationScope) => Effect.Effect<BotMaintenanceView, BotError>;
    readonly configure: (
      input: BotConfigureMaintenanceInput,
    ) => Effect.Effect<BotConfigureMaintenanceResult, BotError>;
    /** One learning pass over new evidence; serialized per Home with every other pass. */
    readonly runNow: (scope: BotContinuationScope) => Effect.Effect<BotMaintenancePass, BotError>;
  }
>()("t3/bots/BotMaintenance") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const terminalTaskStatuses = encodeJson([...BOT_TASK_TERMINAL_STATUSES]);
const RETAINED_RUNS = 30;
const DISCOVERY_PAGE = 500;
const PENDING_PAGE = 50;
const invalid = (message: string) => new BotError({ message });
const isBotError = Schema.is(BotError);
const failure = (cause: unknown) =>
  isBotError(cause)
    ? cause
    : new BotError({ message: "Could not read or change Bot maintenance.", cause });
const unavailable = () =>
  invalid(
    "Bot maintenance is not available on this server yet. It needs a tool-free model profile, so it stays off.",
  );
const keyOf = (source: { readonly kind: string; readonly id: string }) =>
  `${source.kind}\u0000${source.id}`;
const turnItemOf = (messageId: string) =>
  IdAllocator.derive.userTurnItem({ messageId: MessageId.make(messageId) });

/** Provenance kept on the learning revision itself, independent of run retention. */
const provenance = (runId: string, evidence: ReadonlyArray<Evidence.VerifiedRef>) =>
  `Bot maintenance run ${runId}. ${evidence
    .map(
      (ref) =>
        `${ref.source.kind} ${ref.source.id} (sha256 ${Evidence.digest(ref.source.text).slice(0, 16)}): "${ref.quote}"`,
    )
    .join("; ")}`;

export const make = Effect.fn("BotMaintenance.make")(function* (generation: Generation) {
  const main = yield* SqlClient.SqlClient;
  const sql = yield* BotDatabase.BotDatabase;
  const store = yield* BotStore.BotStore;
  const events = yield* EventStore.EventStoreV2;
  const homeCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const bots = yield* BotService.BotService;
  const tasks = yield* BotTaskService.BotTaskService;
  const random = yield* SecureRandom.SecureRandom;
  const passLocks = yield* KeyedLock.make<ThreadId>();

  const scopeOf = Effect.fn("BotMaintenance.scope")(function* (scope: BotContinuationScope) {
    const context = yield* store.getContext(scope.botId, scope.projectId);
    const bot = yield* store.getBot(scope.botId);
    if (context === undefined || bot === undefined)
      return yield* invalid("This Bot project context does not exist.");
    return {
      home: ThreadId.make(context.home_thread_id),
      active: bot.archived_at === null && context.detached_at === null,
    };
  });
  const stateRow = (home: ThreadId) =>
    sql<StateRow>`SELECT settings_revision, enabled, started_at FROM bot_maintenance WHERE home_thread_id = ${home}`.pipe(
      Effect.map((rows) => rows[0]),
    );

  // Bot metadata only: an off or paused Bot never reads its Home transcript here.
  const get = Effect.fn("BotMaintenance.get")(function* (scope: BotContinuationScope) {
    const { home, active } = yield* scopeOf(scope);
    const row = yield* stateRow(home);
    return {
      botId: scope.botId,
      projectId: scope.projectId,
      homeThreadId: home,
      revision: row?.settings_revision ?? 0,
      enabled: row?.enabled === 1,
      startedAt: row?.started_at ?? null,
      unavailableReason: generation.unavailableReason,
      writable: active,
    } satisfies BotMaintenanceView;
  }, Effect.mapError(failure));

  const configure = Effect.fn("BotMaintenance.configure")(function* (
    input: BotConfigureMaintenanceInput,
  ) {
    const scope = { botId: input.botId, projectId: input.projectId };
    const { home, active } = yield* scopeOf(scope);
    if (input.enabled && generation.unavailableReason !== null) return yield* unavailable();
    const current = yield* stateRow(home);
    if ((current?.settings_revision ?? 0) !== input.baseRevision)
      return { _tag: "conflict", current: yield* get(scope) } as const;
    if (input.enabled === (current?.enabled === 1))
      return { _tag: "saved", view: yield* get(scope) } as const;
    if (input.enabled && !active)
      return yield* invalid("This Bot is archived or detached, so maintenance stays off.");
    const now = DateTime.formatIso(yield* DateTime.now);

    const commit = (
      baseline: { readonly sequence: number; readonly messageIds: readonly string[] } | null,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (input.enabled && !(yield* scopeOf(scope)).active)
            return yield* invalid("This Bot is archived or detached, so maintenance stays off.");
          const latest = yield* stateRow(home);
          if ((latest?.settings_revision ?? 0) !== input.baseRevision) return false;
          if (baseline === null) {
            // Pause and resume keep the floors and receipts; nothing is reset or backfilled.
            yield* sql`UPDATE bot_maintenance SET enabled = ${input.enabled ? 1 : 0}, settings_revision = settings_revision + 1, updated_at = ${now} WHERE home_thread_id = ${home}`;
            return true;
          }
          yield* sql`INSERT INTO bot_maintenance (home_thread_id, settings_revision, enabled, started_at, scan_through_sequence, processed_through_sequence, updated_at)
              VALUES (${home}, 1, 1, ${now}, ${baseline.sequence}, ${baseline.sequence}, ${now})`;
          yield* sql`INSERT INTO bot_maintenance_sources (home_thread_id, kind, source_id, state, recorded_at)
              SELECT ${home}, 'home-input', value, 'baseline', ${now} FROM json_each(${encodeJson(baseline.messageIds)})`;
          yield* sql`INSERT INTO bot_maintenance_sources (home_thread_id, kind, source_id, state, recorded_at)
              SELECT home_thread_id, 'task-result', task_id, 'baseline', ${now} FROM bot_tasks
              WHERE home_thread_id = ${home} AND status IN (SELECT value FROM json_each(${terminalTaskStatuses}))`;
          return true;
        }),
      );

    // First enable fixes the baseline: every Home input admitted so far, queued or failed
    // ones included, and every finished task. Main reads finish before the Bot transaction.
    const committed =
      current === undefined
        ? yield* homeCommands.withLock(
            home,
            Effect.gen(function* () {
              // Sequence first: an input committed after it is either in the list or above it.
              const sequence = yield* events.latestSequence({ threadId: home });
              const messages = yield* main<{
                readonly message_id: string;
              }>`SELECT message_id FROM orchestration_v2_projection_messages WHERE thread_id = ${home} AND role = 'user'`;
              return yield* commit({
                sequence,
                messageIds: messages.map((row) => row.message_id),
              });
            }),
          )
        : yield* commit(null);
    if (!committed) return { _tag: "conflict", current: yield* get(scope) } as const;
    return { _tag: "saved", view: yield* get(scope) } as const;
  }, Effect.mapError(failure));

  /**
   * Discovery records every new source identity as pending, in admission order. An edited,
   * promoted or retried source keeps its receipt and its place, so it never reads as new.
   */
  const discover = Effect.fn("BotMaintenance.discover")(function* (home: ThreadId, now: string) {
    const fresh: Array<{
      readonly kind: Evidence.SourceKind;
      readonly id: string;
      readonly at: string;
      readonly ordinal: number;
    }> = [];
    let after = { at: "", id: "" };
    while (true) {
      const page = yield* main<{
        readonly message_id: string;
        readonly created_at: string;
      }>`SELECT message_id, created_at FROM orchestration_v2_projection_messages
        WHERE thread_id = ${home} AND role = 'user' AND (created_at, message_id) > (${after.at}, ${after.id})
        ORDER BY created_at, message_id LIMIT ${DISCOVERY_PAGE}`;
      const known = new Set(
        (yield* sql<{
          readonly source_id: string;
        }>`SELECT source_id FROM bot_maintenance_sources WHERE home_thread_id = ${home} AND kind = 'home-input'
          AND source_id IN (SELECT value FROM json_each(${encodeJson(page.map((row) => row.message_id))}))`).map(
          (row) => row.source_id,
        ),
      );
      const unseen = page.filter((row) => !known.has(row.message_id));
      // Equal timestamps fall back to the Home's own turn order, which admission assigns.
      const ordinals = new Map(
        (yield* main<{
          readonly turn_item_id: string;
          readonly ordinal: number;
        }>`SELECT turn_item_id, ordinal FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id IN (SELECT value FROM json_each(${encodeJson(unseen.map((row) => turnItemOf(row.message_id)))}))`).map(
          (row) => [row.turn_item_id, row.ordinal],
        ),
      );
      for (const row of unseen)
        fresh.push({
          kind: "home-input",
          id: row.message_id,
          at: row.created_at,
          ordinal: ordinals.get(turnItemOf(row.message_id)) ?? Number.MAX_SAFE_INTEGER,
        });
      const last = page.at(-1);
      if (last === undefined || page.length < DISCOVERY_PAGE) break;
      after = { at: last.created_at, id: last.message_id };
    }
    const tasks = yield* sql<{
      readonly task_id: string;
      readonly at: string;
    }>`SELECT task_id, COALESCE(completed_at, updated_at) AS at FROM bot_tasks
      WHERE home_thread_id = ${home} AND status IN (SELECT value FROM json_each(${terminalTaskStatuses}))
        AND task_id NOT IN (SELECT source_id FROM bot_maintenance_sources WHERE home_thread_id = ${home} AND kind = 'task-result')`;
    for (const task of tasks)
      fresh.push({ kind: "task-result", id: task.task_id, at: task.at, ordinal: 0 });
    if (fresh.length === 0) return;
    const ordered = fresh
      .toSorted(
        (a, b) =>
          a.at.localeCompare(b.at) ||
          a.ordinal - b.ordinal ||
          a.kind.localeCompare(b.kind) ||
          a.id.localeCompare(b.id),
      )
      .map((source) => ({ kind: source.kind, id: source.id }));
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [top] = yield* sql<{
          readonly admission: number;
        }>`SELECT COALESCE(MAX(admission), 0) AS admission FROM bot_maintenance_sources WHERE home_thread_id = ${home}`;
        yield* sql`INSERT OR IGNORE INTO bot_maintenance_sources (home_thread_id, kind, source_id, state, recorded_at, admission)
          SELECT ${home}, json_extract(value, '$.kind'), json_extract(value, '$.id'), 'pending', ${now}, ${top?.admission ?? 0} + key + 1
          FROM json_each(${encodeJson(ordered)})`;
      }),
    );
  });

  /**
   * The outbox prunes settled steer effects after a week, cancelled ones included, so each
   * pass copies native steer acceptance onto pending receipts. Unrecorded reads as undelivered.
   */
  const recordAcceptedSteers = Effect.fn("BotMaintenance.recordAcceptedSteers")(function* (
    home: ThreadId,
  ) {
    const accepted = yield* main<{
      readonly message_id: string;
    }>`SELECT json_extract(payload_json, '$.messageId') AS message_id FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${home} AND status = 'succeeded' AND effect_type = 'provider-turn.steer'`;
    if (accepted.length === 0) return;
    yield* sql`UPDATE bot_maintenance_sources SET steer_accepted = 1
      WHERE home_thread_id = ${home} AND kind = 'home-input' AND state = 'pending' AND steer_accepted = 0
        AND source_id IN (SELECT value FROM json_each(${encodeJson(accepted.map((row) => row.message_id))}))`;
  });

  const classify = Effect.fn("BotMaintenance.classify")(function* (
    home: ThreadId,
    refs: ReadonlyArray<SourceRef>,
  ) {
    const classified = new Map<string, Evidence.Classified>();
    const messageIds = refs.filter((row) => row.kind === "home-input").map((row) => row.source_id);
    const steerAccepted = new Set(
      (yield* sql<{
        readonly source_id: string;
      }>`SELECT source_id FROM bot_maintenance_sources WHERE home_thread_id = ${home} AND kind = 'home-input'
        AND steer_accepted = 1 AND source_id IN (SELECT value FROM json_each(${encodeJson(messageIds)}))`).map(
        (row) => row.source_id,
      ),
    );
    // Delivery is native acceptance: a provider turn on the input's root node, or for input
    // steered into a running turn, the steer acceptance recorded on its receipt.
    const inputs = yield* main<{
      readonly message_id: string;
      readonly payload_json: string;
      readonly run_status: string | null;
      readonly steered: number;
      readonly turn_started: number;
    }>`SELECT m.message_id, m.payload_json, r.status AS run_status,
        i.provider_turn_id IS NOT NULL AS steered,
        EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_turns t
          WHERE t.thread_id = m.thread_id AND t.node_id = i.node_id) AS turn_started
      FROM json_each(${encodeJson(messageIds.map((id) => ({ message: id, item: turnItemOf(id) })))}) p
      JOIN orchestration_v2_projection_messages m ON m.message_id = json_extract(p.value, '$.message') AND m.thread_id = ${home}
      LEFT JOIN orchestration_v2_projection_turn_items i ON i.turn_item_id = json_extract(p.value, '$.item')
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = COALESCE(i.run_id, m.run_id)`;
    const byId = new Map(inputs.map((row) => [row.message_id, row]));
    for (const id of messageIds) {
      const row = byId.get(id);
      classified.set(
        keyOf({ kind: "home-input", id }),
        Evidence.classifyHomeInput({
          message:
            row === undefined ? undefined : Option.getOrUndefined(decodeMessage(row.payload_json)),
          delivered: row?.steered === 1 ? steerAccepted.has(id) : row?.turn_started === 1,
          runStatus: row?.run_status ?? null,
        }),
      );
    }
    for (const row of refs) {
      if (row.kind !== "task-result") continue;
      const task = (yield* sql<{
        readonly status: string;
      }>`SELECT status FROM bot_tasks WHERE home_thread_id = ${home} AND task_id = ${row.source_id}`)[0];
      const key = keyOf({ kind: "task-result", id: row.source_id });
      // Only a completed run's saved answer is evidence; any other ending proves nothing.
      if (task?.status !== "completed") {
        classified.set(key, { _tag: "excluded", reason: `task_${task?.status ?? "missing"}` });
        continue;
      }
      const { result } = yield* tasks.getResult({ taskId: BotTaskId.make(row.source_id) });
      classified.set(
        key,
        result.state === "available"
          ? {
              _tag: "eligible",
              source: { kind: "task-result", id: row.source_id, text: result.text },
            }
          : { _tag: "excluded", reason: `result_${result.state}` },
      );
    }
    return classified;
  });

  /**
   * Walks pending receipts in admission order and returns the eligible prefix: it ends at the
   * first source still settling, so a later correction is never applied before the input it
   * corrects, and once enough is read to fill a batch and know whether more waits.
   */
  const frontier = Effect.fn("BotMaintenance.frontier")(function* (home: ThreadId) {
    const eligible: Array<Evidence.Source> = [];
    const excluded: Array<SourceRef & { readonly reason: string }> = [];
    let after = 0;
    while (true) {
      const page =
        yield* sql<PendingRow>`SELECT kind, source_id, admission FROM bot_maintenance_sources
        WHERE home_thread_id = ${home} AND state = 'pending' AND admission > ${after}
        ORDER BY admission LIMIT ${PENDING_PAGE}`;
      const classified = yield* classify(home, page);
      for (const row of page) {
        const result = classified.get(keyOf({ kind: row.kind, id: row.source_id }));
        if (result === undefined || result._tag === "settling") return { eligible, excluded };
        if (result._tag === "excluded") excluded.push({ ...row, reason: result.reason });
        if (result._tag !== "eligible") continue;
        eligible.push(result.source);
        if (eligible.length > Evidence.MAX_BATCH_SOURCES) return { eligible, excluded };
      }
      const last = page.at(-1);
      if (last === undefined || page.length < PENDING_PAGE) return { eligible, excluded };
      after = last.admission;
    }
  });

  const finishRun = (runId: string, status: string, outcome: unknown, now: string) =>
    sql`UPDATE bot_maintenance_runs SET status = ${status}, outcome_json = ${encodeJson(outcome)}, finished_at = ${now} WHERE run_id = ${runId}`;

  const pass = Effect.fn("BotMaintenance.pass")(function* (
    scope: BotContinuationScope,
    home: ThreadId,
    generate: Generator,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    // This Home's pass lock is held, so a running row outlived its process. Learning and
    // receipts commit with the run's final status, so it committed nothing.
    yield* sql`UPDATE bot_maintenance_runs SET status = 'interrupted', finished_at = ${now} WHERE home_thread_id = ${home} AND status = 'running'`;
    const state = yield* stateRow(home);
    if (state?.enabled !== 1) return yield* invalid("Bot maintenance is off for this project.");
    if (!(yield* scopeOf(scope)).active)
      return yield* invalid("This Bot is archived or detached, so maintenance does not run.");

    yield* discover(home, now);
    yield* recordAcceptedSteers(home);
    const { eligible, excluded } = yield* frontier(home);
    if (excluded.length > 0)
      yield* sql`UPDATE bot_maintenance_sources SET state = 'excluded', exclusion_reason = (SELECT json_extract(value, '$.reason') FROM json_each(${encodeJson(excluded)}) WHERE json_extract(value, '$.kind') = kind AND json_extract(value, '$.source_id') = source_id)
        WHERE home_thread_id = ${home} AND state = 'pending' AND EXISTS (SELECT 1 FROM json_each(${encodeJson(excluded)}) WHERE json_extract(value, '$.kind') = kind AND json_extract(value, '$.source_id') = source_id)`;
    if (eligible.length === 0) return { status: "idle" } as const;

    const bot = yield* store.getBot(scope.botId);
    const context = yield* store.getContext(scope.botId, scope.projectId);
    if (bot?.learning_policy !== "automatic" && bot?.learning_policy !== "after_adoption")
      return yield* invalid("The Bot's learning policy is unreadable.");
    if (context === undefined) return yield* invalid("This Bot project context does not exist.");
    const built = Evidence.buildBatch({
      authority: { policy: bot.learning_policy, bot, context },
      sources: eligible,
      learning: yield* store.listLearning(scope.botId),
    });
    const runId = yield* random.uuidV4();
    const recordRun = (status: string, outcome: unknown) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO bot_maintenance_runs (run_id, home_thread_id, status, started_at, finished_at, outcome_json)
            VALUES (${runId}, ${home}, ${status}, ${now}, ${status === "running" ? null : now}, ${encodeJson(outcome)})`;
          yield* sql`DELETE FROM bot_maintenance_runs WHERE home_thread_id = ${home} AND run_id NOT IN (
            SELECT run_id FROM bot_maintenance_runs WHERE home_thread_id = ${home} ORDER BY started_at DESC, rowid DESC LIMIT ${RETAINED_RUNS})`;
        }),
      );
    if (built._tag === "blocked") {
      yield* recordRun("deferred", { reason: built.reason });
      return { status: "deferred", runId, reason: built.reason } as const;
    }
    const { batch } = built;
    yield* recordRun("running", { sources: batch.sources.size });

    // No Home, learning or SQL lock is held across the model call.
    const output = yield* Effect.result(generate(batch.packet));
    const done = DateTime.formatIso(yield* DateTime.now);
    if (output._tag === "Failure") {
      yield* finishRun(runId, "failed", { reason: "generation_failed" }, done);
      return { status: "failed", runId, reason: "generation_failed" } as const;
    }
    const verified = Evidence.verifyProposal(batch, output.success);
    if (verified._tag === "rejected") {
      yield* finishRun(runId, "failed", { reason: verified.reason }, done);
      return { status: "failed", runId, reason: verified.reason } as const;
    }

    const deferred = (reason: DeferReason) =>
      finishRun(runId, "deferred", { reason }, done).pipe(
        Effect.as({ status: "deferred", runId, reason } as const),
      );
    const selected = [...batch.sources.values()];
    // Main reads finish under the Home lock; the learning change below writes only Bot data.
    return yield* homeCommands.withLock(
      home,
      Effect.gen(function* () {
        const current = yield* classify(
          home,
          selected.map((source) => ({ kind: source.kind, source_id: source.id })),
        );
        const unchanged = selected.every((source) => {
          const latest = current.get(keyOf(source));
          return latest?._tag === "eligible" && latest.source.text === source.text;
        });
        if (!unchanged) return yield* deferred("source_changed");
        return yield* bots.maintainLearning(scope, (learning) =>
          Effect.gen(function* () {
            const latest = yield* stateRow(home);
            if (latest?.enabled !== 1 || latest.settings_revision !== state.settings_revision)
              return yield* deferred("settings_changed");
            if (Evidence.basis(learning, learning.rows) !== batch.basis)
              return yield* deferred("basis_changed");
            const outcome = {
              sources: selected.length,
              active: 0,
              pending: 0,
              stale: 0,
              duplicate: 0,
            };
            for (const operation of verified.proposal.operations) {
              const kind = operation.op === "add" ? operation.kind : operation.target.kind;
              // Stricter than ordinary learning: a standing instruction of this kind may
              // govern the lesson, so it waits for the user instead of applying itself.
              const governed = learning.rows.some(
                (row) =>
                  row.status === "active" &&
                  row.origin === "instruction" &&
                  row.kind === kind &&
                  (row.project_id === null || row.project_id === scope.projectId),
              );
              const result = yield* learning.record(governed ? "after_adoption" : learning.policy, {
                botId: scope.botId,
                projectId: scope.projectId,
                scope: "project",
                kind,
                text: operation.text,
                rationale: operation.rationale,
                evidence: provenance(runId, operation.evidence),
                origin: "correction",
                source: { kind: "agent", label: "Bot maintenance" },
                ...(operation.op === "replace"
                  ? {
                      replaces: {
                        entryId: BotLearningEntryId.make(operation.target.entryId),
                        revision: operation.target.revision,
                      },
                    }
                  : {}),
              });
              if (result.duplicate) outcome.duplicate += 1;
              else if (result.status === "active") outcome.active += 1;
              else if (result.status === "pending") outcome.pending += 1;
              else outcome.stale += 1;
            }
            const receipts = selected.map((source) => ({
              kind: source.kind,
              source_id: source.id,
              digest: Evidence.digest(source.text),
            }));
            const marked = yield* sql<{ readonly source_id: string }>`UPDATE bot_maintenance_sources
              SET state = 'applied', run_id = ${runId}, digest = (SELECT json_extract(value, '$.digest') FROM json_each(${encodeJson(receipts)}) WHERE json_extract(value, '$.kind') = kind AND json_extract(value, '$.source_id') = source_id)
              WHERE home_thread_id = ${home} AND state = 'pending' AND EXISTS (SELECT 1 FROM json_each(${encodeJson(receipts)}) WHERE json_extract(value, '$.kind') = kind AND json_extract(value, '$.source_id') = source_id)
              RETURNING source_id`;
            if (marked.length !== receipts.length)
              return yield* invalid("Maintenance sources changed during the pass.");
            const status = batch.more
              ? "partial"
              : verified.proposal.operations.length === 0
                ? "noop"
                : "applied";
            yield* finishRun(runId, status, outcome, done);
            return { status, runId, outcome } as const;
          }),
        );
      }),
    );
  });

  const runNow = Effect.fn("BotMaintenance.runNow")(function* (scope: BotContinuationScope) {
    if (generation.unavailableReason !== null) return yield* unavailable();
    const { home } = yield* scopeOf(scope);
    return yield* passLocks.withLock(home, pass(scope, home, generation.generate));
  }, Effect.mapError(failure));

  return BotMaintenance.of({ get, configure, runNow });
});

// Generation needs the sealed tool-free Codex operation, which is not wired yet, so enabling is refused.
export const layer = Layer.effect(
  BotMaintenance,
  make({ unavailableReason: "no_tool_profile_unavailable" }),
).pipe(Layer.provide(BotStore.layer));
