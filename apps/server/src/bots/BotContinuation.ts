// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto has no HMAC implementation.
import * as NodeCrypto from "node:crypto";
import {
  BOT_CONTINUATION_LIMITS,
  BOT_TASK_TERMINAL_STATUSES,
  BOT_CONTINUATION_SECTIONS,
  BotContinuationBasis,
  BotContinuationNote,
  BotContinuationRevision,
  BotContinuationScope,
  BotContinuationView,
  BotSaveContinuationInput,
  BotSaveContinuationResult,
  BotError,
  BotTaskId,
  BotTaskStatus,
  NonNegativeInt,
  OrchestrationV2ConversationMessageJson,
  RunId,
  ThreadId,
  isCompactionCommandMessage,
  type BotContinuationRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as BotStore from "./BotStore.ts";
import { isDirectHomeInput } from "./homeReturn.ts";

const BasisPayload = Schema.Struct({
  homeThreadId: ThreadId,
  runId: RunId,
  fromOrdinal: Schema.NullOr(NonNegativeInt),
  throughOrdinal: Schema.NullOr(NonNegativeInt),
  digest: Schema.NullOr(Schema.String),
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeRevision = Schema.encodeEffect(Schema.fromJsonString(BotContinuationRevision));
const decodeBasis = Schema.decodeUnknownEffect(Schema.fromJsonString(BasisPayload));
const decodeRevision = Schema.decodeUnknownEffect(Schema.fromJsonString(BotContinuationRevision));
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const decodeSave = Schema.decodeUnknownEffect(BotSaveContinuationInput);
const decodeNote = Schema.decodeUnknownEffect(BotContinuationNote);
const emptyNote = (): BotContinuationNote => ({
  requests: [],
  waiting: [],
  decided: [],
  context: [],
});
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const sourceDigest = (
  sources: readonly {
    readonly ordinal: number;
    readonly message: {
      readonly id: string;
      readonly text: string;
      readonly createdBy: unknown;
      readonly creationSource: unknown;
    };
  }[],
) =>
  hash(
    encodeJson(
      sources.map(({ ordinal, message }) => [
        ordinal,
        message.id,
        hash(message.text),
        message.createdBy,
        message.creationSource,
      ]),
    ),
  );
const invalid = (message: string) => new BotError({ message });
const isBotError = Schema.is(BotError);
const failure = (cause: unknown) =>
  isBotError(cause)
    ? cause
    : new BotError({ message: "Could not read or save working notes.", cause });
interface RevisionRow {
  readonly revision: number;
  readonly update_id: string;
  readonly request_hash: string;
  readonly revision_json: string;
}
interface SourceRow {
  readonly ordinal: number;
  readonly payload_json: string;
}
type Caller = { readonly kind: "user" } | { readonly kind: "bot"; readonly threadId: ThreadId };

export class BotContinuation extends Context.Service<
  BotContinuation,
  {
    readonly get: (scope: BotContinuationScope) => Effect.Effect<BotContinuationView, BotError>;
    readonly history: (
      scope: BotContinuationScope,
    ) => Effect.Effect<{ readonly revisions: readonly BotContinuationRevision[] }, BotError>;
    readonly save: (
      input: BotSaveContinuationInput,
      caller: Caller,
    ) => Effect.Effect<BotSaveContinuationResult, BotError>;
  }
>()("t3/bots/BotContinuation") {}

const make = Effect.gen(function* () {
  const main = yield* SqlClient.SqlClient;
  const sql = yield* BotDatabase.BotDatabase;
  const store = yield* BotStore.BotStore;
  const random = yield* SecureRandom.SecureRandom;
  // Bases expire on process restart; committed retry identities remain in SQLite.
  const key = yield* random.randomBytes(32).pipe(Effect.orDie);
  const signature = (payload: string) =>
    NodeCrypto.createHmac("sha256", key).update(payload).digest("base64url");
  const signed = (payload: typeof BasisPayload.Type): BotContinuationBasis => {
    const body = Buffer.from(encodeJson(payload)).toString("base64url");
    return {
      token: `${body}.${signature(body)}`,
      fromOrdinal: payload.fromOrdinal,
      throughOrdinal: payload.throughOrdinal,
    };
  };
  const verified = Effect.fn("BotContinuation.verifyBasis")(function* (
    basis: BotContinuationBasis,
  ) {
    const [body, mac, extra] = basis.token.split(".");
    if (body === undefined || mac === undefined || extra !== undefined || signature(body) !== mac)
      return yield* invalid(
        "The save basis expired or is invalid. Read the current working notes again.",
      );
    const payload = yield* decodeBasis(Buffer.from(body, "base64url").toString("utf8"));
    if (
      payload.fromOrdinal !== basis.fromOrdinal ||
      payload.throughOrdinal !== basis.throughOrdinal
    )
      return yield* invalid("The save basis boundary was changed.");
    return payload;
  });
  const scopeOf = Effect.fn("BotContinuation.scope")(function* (scope: BotContinuationScope) {
    const context = yield* store.getContext(scope.botId, scope.projectId);
    const bot = yield* store.getBot(scope.botId);
    if (context === undefined || bot === undefined)
      return yield* invalid("This Bot project context does not exist.");
    return { context, bot, home: ThreadId.make(context.home_thread_id) };
  });
  const currentRow = Effect.fn("BotContinuation.currentRow")(function* (home: ThreadId) {
    return (yield* sql<RevisionRow>`SELECT * FROM bot_continuation_revisions WHERE home_thread_id = ${home} ORDER BY revision DESC LIMIT 1`)[0];
  });
  const activeRun = Effect.fn("BotContinuation.activeRun")(function* (home: ThreadId) {
    return (yield* main<{
      readonly run_id: string;
      readonly ordinal: number;
    }>`SELECT run_id, ordinal FROM orchestration_v2_projection_runs WHERE thread_id = ${home} AND status IN ('starting', 'running', 'waiting') ORDER BY ordinal DESC LIMIT 1`)[0];
  });
  const directClause = main.literal(`m.role = 'user'
    AND json_extract(m.payload_json, '$.notification') IS NULL
    AND json_extract(m.payload_json, '$.delegatedCompletion') IS NULL
    AND json_extract(m.payload_json, '$.senderThreadId') IS NULL
    AND json_extract(m.payload_json, '$.scheduledTaskId') IS NULL
    AND ((json_extract(m.payload_json, '$.createdBy') = 'user' AND json_extract(m.payload_json, '$.creationSource') IN ('web', 'mobile'))
      OR (json_extract(m.payload_json, '$.createdBy') = 'agent' AND json_extract(m.payload_json, '$.creationSource') = 'mcp'))
    AND (lower(trim(json_extract(m.payload_json, '$.text'))) != '/compact' OR json_array_length(json_extract(m.payload_json, '$.attachments')) > 0)
    AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs hidden WHERE hidden.run_id = i.run_id AND (hidden.status = 'rolled_back' OR (hidden.status = 'cancelled' AND json_extract(i.payload_json, '$.inputIntent') = 'queued_turn')))`);
  const sourceWindow = Effect.fn("BotContinuation.sourceWindow")(function* (
    home: ThreadId,
    through: number | null = null,
  ) {
    const rows = yield* main<SourceRow>`SELECT i.ordinal, m.payload_json
      FROM orchestration_v2_projection_turn_items i
      JOIN orchestration_v2_projection_messages m ON m.message_id = json_extract(i.payload_json, '$.messageId') AND m.thread_id = i.thread_id
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id
      WHERE i.thread_id = ${home} AND i.type = 'user_message' AND ${directClause}
        AND (${through} IS NULL OR i.ordinal <= ${through})
        AND (r.run_id IS NULL OR r.status NOT IN ('queued', 'preparing', 'rolled_back'))
      ORDER BY i.ordinal DESC LIMIT 200`;
    return yield* Effect.forEach(rows, (row) =>
      decodeMessage(row.payload_json).pipe(
        Effect.map((message) => ({ ordinal: row.ordinal, message })),
      ),
    );
  });
  const resolveNote = Effect.fn("BotContinuation.resolveNote")(function* (
    home: ThreadId,
    note: BotContinuationNote,
  ) {
    const resolveRef = Effect.fn("BotContinuation.resolveRef")(function* (ref: BotContinuationRef) {
      if (ref.kind === "user") return ref;
      if (ref.kind === "task") {
        const task = (yield* sql<{
          readonly status: BotTaskStatus;
          readonly result_run_id: string | null;
          readonly cancel_requested_at: string | null;
        }>`SELECT status, result_run_id, cancel_requested_at FROM bot_tasks WHERE home_thread_id = ${home} AND task_id = ${ref.taskId}`)[0];
        return {
          ...ref,
          status:
            task === undefined
              ? null
              : task.cancel_requested_at !== null && !BOT_TASK_TERMINAL_STATUSES.has(task.status)
                ? "cancelled"
                : task.status,
          resultRunId: task?.result_run_id == null ? null : RunId.make(task.result_run_id),
          availability: task === undefined ? "historical_unverified" : "available",
        } satisfies BotContinuationRef;
      }
      const row = (yield* main<{
        readonly payload_json: string;
        readonly run_status: string | null;
        readonly input_intent: string | null;
      }>`SELECT m.payload_json, r.status AS run_status, json_extract(i.payload_json, '$.inputIntent') AS input_intent FROM orchestration_v2_projection_messages m JOIN orchestration_v2_projection_turn_items i ON i.thread_id = m.thread_id AND json_extract(i.payload_json, '$.messageId') = m.message_id LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id WHERE m.thread_id = ${home} AND m.message_id = ${ref.messageId} AND i.ordinal = ${ref.ordinal} AND i.type = 'user_message' LIMIT 1`)[0];
      const source = row === undefined ? undefined : yield* decodeMessage(row.payload_json);
      const available =
        source !== undefined &&
        row?.run_status !== "rolled_back" &&
        !(row?.run_status === "cancelled" && row.input_intent === "queued_turn") &&
        isDirectHomeInput(source) &&
        !isCompactionCommandMessage(source) &&
        hash(source.text) === ref.digest &&
        ref.directUser === (source.createdBy === "user") &&
        source.text.includes(ref.quote);
      return {
        ...ref,
        availability: available ? "available" : "historical_unverified",
      } satisfies BotContinuationRef;
    });
    const sections = yield* Effect.forEach(BOT_CONTINUATION_SECTIONS, (section) =>
      Effect.forEach(note[section], (item) =>
        Effect.forEach(item.refs, resolveRef).pipe(Effect.map((refs) => ({ ...item, refs }))),
      ),
    );
    return {
      requests: sections[0]!,
      waiting: sections[1]!,
      decided: sections[2]!,
      context: sections[3]!,
    };
  });
  const get = Effect.fn("BotContinuation.get")(function* (scope: BotContinuationScope) {
    const { context, bot, home } = yield* scopeOf(scope);
    const row = yield* currentRow(home);
    const revision = row === undefined ? null : yield* decodeRevision(row.revision_json);
    const run = yield* activeRun(home);
    const window = run === undefined ? [] : yield* sourceWindow(home);
    // Older inputs are already in the conversation; future queued runs never enter this basis.
    const eligibleRows =
      run === undefined
        ? []
        : yield* main<{
            readonly ordinal: number;
          }>`SELECT i.ordinal FROM orchestration_v2_projection_turn_items i LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id WHERE i.thread_id = ${home} AND i.type = 'user_message' AND (r.ordinal <= ${run.ordinal} OR r.run_id IS NULL) AND (r.status IS NULL OR r.status NOT IN ('queued', 'preparing', 'rolled_back')) ORDER BY i.ordinal DESC LIMIT 1`;
    const through = eligibleRows[0]?.ordinal ?? null;
    const supplied = window.filter((source) => through !== null && source.ordinal <= through);
    const newest = supplied[0];
    const basis =
      run === undefined
        ? null
        : signed({
            homeThreadId: home,
            runId: RunId.make(run.run_id),
            fromOrdinal: supplied.at(-1)?.ordinal ?? null,
            throughOrdinal: newest?.ordinal ?? null,
            digest: sourceDigest(supplied),
          });
    const gap = (yield* main<{
      readonly count: number;
      readonly firstOrdinal: number | null;
      readonly lastOrdinal: number | null;
    }>`SELECT COUNT(*) AS count, MIN(i.ordinal) AS firstOrdinal, MAX(i.ordinal) AS lastOrdinal FROM orchestration_v2_projection_turn_items i JOIN orchestration_v2_projection_messages m ON m.message_id = json_extract(i.payload_json, '$.messageId') AND m.thread_id = i.thread_id WHERE i.thread_id = ${home} AND i.type = 'user_message' AND ${directClause} AND i.ordinal > ${revision?.coverage?.throughOrdinal ?? -1}`)[0]!;
    const tasks = yield* sql<{
      readonly task_id: string;
      readonly title: string;
      readonly status: BotTaskStatus;
      readonly work_thread_id: string | null;
      readonly total: number;
    }>`SELECT task_id, title, status, work_thread_id, COUNT(*) OVER() AS total FROM bot_tasks WHERE home_thread_id = ${home} AND status IN ('accepted','running','waiting') AND cancel_requested_at IS NULL ORDER BY created_at, task_id LIMIT 8`;
    return {
      ...scope,
      homeThreadId: home,
      revision: revision?.revision ?? null,
      note: yield* resolveNote(home, revision?.note ?? emptyNote()),
      updatedBy: revision?.updatedBy ?? null,
      updatedAt: revision?.updatedAt ?? null,
      restoredFrom: revision?.restoredFrom ?? null,
      coverage: revision?.coverage ?? null,
      basis,
      writable: bot.archived_at === null && context.detached_at === null,
      newerInputs: gap,
      sources: supplied.slice(0, 8).map(({ ordinal, message }) => ({
        messageId: message.id,
        ordinal,
        text: message.text.slice(0, 400),
        directUser: message.createdBy === "user",
      })),
      moreSources: Math.max(0, supplied.length - 8),
      activeTasks: tasks.map((task) => ({
        taskId: BotTaskId.make(task.task_id),
        title: task.title.slice(0, 160),
        status: task.status,
        workThreadId: task.work_thread_id === null ? null : ThreadId.make(task.work_thread_id),
      })),
      moreActiveTasks: Math.max(0, (tasks[0]?.total ?? 0) - tasks.length),
    } satisfies BotContinuationView;
  }, Effect.mapError(failure));
  const history = Effect.fn("BotContinuation.history")(function* (scope: BotContinuationScope) {
    const { home } = yield* scopeOf(scope);
    const rows =
      yield* sql<RevisionRow>`SELECT * FROM bot_continuation_revisions WHERE home_thread_id = ${home} ORDER BY revision DESC LIMIT 20`;
    return {
      revisions: yield* Effect.forEach(rows, (row) =>
        decodeRevision(row.revision_json).pipe(
          Effect.flatMap((revision) =>
            resolveNote(home, revision.note).pipe(Effect.map((note) => ({ ...revision, note }))),
          ),
        ),
      ),
    };
  }, Effect.mapError(failure));
  const save = Effect.fn("BotContinuation.save")(function* (
    raw: BotSaveContinuationInput,
    caller: Caller,
  ) {
    const input = yield* decodeSave(raw);
    const { home } = yield* scopeOf(input);
    if (caller.kind === "bot" && caller.threadId !== home)
      return yield* invalid("Only this Bot project's Home can save its working notes.");
    if (caller.kind === "bot" && input.restoredFrom !== undefined)
      return yield* invalid("Only the user can restore a working-note revision.");
    const requestHash = hash(
      encodeJson({
        baseRevision: input.baseRevision,
        note: BOT_CONTINUATION_SECTIONS.map((section) =>
          input.note[section].map((item) => [item.text, item.quote ?? null, item.taskIds ?? []]),
        ),
        basis: input.basis ?? null,
        restoredFrom: input.restoredFrom ?? null,
        caller,
      }),
    );
    const old = yield* currentRow(home);
    const previous = old === undefined ? null : yield* decodeRevision(old.revision_json);
    const retry =
      (yield* sql<RevisionRow>`SELECT * FROM bot_continuation_revisions WHERE home_thread_id = ${home} AND update_id = ${input.updateId}`)[0];
    const now = DateTime.formatIso(yield* DateTime.now);
    let coverage = previous?.coverage ?? null;
    let writer: BotContinuationRevision["updatedBy"] = { kind: "user" };
    let basis: typeof BasisPayload.Type | null = null;
    let note = emptyNote();
    let scopedSources: readonly {
      readonly ordinal: number;
      readonly message: typeof OrchestrationV2ConversationMessageJson.Type;
    }[] = [];
    if (retry === undefined && caller.kind === "bot") {
      if (input.basis === undefined)
        return yield* invalid(
          "Copy the exact save basis from the current Home instructions or read_continuation.",
        );
      basis = yield* verified(input.basis);
      const run = yield* activeRun(home);
      if (basis.homeThreadId !== home || basis.runId !== run?.run_id)
        return yield* invalid(
          "The save basis belongs to another Home or run. Read the current working notes again.",
        );
      const window = yield* sourceWindow(home, basis.throughOrdinal ?? -1);
      scopedSources = window.filter((source) => source.ordinal >= (basis!.fromOrdinal ?? 0));
      if (sourceDigest(scopedSources) !== basis.digest)
        return { _tag: "conflict", reason: "basis", current: yield* get(input) } as const;
      coverage = { fromOrdinal: basis.fromOrdinal, throughOrdinal: basis.throughOrdinal };
      writer = { kind: "bot", threadId: home, runId: basis.runId };
    }
    if (retry === undefined && input.restoredFrom !== undefined) {
      const restored =
        (yield* sql<RevisionRow>`SELECT * FROM bot_continuation_revisions WHERE home_thread_id = ${home} AND revision = ${input.restoredFrom}`)[0];
      if (restored === undefined) return yield* invalid("That revision is no longer retained.");
      const revision = yield* decodeRevision(restored.revision_json);
      if (
        BOT_CONTINUATION_SECTIONS.some(
          (section) =>
            encodeJson(input.note[section].map((item) => item.text)) !==
            encodeJson(revision.note[section].map((item) => item.text)),
        )
      )
        return yield* invalid("Restore must use the selected revision's text.");
      note = revision.note;
      coverage = revision.coverage;
    } else if (retry === undefined) {
      for (const section of BOT_CONTINUATION_SECTIONS) {
        const items: BotContinuationNote[typeof section][number][] = [];
        for (const item of input.note[section]) {
          const carried = previous?.note[section].find((entry) => entry.text === item.text);
          let refs: readonly BotContinuationRef[];
          if (caller.kind === "user")
            refs = carried?.refs ?? [{ kind: "user", revision: (previous?.revision ?? 0) + 1 }];
          else {
            const quoted =
              item.quote === undefined
                ? undefined
                : scopedSources.find(
                    ({ message }) =>
                      message.text.includes(item.quote!) &&
                      (section !== "decided" ||
                        (message.createdBy === "user" &&
                          (message.creationSource === "web" ||
                            message.creationSource === "mobile"))),
                  );
            if (section === "decided" && carried === undefined && quoted === undefined)
              return yield* invalid(
                "A new Bot decision needs an exact quote from direct user input; a proposal is not approval.",
              );
            const source = quoted ?? (carried === undefined ? scopedSources[0] : undefined);
            refs =
              source === undefined
                ? (carried?.refs ?? [])
                : [
                    {
                      kind: "message",
                      messageId: source.message.id,
                      ordinal: source.ordinal,
                      digest: hash(source.message.text),
                      quote: item.quote ?? source.message.text.slice(0, 400),
                      directUser: source.message.createdBy === "user",
                      availability: "available",
                    },
                  ];
            if (item.quote !== undefined && quoted === undefined)
              return yield* invalid(
                "The quote was not found in the supplied source window. Read the Home history and reconcile it first.",
              );
            if (refs.length === 0)
              return yield* invalid("New Bot note items need a source in the supplied Home basis.");
          }
          for (const taskId of item.taskIds ?? []) {
            const task = (yield* sql<{
              readonly status: BotTaskStatus;
              readonly result_run_id: string | null;
            }>`SELECT status, result_run_id FROM bot_tasks WHERE home_thread_id = ${home} AND task_id = ${taskId}`)[0];
            if (task === undefined)
              return yield* invalid("A task reference must belong to this Home.");
            refs = [
              ...refs.filter((ref) => ref.kind !== "task" || ref.taskId !== taskId),
              {
                kind: "task",
                taskId,
                status: task.status,
                resultRunId: task.result_run_id === null ? null : RunId.make(task.result_run_id),
                availability: "available",
              },
            ];
          }
          items.push({ text: item.text, refs });
        }
        note = { ...note, [section]: items };
      }
    }
    if (retry === undefined) note = yield* decodeNote(note);
    const revision: BotContinuationRevision = {
      revision: (previous?.revision ?? 0) + 1,
      note,
      coverage,
      updatedBy: writer,
      updatedAt: now,
      restoredFrom: input.restoredFrom ?? null,
    };
    const encoded = yield* encodeRevision(revision);
    if (encoded.length > 64000)
      return yield* invalid(
        "The working-note references are too large. Use fewer task references or shorter quotes.",
      );
    // Projection reads and all source resolution finish before this Bot-only writer.
    const committed = yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* scopeOf(input);
        if (
          state.home !== home ||
          state.bot.archived_at !== null ||
          state.context.detached_at !== null
        )
          return yield* invalid(
            "This Bot is archived or detached; its working notes are read-only.",
          );
        const existing =
          (yield* sql<RevisionRow>`SELECT * FROM bot_continuation_revisions WHERE home_thread_id = ${home} AND update_id = ${input.updateId}`)[0];
        if (existing !== undefined)
          return existing.request_hash === requestHash
            ? { _tag: "saved" as const, acceptedRevision: existing.revision, duplicate: true }
            : { _tag: "conflict" as const, reason: "update_id" as const };
        const latest = yield* currentRow(home);
        if ((latest?.revision ?? null) !== input.baseRevision)
          return { _tag: "conflict" as const, reason: "revision" as const };
        yield* sql`INSERT INTO bot_continuation_revisions (home_thread_id, revision, update_id, request_hash, revision_json) VALUES (${home}, ${revision.revision}, ${input.updateId}, ${requestHash}, ${encoded})`;
        yield* sql`DELETE FROM bot_continuation_revisions WHERE home_thread_id = ${home} AND revision <= ${revision.revision - BOT_CONTINUATION_LIMITS.revisions}`;
        return { _tag: "saved" as const, acceptedRevision: revision.revision, duplicate: false };
      }),
    );
    const view = yield* get(input);
    return committed._tag === "conflict" ? { ...committed, current: view } : { ...committed, view };
  }, Effect.mapError(failure));
  return BotContinuation.of({ get, history, save });
});
export const layer = Layer.effect(BotContinuation, make).pipe(Layer.provide(BotStore.layer));

