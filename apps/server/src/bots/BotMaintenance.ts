import {
  BOT_TASK_TERMINAL_STATUSES,
  isCompactionCommandMessage,
  type BotConfigureMaintenanceInput,
  type BotConfigureMaintenanceResult,
  type BotContinuationScope,
  BotError,
  BotId,
  BotLearningEntryId,
  type BotMaintenanceView,
  BotTaskId,
  CommandId,
  MessageId,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2ProviderThreadJson,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  type ScheduledTaskSchedule,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { SealedGenerationFailure } from "@t3tools/provider-core/server/sealedGeneration";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as BotContinuation from "./BotContinuation.ts";
import * as Evidence from "./BotMaintenanceEvidence.ts";
import * as BotRuntimePolicy from "./BotRuntimePolicy.ts";
import * as BotService from "./BotService.ts";
import * as BotStore from "./BotStore.ts";
import * as BotTaskService from "./BotTaskService.ts";
import { botMaintenanceCompactionId, isBotMaintenanceCompaction } from "./homeReturn.ts";

/** Turns one bounded packet into an unverified proposal. Never sees Home history or tools. */
type Generator = (packet: Evidence.Packet) => Effect.Effect<unknown, SealedGenerationFailure>;

export interface Outcome {
  readonly sources: number;
  readonly active: number;
  readonly pending: number;
  readonly stale: number;
  readonly duplicate: number;
}

export type DeferReason =
  /** The Home was busy at the start, or its history moved while the model worked. */
  | "home_active"
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

export type NoteDeferReason =
  | "home_active"
  | "learning_pending"
  | Extract<BotContinuation.NoteCoverage, { readonly _tag: "unprovable" }>["reason"]
  /** The Home's provider or host cannot enforce the scoped turn, so it would only fail. */
  | "unsupported";

export type NoteRefresh =
  /** The note provably covers every direct input and returned result; no turn ran. */
  | { readonly status: "current" }
  | { readonly status: "refreshed"; readonly runId: string; readonly homeRunId: string }
  | {
      readonly status: "not_refreshed";
      readonly runId: string;
      /** `run_<status>` when the scoped run ended any way but completed. */
      readonly reason:
        | "start_refused"
        | "run_missing"
        | "not_saved"
        | "not_shown"
        | `run_${string}`;
    }
  | { readonly status: "deferred"; readonly runId: string; readonly reason: NoteDeferReason };

export type CompactDeferReason =
  | "home_active"
  | "learning_pending"
  | "note_behind"
  | Extract<BotContinuation.NoteCoverage, { readonly _tag: "unprovable" }>["reason"]
  /** Deliberate compaction runs on Codex Homes only. */
  | "unsupported"
  /** The latest attempts all failed; the Home's next ordinary run opens a new window. */
  | "retry_exhausted"
  | "settings_changed";

export type HomeCompaction =
  /** Nothing to compact; no turn and no run row. */
  | {
      readonly status: "not_needed";
      readonly reason: "already_compacted" | "usage_unknown" | "below_threshold";
    }
  | { readonly status: "compacted"; readonly runId: string; readonly homeRunId: string }
  | {
      readonly status: "failed";
      readonly runId: string;
      /** `run_<status>` when the compaction run ended any way but completed. */
      readonly reason: "start_refused" | "run_missing" | `run_${string}`;
    }
  | { readonly status: "deferred"; readonly runId: string; readonly reason: CompactDeferReason };

/** Below this a cold re-read is cheap, so compacting mostly loses context for little saving. */
const COMPACT_MIN_TOKENS = 100_000;
const COMPACT_ATTEMPTS = 2;

/** The whole prompt of the scoped note refresh turn. Model-facing. */
export const NOTE_REFRESH_PROMPT =
  "Maintenance: bring your working notes up to date with this Home, then stop. Read them with t3_bot read_continuation. Its `uncovered` list holds, oldest first and in full, the Home input and returned task results no saved note has covered yet. Each item's text is split into `parts`, and each part ends with an `ack`. Reconcile each one into the note: unfinished requests, waiting questions or proposals, decisions and task results. Keep every existing item that is still open, its text exactly as it is. Give each new item a quote copied exactly from the input it comes from, or the taskIds of the task it is about. An item marked `tooLarge` shows only its first lines: do not guess the rest, and add a waiting item naming its messageId, such as `Unreviewed large input <messageId>: <what its first lines show>`. Then save the full note once with t3_bot save_continuation, that read's exact basis and `acks`: the ack of every part you saw whole. Leave out the ack of any part you saw cut or truncated; that input stays for the next refresh. Save even when nothing changed. Keep proposals in waiting until the user approves them; a new decided item needs an exact quote from the user's own message. Do nothing else: no other tool, task or message. Reply with one short line.";
/** Refresh turns one night may run; each saves one page, and the rest waits for the next night. */
const NIGHTLY_NOTE_PAGES = 3;
/** How long the next page waits for the previous refresh turn's own checkpoint to settle. */
const PAGE_CHECKPOINT_WAIT = "5 minutes";

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
    /** Runs a scoped Home turn that saves the working note, unless it already covers the Home. */
    readonly refreshNote: (scope: BotContinuationScope) => Effect.Effect<NoteRefresh, BotError>;
    /** Compacts a large idle Codex Home whose learning and working note are already saved. */
    readonly compactHome: (scope: BotContinuationScope) => Effect.Effect<HomeCompaction, BotError>;
  }
>()("t3/bots/BotMaintenance") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const decodeProviderThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJson),
);
const terminalTaskStatuses = encodeJson([...BOT_TASK_TERMINAL_STATUSES]);
/** Outbox effects that tidy up or retitle; every other unsettled effect is Home work. */
const housekeepingEffects = encodeJson([
  "scheduled-tasks.cleanup",
  "terminal.cleanup",
  "preview.cleanup",
  "attachment.cleanup",
  "thread-title.generate",
] satisfies ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>);
const RETAINED_RUNS = 30;
/** In the server's own time zone; an unattended pass runs while the person is likely away. */
const NIGHTLY: ScheduledTaskSchedule = { type: "fixed_time", timeOfDay: "03:00" };
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
    "Bot maintenance is not available for this Bot's model right now. It needs a supported, signed-in Codex model, so it stays off.",
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

export const make = Effect.gen(function* () {
  const main = yield* SqlClient.SqlClient;
  const sql = yield* BotDatabase.BotDatabase;
  const store = yield* BotStore.BotStore;
  const events = yield* EventStore.EventStoreV2;
  const homeCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const bots = yield* BotService.BotService;
  const tasks = yield* BotTaskService.BotTaskService;
  const random = yield* SecureRandom.SecureRandom;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const scheduler = yield* Scheduler.Scheduler;
  const zone = yield* DateTime.CurrentTimeZone;
  const notes = yield* BotContinuation.BotContinuation;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const sink = yield* EventSink.EventSinkV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const passLocks = yield* KeyedLock.make<ThreadId>();
  const refreshes = yield* FiberMap.make<ThreadId>();

  /**
   * The Bot's own selected instance and model, never a fallback. Availability reads the
   * instance snapshot only; nothing runs until a pass calls `generate`.
   */
  const generationOf = Effect.fn("BotMaintenance.generation")(function* (bot: BotStore.BotRow) {
    const selection = yield* BotStore.decodeModelSelection(bot.model_selection_json);
    const instance = yield* providers.getInstance(selection.instanceId);
    if (instance === undefined) return { unavailableReason: "instance_unavailable" } as const;
    const sealed = instance.sealedGeneration;
    if (sealed === undefined) return { unavailableReason: "codex_required" } as const;
    const reason = yield* sealed.availability(selection);
    if (reason !== null) return { unavailableReason: reason } as const;
    const generate: Generator = (packet) =>
      sealed
        .generate({
          selection,
          instructions: Evidence.MAINTENANCE_POLICY,
          packet: encodeJson(packet),
          schema: Evidence.Proposal,
        })
        .pipe(Effect.map((result) => result.value));
    return { unavailableReason: null, generate } as const;
  });

  /**
   * What keeps the Home busy or unavailable, or null when it is idle. Mirrors the orchestrator's
   * idle-child check plus the Home's lifecycle and owned work. Workspace setup runs while the run
   * is `preparing`; rollback, restart and delegated continuations wait as outbox effects.
   * Settling only tidies the sidebar, so a settled idle Home is still maintained.
   */
  const homeActivity = Effect.fn("BotMaintenance.homeActivity")(function* (home: ThreadId) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const [projected] = yield* main<{
      readonly lifecycle: number;
      readonly run: number;
      readonly request: number;
      readonly child: number;
      readonly background: number;
      readonly provider: number;
      readonly transfer: number;
      readonly effect: number;
    }>`SELECT
        EXISTS (SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${home}
          AND (deleted_at IS NOT NULL OR archived_at IS NOT NULL
            OR json_extract(payload_json, '$.snoozedUntil') > ${now})) AS lifecycle,
        EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${home}
          AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')) AS run,
        EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id = ${home}
          AND status = 'pending') AS request,
        EXISTS (SELECT 1 FROM orchestration_v2_projection_subagents WHERE thread_id = ${home}
          AND status IN ('pending', 'running', 'waiting')) AS child,
        EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items i WHERE i.thread_id = ${home}
          AND i.type IN ('command_execution', 'dynamic_tool', 'subagent')
          AND i.status IN ('pending', 'running', 'waiting')
          AND NOT (i.type = 'dynamic_tool' AND json_extract(i.payload_json, '$.input.persistent') IS 1)
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r
            WHERE r.run_id = i.run_id AND r.status = 'rolled_back')) AS background,
        EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE thread_id = ${home}
          AND (status = 'active' OR json_array_length(payload_json, '$.pendingBackgroundTasks') > 0)) AS provider,
        EXISTS (SELECT 1 FROM orchestration_v2_projection_context_transfers WHERE status = 'pending'
          AND ${home} IN (source_thread_id, target_thread_id)) AS transfer,
        EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox WHERE thread_id = ${home}
          AND status IN ('pending', 'running') AND effect_type NOT IN (SELECT value FROM json_each(${housekeepingEffects}))) AS effect`;
    if (projected?.lifecycle === 1) return { activity: "lifecycle", runtimes: [] } as const;
    if (projected?.run === 1) return { activity: "run", runtimes: [] } as const;
    if (projected?.request === 1) return { activity: "request", runtimes: [] } as const;
    if (projected?.child === 1) return { activity: "child", runtimes: [] } as const;
    if (projected?.background === 1) return { activity: "background", runtimes: [] } as const;
    if (projected?.provider === 1) return { activity: "provider", runtimes: [] } as const;
    if (projected?.transfer === 1) return { activity: "transfer", runtimes: [] } as const;
    if (projected?.effect === 1) return { activity: "effect", runtimes: [] } as const;
    // An unfinished return still owes the Home a message, after the task itself ended.
    const [task] = yield* sql<{ readonly task_id: string }>`SELECT task_id FROM bot_tasks
      WHERE home_thread_id = ${home} AND (status NOT IN (SELECT value FROM json_each(${terminalTaskStatuses}))
        OR (return_home_run_id IS NOT NULL AND return_finished_at IS NULL)) LIMIT 1`;
    if (task !== undefined) return { activity: "task", runtimes: [] } as const;
    const runtimes = yield* homeRuntimes(home);
    return {
      activity: (yield* runtimeActivity(runtimes)) ? "background" : null,
      runtimes,
    } as const;
  });

  /**
   * The live provider runtime behind each of the Home's provider threads, in session order.
   * Each live session has its own start gate, and Homes share sessions, so every pass takes the
   * gates in this one order or two passes can each hold one and wait for the other's.
   */
  const homeRuntimes = Effect.fn("BotMaintenance.homeRuntimes")(function* (home: ThreadId) {
    const rows = yield* main<{
      readonly provider_session_id: string;
      readonly payload_json: string;
    }>`SELECT provider_session_id, payload_json FROM orchestration_v2_projection_provider_threads
      WHERE thread_id = ${home} AND provider_session_id IS NOT NULL ORDER BY provider_session_id`;
    const found = yield* Effect.forEach(rows, (row) =>
      providerSessions.get(ProviderSessionId.make(row.provider_session_id)).pipe(
        Effect.orElseSucceed(() => Option.none<ProviderAdapter.ProviderAdapterV2SessionRuntime>()),
        Effect.map(
          Option.map((runtime) => ({ runtime, thread: decodeProviderThread(row.payload_json) })),
        ),
      ),
    );
    return found.filter(Option.isSome).map((runtime) => runtime.value);
  });
  type HomeRuntimes = Effect.Success<ReturnType<typeof homeRuntimes>>;

  /**
   * Some background work, such as Claude background Bash, lives only in the provider runtime.
   * The final probe runs inside the Bot commit, while the runtimes hold back new starts.
   */
  const runtimeActivity = Effect.fn("BotMaintenance.runtimeActivity")(function* (
    runtimes: HomeRuntimes,
  ) {
    for (const { runtime, thread } of runtimes) {
      const probe =
        Option.isSome(thread) && runtime.hasPendingBackgroundWorkForThread !== undefined
          ? runtime.hasPendingBackgroundWorkForThread(thread.value)
          : runtime.hasPendingBackgroundWork;
      // A failed probe cannot confirm that the work ended.
      if (probe !== undefined && (yield* probe.pipe(Effect.catchCause(() => Effect.succeed(true)))))
        return true;
    }
    return false;
  });

  /** Runtime-only work cannot start on the Home until `effect` ends; each runtime once. */
  const holdingBackgroundStarts = <A, E, R>(
    runtimes: HomeRuntimes,
    effect: Effect.Effect<A, E, R>,
  ) =>
    [...new Set(runtimes.map(({ runtime }) => runtime))].reduce(
      (held, runtime) => runtime.holdBackgroundStarts?.(held) ?? held,
      effect,
    );

  /**
   * Read under the Home command lock. A Bot Home's activity-starting provider events take that
   * lock too; other provider events do not, so a pass applies only if the Home's event sequence
   * is still the one it started from.
   */
  const homeAdmission = Effect.fn("BotMaintenance.homeAdmission")(function* (home: ThreadId) {
    const sequence = yield* events.latestSequence({ threadId: home });
    return { sequence, ...(yield* homeActivity(home)) };
  });

  const scopeOf = Effect.fn("BotMaintenance.scope")(function* (scope: BotContinuationScope) {
    const context = yield* store.getContext(scope.botId, scope.projectId);
    const bot = yield* store.getBot(scope.botId);
    if (context === undefined || bot === undefined)
      return yield* invalid("This Bot project context does not exist.");
    return {
      bot,
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
    const { bot, home, active } = yield* scopeOf(scope);
    const row = yield* stateRow(home);
    return {
      botId: scope.botId,
      projectId: scope.projectId,
      homeThreadId: home,
      revision: row?.settings_revision ?? 0,
      enabled: row?.enabled === 1,
      startedAt: row?.started_at ?? null,
      unavailableReason: (yield* generationOf(bot)).unavailableReason,
      writable: active,
    } satisfies BotMaintenanceView;
  }, Effect.mapError(failure));

  const configure = Effect.fn("BotMaintenance.configure")(function* (
    input: BotConfigureMaintenanceInput,
  ) {
    const scope = { botId: input.botId, projectId: input.projectId };
    const { bot, home, active } = yield* scopeOf(scope);
    if (input.enabled && (yield* generationOf(bot)).unavailableReason !== null)
      return yield* unavailable();
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
            // Resuming restarts the nightly schedule, so it never runs at once to catch up.
            yield* sql`UPDATE bot_maintenance SET enabled = ${input.enabled ? 1 : 0}, settings_revision = settings_revision + 1,
                nightly_at = CASE WHEN ${input.enabled ? 1 : 0} = 1 THEN ${now} ELSE nightly_at END, updated_at = ${now}
              WHERE home_thread_id = ${home}`;
            return true;
          }
          yield* sql`INSERT INTO bot_maintenance (home_thread_id, settings_revision, enabled, started_at, scan_through_sequence, processed_through_sequence, nightly_at, updated_at)
              VALUES (${home}, 1, 1, ${now}, ${baseline.sequence}, ${baseline.sequence}, ${now}, ${now})`;
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

  const classify = Effect.fn("BotMaintenance.classify")(function* (
    home: ThreadId,
    refs: ReadonlyArray<SourceRef>,
  ) {
    const classified = new Map<string, Evidence.Classified>();
    const messageIds = refs.filter((row) => row.kind === "home-input").map((row) => row.source_id);
    // Delivery is native acceptance: a provider turn on the input's root node, or for input
    // steered into a running turn, the acceptance the effect worker recorded on its turn item.
    const inputs = yield* main<{
      readonly message_id: string;
      readonly payload_json: string;
      readonly run_status: string | null;
      readonly steered: number;
      readonly steer_accepted: number;
      readonly turn_started: number;
    }>`SELECT m.message_id, m.payload_json, r.status AS run_status,
        i.provider_turn_id IS NOT NULL AS steered,
        json_extract(i.payload_json, '$.steerAcceptedAt') IS NOT NULL AS steer_accepted,
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
          delivery:
            row?.steered === 1
              ? row.steer_accepted === 1
                ? "delivered"
                : "unknown"
              : row?.turn_started === 1
                ? "delivered"
                : "undelivered",
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
  const insertRun = (
    home: ThreadId,
    run: {
      readonly runId: string;
      readonly status: string;
      readonly outcome: unknown;
      readonly startedAt: string;
      readonly finishedAt: string | null;
    },
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO bot_maintenance_runs (run_id, home_thread_id, status, started_at, finished_at, outcome_json)
          VALUES (${run.runId}, ${home}, ${run.status}, ${run.startedAt}, ${run.finishedAt}, ${encodeJson(run.outcome)})`;
        yield* sql`DELETE FROM bot_maintenance_runs WHERE home_thread_id = ${home} AND run_id NOT IN (
          SELECT run_id FROM bot_maintenance_runs WHERE home_thread_id = ${home} ORDER BY started_at DESC, rowid DESC LIMIT ${RETAINED_RUNS})`;
      }),
    );

  const pass = Effect.fn("BotMaintenance.pass")(function* (
    scope: BotContinuationScope,
    home: ThreadId,
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
    const runId = yield* random.uuidV4();
    const recordRun = (status: string, outcome: unknown) =>
      insertRun(home, {
        runId,
        status,
        outcome,
        startedAt: now,
        finishedAt: status === "running" ? null : now,
      });
    // Discovery only records receipts; nothing is classified or consumed while the Home is busy.
    const admitted = yield* homeCommands.withLock(home, homeAdmission(home));
    if (admitted.activity !== null) {
      yield* recordRun("deferred", { reason: "home_active", activity: admitted.activity });
      return { status: "deferred", runId, reason: "home_active" } as const;
    }

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
    // The same Bot row freezes the basis, so a later model change defers this pass.
    const generation = yield* generationOf(bot);
    if (generation.unavailableReason !== null) return yield* unavailable();
    const built = Evidence.buildBatch({
      authority: { policy: bot.learning_policy, bot, context },
      sources: eligible,
      learning: yield* store.listLearning(scope.botId),
    });
    if (built._tag === "blocked") {
      yield* recordRun("deferred", { reason: built.reason });
      return { status: "deferred", runId, reason: built.reason } as const;
    }
    const { batch } = built;
    yield* recordRun("running", { sources: batch.sources.size });

    // No Home, learning or SQL lock is held across the model call.
    const output = yield* Effect.result(generation.generate(batch.packet));
    const done = DateTime.formatIso(yield* DateTime.now);
    if (output._tag === "Failure") {
      // A refusal ran no model and a discard threw its output away; either way nothing is consumed.
      yield* finishRun(
        runId,
        "failed",
        { reason: "generation_failed", detail: output.failure.reason },
        done,
      );
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
        const admittedNow = yield* homeAdmission(home);
        if (admittedNow.activity !== null || admittedNow.sequence !== admitted.sequence)
          return yield* deferred("home_active");
        const current = yield* classify(
          home,
          selected.map((source) => ({ kind: source.kind, source_id: source.id })),
        );
        const unchanged = selected.every((source) => {
          const latest = current.get(keyOf(source));
          return latest?._tag === "eligible" && latest.source.text === source.text;
        });
        if (!unchanged) return yield* deferred("source_changed");
        const apply = bots.maintainLearning(scope, (learning) =>
          Effect.gen(function* () {
            if (yield* runtimeActivity(admittedNow.runtimes)) return yield* deferred("home_active");
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
            const marked = yield* sql<{
              readonly source_id: string;
            }>`UPDATE bot_maintenance_sources
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
        return yield* holdingBackgroundStarts(admittedNow.runtimes, apply);
      }),
    );
  });

  const runNow = Effect.fn("BotMaintenance.runNow")(function* (scope: BotContinuationScope) {
    const { bot, home } = yield* scopeOf(scope);
    // Refuses at once instead of behind a running pass; the pass resolves the model again.
    if ((yield* generationOf(bot)).unavailableReason !== null) return yield* unavailable();
    return yield* passLocks.withLock(home, pass(scope, home));
  }, Effect.mapError(failure));

  /** One outcome row for a maintenance attempt that started at `startedAt` and ends now. */
  const attempt = Effect.fn("BotMaintenance.attempt")(function* (home: ThreadId) {
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    const runId = yield* random.uuidV4();
    const settle = <A>(status: string, outcome: object, result: A) =>
      DateTime.now.pipe(
        Effect.flatMap((finished) =>
          insertRun(home, {
            runId,
            status,
            outcome,
            startedAt,
            finishedAt: DateTime.formatIso(finished),
          }),
        ),
        Effect.as(result),
      );
    return { runId, startedAt, settle };
  });

  /**
   * The Home run a maintenance message opened, once it ended, read back from the projection.
   * The stream replays persisted events after the sequence, so a run that already ended arrives.
   */
  const homeRunEnding = Effect.fn("BotMaintenance.homeRunEnding")(function* (
    home: ThreadId,
    messageId: MessageId,
    sequence: number,
  ) {
    const [run] = yield* main<{
      readonly run_id: string;
    }>`SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = ${home} AND json_extract(payload_json, '$.userMessageId') = ${messageId}`;
    if (run === undefined) return undefined;
    yield* sink.stream({ threadId: home, afterSequence: sequence, eventType: "run.updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          stored.event.runId === run.run_id &&
          ThreadManagementService.isTerminalRunStatus(stored.event.payload.status),
      ),
      Stream.runHead,
    );
    const [settled] = yield* main<{
      readonly status: string;
    }>`SELECT status FROM orchestration_v2_projection_runs WHERE run_id = ${run.run_id}`;
    return { runId: run.run_id, status: settled?.status ?? "missing" };
  });

  /**
   * Coverage is derived from the note and the Home, never stored here, so a refresh that fails
   * consumes nothing and the next one sees the same evidence. One outcome row per attempt.
   */
  const refreshPage = Effect.fn("BotMaintenance.refreshPage")(function* (
    scope: BotContinuationScope,
  ) {
    const { home, active } = yield* scopeOf(scope);
    if ((yield* stateRow(home))?.enabled !== 1 || !active)
      return yield* invalid("Bot maintenance is off for this project.");
    const { runId, startedAt, settle } = yield* attempt(home);
    const deferred = (reason: NoteDeferReason) =>
      settle<NoteRefresh>(
        "deferred",
        { note: "deferred", reason },
        {
          status: "deferred",
          runId,
          reason,
        },
      );
    const notRefreshed = (
      reason: Extract<NoteRefresh, { readonly status: "not_refreshed" }>["reason"],
      homeRunId: string | null,
    ) =>
      settle<NoteRefresh>(
        "failed",
        { note: "not_refreshed", reason, homeRunId },
        {
          status: "not_refreshed",
          runId,
          reason,
        },
      );

    // The sequence comes first, so any Home event after these reads refuses the start below.
    const read = yield* passLocks.withLock(
      home,
      homeCommands.withLock(
        home,
        Effect.gen(function* () {
          const admitted = yield* homeAdmission(home);
          if (admitted.activity !== null) return { _tag: "busy" } as const;
          yield* discover(home, startedAt);
          const pending =
            yield* sql`SELECT 1 FROM bot_maintenance_sources WHERE home_thread_id = ${home} AND state = 'pending' LIMIT 1`;
          if (pending.length > 0) return { _tag: "learning_pending" } as const;
          const [note] = yield* sql<{
            readonly frontier: string | null;
          }>`SELECT json_extract(revision_json, '$.frontier') AS frontier FROM bot_continuation_revisions WHERE home_thread_id = ${home} ORDER BY revision DESC LIMIT 1`;
          return {
            _tag: "read",
            sequence: admitted.sequence,
            coverage: yield* notes.coverage(scope),
            frontier: note?.frontier ?? null,
          } as const;
        }),
      ),
    );
    if (read._tag === "busy") return yield* deferred("home_active");
    if (read._tag === "learning_pending") return yield* deferred("learning_pending");
    const { coverage, sequence, frontier } = read;
    if (coverage._tag === "current") return { status: "current" } as const;
    if (coverage._tag === "unprovable") return yield* deferred(coverage.reason);
    const [thread] = yield* main<{
      readonly provider_instance_id: string | null;
    }>`SELECT provider_instance_id FROM orchestration_v2_projection_threads WHERE thread_id = ${home}`;
    if (
      thread?.provider_instance_id == null ||
      (yield* BotRuntimePolicy.restrictionUnenforceable(
        providers,
        ProviderInstanceId.make(thread.provider_instance_id),
      )) !== undefined
    )
      return yield* deferred("unsupported");

    const messageId = MessageId.make(`bot-maintenance:note:${home}:${sequence}`);
    const started = yield* Effect.result(
      threads.dispatch({
        type: "restricted_run.start",
        commandId: CommandId.make(messageId),
        threadId: home,
        messageId,
        text: NOTE_REFRESH_PROMPT,
        restriction: "botNote",
        ifIdleAtSequence: sequence,
      }),
    );
    if (started._tag === "Failure") {
      yield* Effect.logWarning("Bot note refresh was refused", { home, cause: started.failure });
      return yield* notRefreshed("start_refused", null);
    }
    if (started.success.deferred === true) return yield* deferred("home_active");
    const run = yield* homeRunEnding(home, messageId, sequence);
    if (run === undefined) return yield* notRefreshed("run_missing", null);
    if (run.status !== "completed") return yield* notRefreshed(`run_${run.status}`, run.runId);
    const [saved] = yield* sql<{
      readonly frontier: string | null;
    }>`SELECT json_extract(revision_json, '$.frontier') AS frontier FROM bot_continuation_revisions
      WHERE home_thread_id = ${home} AND json_extract(revision_json, '$.updatedBy.runId') = ${run.runId}
      ORDER BY revision DESC LIMIT 1`;
    if (saved === undefined) return yield* notRefreshed("not_saved", run.runId);
    // Only a save from a read that showed the uncovered page moves the frontier.
    if (saved.frontier === frontier) return yield* notRefreshed("not_shown", run.runId);
    return yield* settle<NoteRefresh>(
      "applied",
      { note: "refreshed", homeRunId: run.runId },
      {
        status: "refreshed",
        runId,
        homeRunId: run.runId,
      },
    );
  });

  /**
   * Whether the Home's provider context is large enough to compact. Usage is the context size the
   * provider last reported for the Home's native conversation; a compaction it already ran, or
   * attempts that keep failing, wait for the Home's next ordinary run.
   */
  const compactionNeed = Effect.fn("BotMaintenance.compactionNeed")(function* (home: ThreadId) {
    const recent = yield* main<{
      readonly status: string;
      readonly payload_json: string | null;
    }>`SELECT r.status, m.payload_json FROM orchestration_v2_projection_runs r
      LEFT JOIN orchestration_v2_projection_messages m ON m.message_id = json_extract(r.payload_json, '$.userMessageId')
      WHERE r.thread_id = ${home} AND r.status <> 'queued'
        AND NOT (r.status = 'cancelled' AND json_extract(r.payload_json, '$.startedAt') IS NULL)
      ORDER BY r.ordinal DESC LIMIT ${COMPACT_ATTEMPTS}`;
    const runs = recent.map((row) => ({
      status: row.status,
      message:
        row.payload_json === null
          ? undefined
          : Option.getOrUndefined(decodeMessage(row.payload_json)),
    }));
    const latest = runs[0];
    if (
      latest?.status === "completed" &&
      latest.message !== undefined &&
      isCompactionCommandMessage(latest.message)
    )
      return { _tag: "not_needed", reason: "already_compacted" } as const;
    if (
      runs.length === COMPACT_ATTEMPTS &&
      runs.every((run) => run.status !== "completed" && isBotMaintenanceCompaction(run.message))
    )
      return { _tag: "deferred", reason: "retry_exhausted" } as const;
    const [native] = yield* main<{
      readonly provider_thread_id: string;
      readonly driver: string | null;
    }>`SELECT p.provider_thread_id, p.driver FROM orchestration_v2_projection_threads t
      JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = t.active_provider_thread_id
      WHERE t.thread_id = ${home}`;
    const [usage] =
      native === undefined
        ? []
        : yield* main<{
            readonly used: number | null;
            readonly max: number | null;
          }>`SELECT json_extract(payload_json, '$.tokenUsage.usedTokens') AS used, json_extract(payload_json, '$.tokenUsage.maxTokens') AS max
            FROM orchestration_v2_projection_provider_turns
            WHERE provider_thread_id = ${native.provider_thread_id} AND json_extract(payload_json, '$.tokenUsage') IS NOT NULL
            ORDER BY julianday(json_extract(payload_json, '$.tokenUsage.updatedAt')) DESC, ordinal DESC LIMIT 1`;
    if (usage?.used == null) return { _tag: "not_needed", reason: "usage_unknown" } as const;
    if (usage.used < Math.max(COMPACT_MIN_TOKENS, Math.ceil((usage.max ?? 0) / 2)))
      return { _tag: "not_needed", reason: "below_threshold" } as const;
    if (native?.driver !== "codex") return { _tag: "deferred", reason: "unsupported" } as const;
    return { _tag: "needed" } as const;
  });

  /**
   * Every gate reads one snapshot: the Home's sequence first, then need, activity, learning
   * receipts and note coverage. The `/compact` starts only if the Home is still idle at that
   * sequence, and a message that arrives before the provider starts it skips it.
   */
  const compactHome = Effect.fn("BotMaintenance.compactHome")(function* (
    scope: BotContinuationScope,
  ) {
    const { home, active } = yield* scopeOf(scope);
    const state = yield* stateRow(home);
    if (state?.enabled !== 1 || !active)
      return yield* invalid("Bot maintenance is off for this project.");
    const { runId, startedAt, settle } = yield* attempt(home);
    const deferred = (reason: CompactDeferReason) =>
      settle<HomeCompaction>(
        "deferred",
        { compact: "deferred", reason },
        {
          status: "deferred",
          runId,
          reason,
        },
      );
    const failed = (
      reason: Extract<HomeCompaction, { readonly status: "failed" }>["reason"],
      homeRunId: string | null,
    ) =>
      settle<HomeCompaction>(
        "failed",
        { compact: "failed", reason, homeRunId },
        {
          status: "failed",
          runId,
          reason,
        },
      );

    const admitted = yield* passLocks.withLock(
      home,
      Effect.gen(function* () {
        const read = yield* homeCommands.withLock(
          home,
          Effect.gen(function* () {
            const admission = yield* homeAdmission(home);
            const need = yield* compactionNeed(home);
            if (need._tag !== "needed") return need;
            if (admission.activity !== null)
              return { _tag: "deferred", reason: "home_active" } as const;
            yield* discover(home, startedAt);
            const pending =
              yield* sql`SELECT 1 FROM bot_maintenance_sources WHERE home_thread_id = ${home} AND state = 'pending' LIMIT 1`;
            if (pending.length > 0)
              return { _tag: "deferred", reason: "learning_pending" } as const;
            const coverage = yield* notes.coverage(scope);
            if (coverage._tag === "behind")
              return { _tag: "deferred", reason: "note_behind" } as const;
            if (coverage._tag === "unprovable")
              return { _tag: "deferred", reason: coverage.reason } as const;
            return { _tag: "admitted", sequence: admission.sequence } as const;
          }),
        );
        if (read._tag !== "admitted") return read;
        // Settings change without a Home event, so they are checked again right before the start.
        const latest = yield* stateRow(home);
        if (latest?.enabled !== 1 || latest.settings_revision !== state.settings_revision)
          return { _tag: "deferred", reason: "settings_changed" } as const;
        const messageId = MessageId.make(botMaintenanceCompactionId(home, read.sequence));
        const started = yield* Effect.result(
          threads.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(messageId),
            threadId: home,
            messageId,
            text: "/compact",
            attachments: [],
            createdBy: "system",
            creationSource: "server",
            dispatchMode: { type: "start_immediately" },
            ifIdleAtSequence: read.sequence,
          }),
        );
        return { _tag: "dispatched", started, messageId, sequence: read.sequence } as const;
      }),
    );
    if (admitted._tag === "not_needed")
      return { status: "not_needed", reason: admitted.reason } satisfies HomeCompaction;
    if (admitted._tag === "deferred") return yield* deferred(admitted.reason);
    const { started, messageId, sequence } = admitted;
    if (started._tag === "Failure") {
      yield* Effect.logWarning("Bot maintenance compaction was refused", {
        home,
        cause: started.failure,
      });
      return yield* failed("start_refused", null);
    }
    if (started.success.deferred === true) return yield* deferred("home_active");
    // Admission is not the result: only the persisted run says whether the provider compacted.
    const run = yield* homeRunEnding(home, messageId, sequence);
    if (run === undefined) return yield* failed("run_missing", null);
    if (run.status !== "completed") return yield* failed(`run_${run.status}`, run.runId);
    return yield* settle<HomeCompaction>(
      "applied",
      { compact: "compacted", homeRunId: run.runId },
      { status: "compacted", runId, homeRunId: run.runId },
    );
  }, Effect.mapError(failure));

  /**
   * The refresh run completes before its checkpoint and workspace refresh settle, and admission
   * counts that effect as Home activity; any other activity still defers. Learning then sets the
   * refresh prompt aside, which otherwise holds the next step back as unlearned input.
   */
  const afterRefreshTurn = (scope: BotContinuationScope, homeRunId: string) =>
    outbox
      .awaitSettled(`effect:checkpoint.capture:${homeRunId}`)
      .pipe(
        Effect.timeoutOption(PAGE_CHECKPOINT_WAIT),
        Effect.ignore({ log: true }),
        Effect.andThen(runNow(scope).pipe(Effect.ignore({ log: true }))),
      );

  /**
   * Page after page until the note is current, an attempt does not refresh, or the night's bound.
   * Returns the last attempt; a final `current` reports the refresh that reached it.
   */
  const refreshNote = Effect.fn("BotMaintenance.refreshNote")(function* (
    scope: BotContinuationScope,
  ) {
    let last: NoteRefresh = yield* refreshPage(scope);
    for (let page = 1; page < NIGHTLY_NOTE_PAGES && last.status === "refreshed"; page += 1) {
      yield* afterRefreshTurn(scope, last.homeRunId);
      const next = yield* refreshPage(scope);
      if (next.status === "current") break;
      last = next;
    }
    return last;
  }, Effect.mapError(failure));

  /** Preserve first, then compact; the compaction rechecks every gate itself. */
  const maintainHome = (scope: BotContinuationScope) =>
    refreshNote(scope).pipe(
      Effect.flatMap((note) =>
        note.status === "refreshed" ? afterRefreshTurn(scope, note.homeRunId) : Effect.void,
      ),
      Effect.ignore({ log: true }),
      Effect.andThen(compactHome(scope).pipe(Effect.ignore({ log: true }))),
    );

  /**
   * One attempt a night per enabled Home, after missed nights too. The night is claimed before
   * the pass, so a paused, unavailable or busy Bot skips it and a crash never repeats it.
   * Polled every few seconds, so only a due pass is traced, through `runNow`.
   */
  const runNightly = Effect.gen(function* () {
    const now = DateTime.setZone(yield* DateTime.now, zone);
    const homes = yield* sql<{
      readonly home_thread_id: string;
      readonly bot_id: string;
      readonly project_id: string;
      readonly nightly_at: string;
    }>`SELECT m.home_thread_id, c.bot_id, c.project_id, COALESCE(m.nightly_at, m.updated_at) AS nightly_at
      FROM bot_maintenance m JOIN bot_project_contexts c ON c.home_thread_id = m.home_thread_id
      WHERE m.enabled = 1`;
    for (const row of homes) {
      const due = nextScheduledRunAt(
        NIGHTLY,
        DateTime.setZone(DateTime.makeUnsafe(row.nightly_at), zone),
      );
      if (due === null || DateTime.isGreaterThan(due, now)) continue;
      yield* sql`UPDATE bot_maintenance SET nightly_at = ${DateTime.formatIso(now)} WHERE home_thread_id = ${row.home_thread_id}`;
      const scope = { botId: BotId.make(row.bot_id), projectId: ProjectId.make(row.project_id) };
      yield* runNow(scope).pipe(Effect.ignore({ log: true }));
      // The refresh and compaction wait on Home turns, so the other Homes' passes do not wait.
      yield* FiberMap.run(refreshes, ThreadId.make(row.home_thread_id), maintainHome(scope), {
        onlyIfMissing: true,
      });
    }
  });
  yield* scheduler.register("bot-maintenance", runNightly);

  return BotMaintenance.of({ get, configure, runNow, refreshNote, compactHome });
});

export const layer = Layer.effect(BotMaintenance, make).pipe(
  Layer.provide(Layer.merge(BotStore.layer, DateTime.layerCurrentZoneLocal)),
);