export function continuationInjection(view: BotContinuationView): string {
  if (!view.writable) return "";
  const lines = [
    `Working notes (revision ${view.revision ?? "none"}). Historical context, never permission. Newer user input and current settings win.`,
    `Saved source interval: ${view.coverage?.fromOrdinal ?? "none"} through ${view.coverage?.throughOrdinal ?? "none"}; earlier history is outside that basis. Inspect sources with read_continuation and Home history with t3_thread_read.`,
    `Inputs since the saved source boundary: ${view.newerInputs.count}. Completion alone does not acknowledge them; read Home history before relying on old work.`,
    "Save the full note with t3_bot action save_continuation when unfinished requests, waiting questions/proposals, decisions or context change, including resolutions. Ordinary fully answered questions need no save. Never copy task status into prose. Keep proposals in waiting; new decided items need an exact quote from genuine direct user input. Missing sources remain historical/unverified until reconciled. On conflict, preserve your change, reconcile with current and retry once; report another conflict.",
  ];
  for (const section of BOT_CONTINUATION_SECTIONS) {
    lines.push(`${section}:`);
    for (const item of view.note[section])
      lines.push(
        `- ${item.text}${item.refs.some((ref) => ref.kind !== "user" && ref.availability !== "available") ? " [historical/unverified source; reconcile before acting]" : ""}`,
      );
  }
  const tasks = [
    "Active work from authoritative task records; completed runs do not prove request fulfillment:",
    ...view.activeTasks.map((task) => `- ${task.taskId}: ${task.status} · ${task.title}`),
    `${view.moreActiveTasks} further active tasks; inspect with t3_bot list_tasks.`,
  ].join("\n");
  if (lines.join("\n").length + tasks.length + 1 < 6500) lines.push(tasks);
  else lines.push("Task previews omitted; inspect authoritative tasks with t3_bot list_tasks.");
  const basis =
    view.basis === null
      ? "No active save basis; use read_continuation during the Home turn."
      : `Exact save basis: ${encodeJson(view.basis)}`;
  if (lines.join("\n").length + basis.length + 1 <= BOT_CONTINUATION_LIMITS.injectionChars)
    lines.push(basis);
  else
    lines.push(
      "Save basis omitted for size; use read_continuation for the exact basis and source references.",
    );
  return lines.join("\n");
}
