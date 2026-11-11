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
  BotContinuationReadInput,
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

/** The most recent direct inputs one save basis holds. */
const SOURCE_WINDOW = 200;
const PAGE_ITEMS = 40;
/**
 * Codex shows a code-mode model 10,000 approximate tokens of 4 bytes from a tool result and cuts
 * its middle beyond that. A refresh read's compact result stays below, so a page usually arrives
 * whole. How the model prints it can still cut it; part acks, not this budget, prove what it saw.
 */
const REFRESH_RESPONSE_BYTES = 32_000;
/** The most of a too-large item's first lines a page shows. */
const PREVIEW_BYTES = 2_000;
/** The most text before the next ack. Only a cut inside one part's text can spare every ack. */
const PART_BYTES = 1_000;
const ACK_CHARS = 8;
/** A refresh read only needs to recognise each reference; the stored quote stays whole. */
const REFRESH_QUOTE_CHARS = 100;
// Queued starts preserve run order but can insert a lower display ordinal than older steers.
const Position = Schema.Struct({ runOrdinal: NonNegativeInt, ordinal: NonNegativeInt });
type Position = typeof Position.Type;
/** Ids carry the frontier's own run, where a promoted queued input can land behind it. */
const Frontier = Schema.Struct({
  ...Position.fields,
  ids: Schema.Array(Schema.String).check(Schema.isMaxLength(SOURCE_WINDOW)),
});
type Frontier = typeof Frontier.Type;
const BasisPayload = Schema.Struct({
  homeThreadId: ThreadId,
  runId: RunId,
  fromOrdinal: Schema.NullOr(NonNegativeInt),
  throughOrdinal: Schema.NullOr(NonNegativeInt),
  digest: Schema.NullOr(Schema.String),
  throughRunOrdinal: Schema.NullOr(NonNegativeInt),
  throughInputOrdinal: Schema.NullOr(NonNegativeInt),
  /** The uncovered page this read returned, which a save from it may certify. */
  page: Schema.NullOr(
    Schema.Struct({
      from: Schema.NullOr(Frontier),
      through: Position,
      ids: Schema.Array(Schema.String),
      digest: Schema.String,
      /** Items too large for any read, with the UTF-8 length of the first lines it showed. */
      previews: Schema.Array(Schema.Struct({ id: Schema.String, bytes: NonNegativeInt })),
    }),
  ),
});
const StoredRevision = Schema.Struct({
  ...BotContinuationRevision.fields,
  sourcePosition: Schema.optional(Schema.NullOr(Position)),
  sourceIds: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(SOURCE_WINDOW))),
  // Every input and returned result through here was shown, in order, to a save that kept it.
  // Absent, nothing is proven and coverage rebuilds from the start of retained Home history.
  frontier: Schema.optional(Frontier),
});

/** Whether the note provably covers every direct Home input and every result returned to it. */
export type NoteCoverage =
  | { readonly _tag: "current" }
  | { readonly _tag: "behind"; readonly inputs: number; readonly results: number }
  | {
      readonly _tag: "unprovable";
      /** The note leaves no free item, or a refresh read no room, for even one item's reference. */
      readonly reason: "note_too_large";
      readonly inputs: number;
      readonly results: number;
    };
/** An uncovered item the Home has delivered, oldest first. */
interface Delivered {
  readonly ordinal: number;
  readonly runOrdinal: number;
  readonly result: boolean;
  readonly message: OrchestrationV2ConversationMessageJson;
}
/** An item as a page shows it: whole, or only its first `preview` bytes when too large. */
interface Shown extends Delivered {
  readonly text: string;
  readonly preview: number | null;
}
const utf8 = new TextEncoder();
const utf8Text = new TextDecoder();
/** The first `bytes` of `text`, which `leadingBytes` placed on a character boundary. */
const leading = (text: string, bytes: number) =>
  utf8Text.decode(utf8.encode(text).subarray(0, bytes));
/** The UTF-8 length of the whole lines in the first `cap` bytes, or else the whole characters. */
const leadingBytes = (encoded: Uint8Array, cap: number) => {
  let end = Math.min(cap, encoded.length);
  while (end > 0 && end < encoded.length && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  if (end === 0) return 0;
  const newline = encoded.lastIndexOf(10, end - 1);
  return newline === -1 ? end : newline + 1;
};
/** A shown text in parts of at most `PART_BYTES`, ending after whole lines where it can. */
const textParts = (text: string) => {
  const encoded = utf8.encode(text);
  const parts: string[] = [];
  for (let offset = 0; offset < encoded.length;) {
    const rest = encoded.subarray(offset);
    const length = rest.length <= PART_BYTES ? rest.length : leadingBytes(rest, PART_BYTES);
    parts.push(utf8Text.decode(rest.subarray(0, length)));
    offset += length;
  }
  return parts.length === 0 ? [""] : parts;
};
type Ack = (part: number, text: string) => string;
const sizingAck: Ack = () => "0".repeat(ACK_CHARS);
const pageEntry = (source: Shown, ack: Ack) => ({
  messageId: source.message.id,
  ordinal: source.ordinal,
  kind: source.result ? ("result" as const) : ("input" as const),
  directUser: source.message.createdBy === "user",
  ...(source.preview === null
    ? {}
    : {
        tooLarge: {
          bytes: utf8.encode(source.message.text).byteLength,
          createdAt: DateTime.formatIso(source.message.createdAt),
        },
      }),
  parts: textParts(source.text).map((text, part) => ({ text, ack: ack(part, text) })),
});
const jsonBytes = (value: unknown) => utf8.encode(encodeJson(value)).byteLength;
/**
 * The oldest uncovered items whose `{ continuation: view }` fits the refresh budget, with every
 * page-dependent field measured at its largest. An item too large even alone is shown by
 * reference with the first lines that fit, while the note has a free item to keep that reference.
 */
const planPage = (view: BotContinuationView, delivered: readonly Delivered[], total: number) => {
  const base = jsonBytes({
    continuation: {
      ...view,
      sources: [],
      moreSources: SOURCE_WINDOW,
      basis: {
        token: "0".repeat(32),
        fromOrdinal: Number.MAX_SAFE_INTEGER,
        throughOrdinal: Number.MAX_SAFE_INTEGER,
      },
      uncovered: { sources: [], remaining: total },
    },
  });
  const shown: Shown[] = [];
  let bytes = base;
  let freeItems =
    BOT_CONTINUATION_LIMITS.items -
    BOT_CONTINUATION_SECTIONS.reduce((items, section) => items + view.note[section].length, 0);
  const cost = (source: Shown) =>
    jsonBytes(pageEntry(source, sizingAck)) + (shown.length === 0 ? 0 : 1);
  for (const source of delivered) {
    const whole: Shown = { ...source, text: source.message.text, preview: null };
    const wholeBytes = cost(whole);
    if (bytes + wholeBytes <= REFRESH_RESPONSE_BYTES) {
      shown.push(whole);
      bytes += wholeBytes;
      continue;
    }
    // An item that fits a page of its own starts the next one.
    if (base + jsonBytes(pageEntry(whole, sizingAck)) <= REFRESH_RESPONSE_BYTES) break;
    if (freeItems === 0) break;
    freeItems -= 1;
    const encoded = utf8.encode(source.message.text);
    let reference: Shown | undefined;
    for (let cap = PREVIEW_BYTES; reference === undefined; cap = Math.floor(cap / 2)) {
      const preview = leadingBytes(encoded, cap);
      const candidate = { ...source, text: utf8Text.decode(encoded.subarray(0, preview)), preview };
      if (bytes + cost(candidate) <= REFRESH_RESPONSE_BYTES) reference = candidate;
      else if (cap === 0) break;
    }
    if (reference === undefined) break;
    bytes += cost(reference);
    shown.push(reference);
  }
  return shown;
};
const atOrBefore = (a: Position | null | undefined, b: Position | null | undefined) =>
  a == null ||
  (b != null &&
    (a.runOrdinal < b.runOrdinal || (a.runOrdinal === b.runOrdinal && a.ordinal <= b.ordinal)));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeRevision = Schema.encodeEffect(Schema.fromJsonString(StoredRevision));
const encodeBasis = Schema.encodeSync(Schema.fromJsonString(BasisPayload));
const decodeRevision = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRevision));
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
    readonly runOrdinal: number;
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
      sources.map(({ ordinal, runOrdinal, message }) => [
        runOrdinal,
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
  readonly run_ordinal: number;
  readonly payload_json: string;
}
type Caller = { readonly kind: "user" } | { readonly kind: "bot"; readonly threadId: ThreadId };

export class BotContinuation extends Context.Service<
  BotContinuation,
  {
    /**
     * With `page`, in a scoped note refresh, the view also shows the oldest uncovered page, and
     * its basis may certify it.
     */
    readonly get: (
      scope: BotContinuationReadInput,
      options?: { readonly page?: boolean },
    ) => Effect.Effect<BotContinuationView, BotError>;
    readonly history: (
      scope: BotContinuationScope,
    ) => Effect.Effect<{ readonly revisions: readonly BotContinuationRevision[] }, BotError>;
    readonly save: (
      input: BotSaveContinuationInput,
      caller: Caller,
    ) => Effect.Effect<BotSaveContinuationResult, BotError>;
    readonly coverage: (scope: BotContinuationScope) => Effect.Effect<NoteCoverage, BotError>;
  }
>()("t3/bots/BotContinuation") {}

const make = Effect.gen(function* () {
  const main = yield* SqlClient.SqlClient;
  const sql = yield* BotDatabase.BotDatabase;
  const store = yield* BotStore.BotStore;
  const random = yield* SecureRandom.SecureRandom;
  // Bases expire on process restart; committed retry identities remain in SQLite.
  const key = yield* random.randomBytes(32).pipe(Effect.orDie);
  const bases = new Map<string, typeof BasisPayload.Type>();
  const signature = (payload: string) =>
    NodeCrypto.createHmac("sha256", key).update(payload).digest("hex").slice(0, 32);
  /** Acks for one item's parts, bound to the page that shows them. */
  const acksFor =
    (page: { readonly from: Frontier | null; readonly digest: string }, messageId: string): Ack =>
    (part, text) =>
      signature(encodeJson(["ack", page.from, page.digest, messageId, part, hash(text)])).slice(
        0,
        ACK_CHARS,
      );
  const signed = (payload: typeof BasisPayload.Type): BotContinuationBasis => {
    const token = signature(encodeBasis(payload));
    bases.delete(token);
    bases.set(token, payload);
    if (bases.size > 512) {
      const oldest = bases.keys().next().value;
      if (oldest !== undefined) bases.delete(oldest);
    }
    return {
      token,
      fromOrdinal: payload.fromOrdinal,
      throughOrdinal: payload.throughOrdinal,
    };
  };
  const verified = Effect.fn("BotContinuation.verifyBasis")(function* (
    basis: BotContinuationBasis,
  ) {
    const payload = bases.get(basis.token);
    if (payload === undefined)
      return yield* invalid(
        "The save basis expired or is invalid. Read the current working notes again.",
      );
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
      readonly restriction: string | null;
    }>`SELECT run_id, ordinal, json_extract(payload_json, '$.restriction') AS restriction FROM orchestration_v2_projection_runs WHERE thread_id = ${home} AND status IN ('starting', 'running', 'waiting') ORDER BY ordinal DESC LIMIT 1`)[0];
  });
  const isResult = `(json_extract(m.payload_json, '$.notification') IS NOT NULL
    OR json_extract(m.payload_json, '$.delegatedCompletion') IS NOT NULL)`;
  const direct = `json_extract(m.payload_json, '$.senderThreadId') IS NULL
    AND json_extract(m.payload_json, '$.scheduledTaskId') IS NULL
    AND json_extract(m.payload_json, '$.context.guest') IS NULL
    AND ((json_extract(m.payload_json, '$.createdBy') = 'user' AND json_extract(m.payload_json, '$.creationSource') IN ('web', 'mobile'))
      OR (json_extract(m.payload_json, '$.createdBy') = 'agent' AND json_extract(m.payload_json, '$.creationSource') = 'mcp'))
    AND (lower(trim(json_extract(m.payload_json, '$.text'))) != '/compact' OR json_array_length(json_extract(m.payload_json, '$.attachments')) > 0)`;
  const live = `m.role = 'user'
    AND (r.status IS NULL OR r.status != 'rolled_back')
    AND NOT (COALESCE(r.status, '') = 'cancelled' AND (i.turn_item_id IS NULL OR COALESCE(json_extract(i.payload_json, '$.inputIntent'), '') = 'queued_turn'))`;
  const directClause = main.literal(`${live} AND NOT ${isResult} AND ${direct}`);
  /** Direct input and returned results: what the working note must reconcile. */
  const streamClause = main.literal(`${live} AND (${isResult} OR (${direct}))`);
  const resultColumn = main.literal(isResult);
  const pendingColumn = main.literal(
    `(i.turn_item_id IS NULL OR COALESCE(r.status, '') IN ('queued', 'preparing'))`,
  );
  const sourceWindow = Effect.fn("BotContinuation.sourceWindow")(function* (
    home: ThreadId,
    throughRun: number | null = null,
    throughInput: number | null = null,
  ) {
    const rows =
      yield* main<SourceRow>`SELECT i.ordinal, COALESCE(r.ordinal, 0) AS run_ordinal, m.payload_json
      FROM orchestration_v2_projection_turn_items i
      JOIN orchestration_v2_projection_messages m ON m.message_id = json_extract(i.payload_json, '$.messageId') AND m.thread_id = i.thread_id
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id
      WHERE i.thread_id = ${home} AND i.type = 'user_message' AND ${directClause}
        AND (${throughRun} IS NULL OR COALESCE(r.ordinal, 0) < ${throughRun}
          OR (COALESCE(r.ordinal, 0) = ${throughRun} AND i.ordinal <= ${throughInput}))
        AND (r.run_id IS NULL OR r.status NOT IN ('queued', 'preparing', 'rolled_back'))
      ORDER BY COALESCE(r.ordinal, 0) DESC, i.ordinal DESC LIMIT ${SOURCE_WINDOW}`;
    return yield* Effect.forEach(rows, (row) =>
      decodeMessage(row.payload_json).pipe(
        Effect.map((message) => ({ ordinal: row.ordinal, runOrdinal: row.run_ordinal, message })),
      ),
    );
  });
  /** Direct inputs after a revision's source boundary. */
  const inputsAfter = Effect.fn("BotContinuation.inputsAfter")(function* (
    home: ThreadId,
    revision: typeof StoredRevision.Type | null,
  ) {
    return (yield* main<{
      readonly count: number;
      readonly firstOrdinal: number | null;
      readonly lastOrdinal: number | null;
    }>`SELECT COUNT(DISTINCT m.message_id) AS count, MIN(i.ordinal) AS firstOrdinal, MAX(i.ordinal) AS lastOrdinal
      FROM orchestration_v2_projection_messages m
      LEFT JOIN orchestration_v2_projection_turn_items i ON i.thread_id = m.thread_id AND i.type = 'user_message' AND json_extract(i.payload_json, '$.messageId') = m.message_id
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = COALESCE(i.run_id, m.run_id)
      WHERE m.thread_id = ${home} AND ${directClause}
        AND (r.status IN ('queued', 'preparing')
          OR COALESCE(r.ordinal, 0) > ${revision?.sourcePosition?.runOrdinal ?? -1}
          OR (COALESCE(r.ordinal, 0) = ${revision?.sourcePosition?.runOrdinal ?? -1}
            AND (i.ordinal > ${revision?.sourcePosition?.ordinal ?? -1}
              OR (json_extract(i.payload_json, '$.inputIntent') = 'promoted_queued_to_steer'
                AND m.message_id NOT IN (SELECT value FROM json_each(${encodeJson(revision?.sourceIds ?? [])}))))))`)[0]!;
  });
  /**
   * The stream after a frontier, oldest first: up to a page of delivered items and the totals,
   * pending ones included. With `through`, only delivered items up to that position.
   */
  const uncovered = Effect.fn("BotContinuation.uncovered")(function* (
    home: ThreadId,
    frontier: Frontier | null | undefined,
    through?: Position,
  ) {
    const rows = yield* main<
      SourceRow & {
        readonly result: number;
        readonly pending: number;
        readonly total: number;
        readonly results: number;
      }
    >`SELECT i.ordinal, COALESCE(r.ordinal, 0) AS run_ordinal, m.payload_json,
        ${resultColumn} AS result, ${pendingColumn} AS pending,
        COUNT(*) OVER () AS total, SUM(${resultColumn}) OVER () AS results
      FROM orchestration_v2_projection_messages m
      LEFT JOIN orchestration_v2_projection_turn_items i ON i.thread_id = m.thread_id AND i.type = 'user_message' AND json_extract(i.payload_json, '$.messageId') = m.message_id
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = COALESCE(i.run_id, m.run_id)
      WHERE m.thread_id = ${home} AND ${streamClause}
        AND (${pendingColumn}
          OR (COALESCE(r.ordinal, 0), i.ordinal) > (${frontier?.runOrdinal ?? -1}, ${frontier?.ordinal ?? -1})
          OR (COALESCE(r.ordinal, 0) = ${frontier?.runOrdinal ?? -1}
            AND json_extract(i.payload_json, '$.inputIntent') = 'promoted_queued_to_steer'
            AND m.message_id NOT IN (SELECT value FROM json_each(${encodeJson(frontier?.ids ?? [])}))))
        AND (${through?.runOrdinal ?? null} IS NULL
          OR (NOT ${pendingColumn}
            AND (COALESCE(r.ordinal, 0), i.ordinal) <= (${through?.runOrdinal ?? 0}, ${through?.ordinal ?? 0})))
      ORDER BY pending, run_ordinal, i.ordinal LIMIT ${PAGE_ITEMS}`;
    const delivered: readonly Delivered[] = yield* Effect.forEach(
      rows.filter((row) => row.pending === 0),
      (row) =>
        decodeMessage(row.payload_json).pipe(
          Effect.map((message) => ({
            ordinal: row.ordinal,
            runOrdinal: row.run_ordinal,
            result: row.result === 1,
            message,
          })),
        ),
    );
    const total = rows[0]?.total ?? 0;
    const results = rows[0]?.results ?? 0;
    return { inputs: total - results, results, delivered };
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
        (isDirectHomeInput(source) ||
          source.notification !== undefined ||
          source.delegatedCompletion !== undefined) &&
        source.context?.guest === undefined &&
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
  /**
   * The view without its basis. A refresh read, the one a scoped note refresh sees, leaves out
   * the newest-input previews and clips reference quotes to make room for its page.
   */
  const read = Effect.fn("BotContinuation.read")(function* (
    scope: BotContinuationReadInput,
    page: "never" | "botNote" | "always",
  ) {
    const { context, bot, home } = yield* scopeOf(scope);
    const row = yield* currentRow(home);
    const revision = row === undefined ? null : yield* decodeRevision(row.revision_json);
    const run = yield* activeRun(home);
    const supplied =
      run === undefined ? [] : yield* sourceWindow(home, run.ordinal, Number.MAX_SAFE_INTEGER);
    // Only the scoped refresh certifies; ordinary turns already hold the day's input natively.
    const refresh = page === "always" || (page === "botNote" && run?.restriction === "botNote");
    const note = yield* resolveNote(home, revision?.note ?? emptyNote());
    const gap = yield* inputsAfter(home, revision);
    const after =
      scope.afterTaskId === undefined
        ? undefined
        : (yield* sql<{
            readonly created_at: string;
            readonly task_id: string;
          }>`SELECT created_at, task_id FROM bot_tasks WHERE home_thread_id = ${home} AND task_id = ${scope.afterTaskId}`)[0];
    if (scope.afterTaskId !== undefined && after === undefined)
      return yield* invalid("The active-work page must follow a task from this Home.");
    const tasks = yield* sql<{
      readonly task_id: string;
      readonly title: string;
      readonly status: BotTaskStatus;
      readonly work_thread_id: string | null;
      readonly total: number;
    }>`SELECT task_id, title, status, work_thread_id, COUNT(*) OVER() AS total FROM bot_tasks WHERE home_thread_id = ${home} AND status IN ('accepted','running','waiting') AND cancel_requested_at IS NULL
      AND (${after?.task_id ?? null} IS NULL OR created_at > ${after?.created_at ?? ""} OR (created_at = ${after?.created_at ?? ""} AND task_id > ${after?.task_id ?? ""}))
      ORDER BY created_at, task_id LIMIT 8`;
    const shown = refresh ? [] : supplied.slice(0, 8);
    const clip = (items: BotContinuationNote["requests"]) =>
      items.map((item) => ({
        ...item,
        refs: item.refs.map((ref) =>
          ref.kind === "message" ? { ...ref, quote: ref.quote.slice(0, REFRESH_QUOTE_CHARS) } : ref,
        ),
      }));
    const view = {
      ...scope,
      homeThreadId: home,
      revision: revision?.revision ?? null,
      note: refresh
        ? {
            requests: clip(note.requests),
            waiting: clip(note.waiting),
            decided: clip(note.decided),
            context: clip(note.context),
          }
        : note,
      updatedBy: revision?.updatedBy ?? null,
      updatedAt: revision?.updatedAt ?? null,
      restoredFrom: revision?.restoredFrom ?? null,
      coverage: revision?.coverage ?? null,
      basis: null,
      writable: bot.archived_at === null && context.detached_at === null,
      newerInputs: gap,
      sources: shown.map(({ ordinal, message }) => ({
        messageId: message.id,
        ordinal,
        text: message.text.slice(0, 400),
        directUser: message.createdBy === "user",
      })),
      moreSources: supplied.length - shown.length,
      activeTasks: tasks.map((task) => ({
        taskId: BotTaskId.make(task.task_id),
        title: task.title.slice(0, 160),
        status: task.status,
        workThreadId: task.work_thread_id === null ? null : ThreadId.make(task.work_thread_id),
      })),
      moreActiveTasks: Math.max(0, (tasks[0]?.total ?? 0) - tasks.length),
      nextActiveTaskId:
        (tasks[0]?.total ?? 0) > tasks.length ? BotTaskId.make(tasks.at(-1)!.task_id) : null,
    } satisfies BotContinuationView;
    return { home, revision, run, supplied, refresh, view };
  });
  const get = Effect.fn("BotContinuation.get")(function* (
    scope: BotContinuationReadInput,
    options?: { readonly page?: boolean },
  ) {
    const { home, revision, run, supplied, refresh, view } = yield* read(
      scope,
      options?.page === true ? "botNote" : "never",
    );
    if (run === undefined) return view;
    const newest = supplied[0];
    const unsigned = {
      homeThreadId: home,
      runId: RunId.make(run.run_id),
      fromOrdinal:
        supplied.length === 0 ? null : Math.min(...supplied.map((source) => source.ordinal)),
      throughOrdinal:
        supplied.length === 0 ? null : Math.max(...supplied.map((source) => source.ordinal)),
      digest: sourceDigest(supplied),
      throughRunOrdinal: newest?.runOrdinal ?? null,
      throughInputOrdinal: newest?.ordinal ?? null,
    };
    if (!refresh) return { ...view, basis: signed({ ...unsigned, page: null }) };
    const { inputs, results, delivered } = yield* uncovered(home, revision?.frontier);
    const shown = planPage(view, delivered, inputs + results);
    const last = shown.at(-1);
    const page =
      last === undefined
        ? null
        : {
            from: revision?.frontier ?? null,
            through: { runOrdinal: last.runOrdinal, ordinal: last.ordinal },
            ids: shown.map((source) => source.message.id),
            digest: sourceDigest(shown),
            previews: shown.flatMap((source) =>
              source.preview === null ? [] : [{ id: source.message.id, bytes: source.preview }],
            ),
          };
    return {
      ...view,
      basis: signed({ ...unsigned, page }),
      uncovered: {
        sources:
          page === null
            ? []
            : shown.map((source) => pageEntry(source, acksFor(page, source.message.id))),
        remaining: inputs + results - shown.length,
      },
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
            resolveNote(home, revision.note).pipe(
              Effect.map((note) => {
                const {
                  sourcePosition: _position,
                  sourceIds: _ids,
                  frontier: _frontier,
                  ...publicRevision
                } = revision;
                return { ...publicRevision, note };
              }),
            ),
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
        acks: input.acks ?? [],
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
    let sourcePosition = previous?.sourcePosition ?? null;
    let sourceIds = previous?.sourceIds ?? [];
    let frontier = previous?.frontier;
    let writer: BotContinuationRevision["updatedBy"] = { kind: "user" };
    let basis: typeof BasisPayload.Type | null = null;
    let runRestriction: string | null = null;
    let note = emptyNote();
    // What the saving run was shown, newest first: its page, then the newest direct inputs.
    let evidence: readonly Omit<Shown, "preview">[] = [];
    let tooLarge: readonly string[] = [];
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
      runRestriction = run.restriction;
      const scopedSources = yield* sourceWindow(
        home,
        basis.throughRunOrdinal ?? -1,
        basis.throughInputOrdinal ?? -1,
      );
      if (sourceDigest(scopedSources) !== basis.digest)
        return { _tag: "conflict", reason: "basis", current: yield* get(input) } as const;
      coverage = { fromOrdinal: basis.fromOrdinal, throughOrdinal: basis.throughOrdinal };
      sourcePosition =
        basis.throughRunOrdinal === null || basis.throughInputOrdinal === null
          ? null
          : { runOrdinal: basis.throughRunOrdinal, ordinal: basis.throughInputOrdinal };
      sourceIds = scopedSources.map((source) => source.message.id);
      writer = { kind: "bot", threadId: home, runId: basis.runId };
      const page = basis.page;
      let certified: readonly Omit<Shown, "preview">[] = [];
      if (page !== null) {
        const { delivered } = yield* uncovered(home, page.from, page.through);
        if (
          sourceDigest(delivered) !== page.digest ||
          encodeJson(delivered.map((source) => source.message.id)) !== encodeJson(page.ids)
        )
          return { _tag: "conflict", reason: "basis", current: yield* get(input) } as const;
        const previews = new Map(page.previews.map((preview) => [preview.id, preview.bytes]));
        const shown = delivered.map((source) => {
          const preview = previews.get(source.message.id);
          return {
            ...source,
            text:
              preview === undefined ? source.message.text : leading(source.message.text, preview),
          };
        });
        // The page counts as read up to its first item with a part the run did not acknowledge.
        const acked = new Set(input.acks ?? []);
        const unread = shown.findIndex((source) => {
          const ack = acksFor(page, source.message.id);
          return textParts(source.text).some((text, part) => !acked.has(ack(part, text)));
        });
        certified = unread === -1 ? shown : shown.slice(0, unread);
        tooLarge = certified.flatMap((source) =>
          previews.has(source.message.id) ? [source.message.id] : [],
        );
        const last = certified.at(-1);
        if (last !== undefined && atOrBefore(page.from, frontier)) {
          const through = { runOrdinal: last.runOrdinal, ordinal: last.ordinal };
          const reached =
            frontier !== undefined && atOrBefore(through, frontier) ? frontier : through;
          const ids = new Set(frontier?.runOrdinal === reached.runOrdinal ? frontier.ids : []);
          for (const source of certified)
            if (source.runOrdinal === reached.runOrdinal) ids.add(source.message.id);
          frontier = {
            runOrdinal: reached.runOrdinal,
            ordinal: reached.ordinal,
            ids: [...ids].slice(-SOURCE_WINDOW),
          };
        }
      }
      evidence = [
        ...certified.toReversed(),
        ...scopedSources.map((source) => ({ ...source, result: false, text: source.message.text })),
      ];
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
      sourcePosition = revision.sourcePosition ?? null;
      sourceIds = revision.sourceIds ?? [];
      frontier = revision.frontier;
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
                : evidence.find(
                    ({ text, result, message }) =>
                      text.includes(item.quote!) &&
                      (section !== "decided" ||
                        (!result &&
                          message.createdBy === "user" &&
                          (message.creationSource === "web" ||
                            message.creationSource === "mobile"))),
                  );
            if (section === "decided" && carried === undefined && quoted === undefined)
              return yield* invalid(
                "A new Bot decision needs an exact quote from direct user input; a proposal is not approval.",
              );
            const named = evidence.find(
              ({ message }) => tooLarge.includes(message.id) && item.text.includes(message.id),
            );
            const source = quoted ?? (carried === undefined ? (named ?? evidence[0]) : undefined);
            refs =
              source === undefined
                ? (carried?.refs ?? [])
                : [
                    {
                      kind: "message",
                      messageId: source.message.id,
                      ordinal: source.ordinal,
                      digest: hash(source.message.text),
                      quote: item.quote ?? source.text.slice(0, 400),
                      directUser: source.message.createdBy === "user",
                      availability: "available",
                    },
                  ];
            if (item.quote !== undefined && quoted === undefined)
              return yield* invalid(
                "The quote was not found in the supplied source window. Read the Home history and reconcile it first.",
              );
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
          if (refs.length === 0)
            return yield* invalid("New Bot note items need a source in the supplied Home basis.");
          items.push({ text: item.text, refs });
        }
        note = { ...note, [section]: items };
      }
      // An unread input is kept as a reference to open later, never passed over silently.
      const unlisted = tooLarge.filter(
        (id) =>
          !BOT_CONTINUATION_SECTIONS.some((section) =>
            note[section].some((item) =>
              item.refs.some((ref) => ref.kind === "message" && ref.messageId === id),
            ),
          ),
      );
      if (unlisted.length > 0)
        return yield* invalid(
          `Keep each tooLarge item in the note: add a waiting item naming its messageId as an unreviewed large input (${unlisted.join(", ")}).`,
        );
    }
    if (retry === undefined) note = yield* decodeNote(note);
    // A Waiting-only run keeps every carried item exactly, refs included, and only appends Waiting.
    if (retry === undefined && runRestriction === "botWaiting") {
      const before = previous?.note ?? emptyNote();
      const unchanged = BOT_CONTINUATION_SECTIONS.every((section) =>
        section === "waiting"
          ? encodeJson(note.waiting.slice(0, before.waiting.length)) === encodeJson(before.waiting)
          : encodeJson(note[section]) === encodeJson(before[section]),
      );
      if (!unchanged)
        return yield* invalid(
          "This maintenance turn may only append Waiting items; every other item must stay exactly as it is.",
        );
      const added = input.note.waiting.slice(before.waiting.length);
      // Without a quote the item would be attributed to the user's newest message.
      if (added.some((item) => item.quote === undefined && (item.taskIds ?? []).length === 0))
        return yield* invalid(
          "Each new Waiting item needs a quote from the user's message or the id of the task it is about.",
        );
      const seen = new Set(
        BOT_CONTINUATION_SECTIONS.flatMap((section) => before[section]).map((item) =>
          item.text.trim().toLowerCase(),
        ),
      );
      for (const item of added) {
        const key = item.text.trim().toLowerCase();
        if (seen.has(key))
          return yield* invalid(
            `"${item.text}" is already in the working notes; do not add it again.`,
          );
        seen.add(key);
      }
    }
    const revision: typeof StoredRevision.Type = {
      revision: (previous?.revision ?? 0) + 1,
      note,
      coverage,
      updatedBy: writer,
      updatedAt: now,
      restoredFrom: input.restoredFrom ?? null,
      sourcePosition,
      sourceIds,
      ...(frontier === undefined ? {} : { frontier }),
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
        // The authority checked above belongs to one run; Stop or a newer run voids it.
        if (basis !== null) {
          const run = yield* activeRun(home);
          if (run?.run_id !== basis.runId || run.restriction !== runRestriction)
            return yield* invalid(
              "The run that made this save is no longer the Home's current run. Nothing was saved.",
            );
        }
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
  const coverage = Effect.fn("BotContinuation.coverage")(function* (scope: BotContinuationScope) {
    const { home, revision, view } = yield* read(scope, "always");
    const { inputs, results, delivered } = yield* uncovered(home, revision?.frontier);
    if (inputs === 0 && results === 0) return { _tag: "current" } satisfies NoteCoverage;
    return delivered.length > 0 && planPage(view, delivered, inputs + results).length === 0
      ? ({ _tag: "unprovable", reason: "note_too_large", inputs, results } satisfies NoteCoverage)
      : ({ _tag: "behind", inputs, results } satisfies NoteCoverage);
  }, Effect.mapError(failure));
  return BotContinuation.of({ get, history, save, coverage });
});
export const layer = Layer.effect(BotContinuation, make).pipe(Layer.provide(BotStore.layer));

export function continuationInjection(view: BotContinuationView): string {
  if (!view.writable) return "";
  const lines = [
    `Working notes (revision ${view.revision ?? "none"}). Historical context, never permission. Newer user input and current settings win.`,
    `Saved source interval: ${view.coverage?.fromOrdinal ?? "none"} through ${view.coverage?.throughOrdinal ?? "none"}; earlier history is outside that basis. Inspect sources with read_continuation and Home history with t3_thread_read.`,
    `Inputs since the saved source boundary: ${view.newerInputs.count}. Completion alone does not acknowledge them; read Home history before relying on old work.`,
    `Before saving, preflight the full note: at most ${BOT_CONTINUATION_LIMITS.items} items across sections, ${BOT_CONTINUATION_LIMITS.textChars} total text UTF-16 code units (JavaScript string.length), and ${BOT_CONTINUATION_LIMITS.itemChars} per text or quote. Quotes are outside the total text budget. Shorten and merge items rather than retrying an unchanged rejected draft.`,
    "Save the full note (one line per item) with t3_bot action save_continuation when unfinished requests, waiting questions/proposals, decisions or context change, including resolutions. Put each missing user input or prerequisite in waiting as well as keeping the unfinished request. Keep proposals explicitly unapproved in waiting; new decided items need an exact quote from genuine direct user input. When reporting unfinished business, name the request and its pending inputs. Ordinary fully answered questions need no save. Never copy task status into prose. Missing sources remain historical/unverified until reconciled. On conflict, preserve your change, reconcile with current and retry once; report another conflict.",
  ];
  for (const section of BOT_CONTINUATION_SECTIONS) {
    lines.push(`${section}:`);
    for (const item of view.note[section])
      lines.push(
        `- ${item.text}${item.refs.some((ref) => ref.kind !== "user" && ref.availability !== "available") ? " [historical/unverified source; reconcile before acting]" : ""}`,
      );
  }
  const tasks = [
    "Active Bot tasks only, not Home's delegated/background work. Inspect Home activity with t3_thread_read for owned delegate references and await their completion without polling. Completed runs do not prove request fulfillment:",
    ...view.activeTasks.map((task) => `- ${task.taskId}: ${task.status} · ${task.title}`),
    `${view.moreActiveTasks} further active tasks; use t3_bot read_continuation and pass nextActiveTaskId as afterTaskId to read further pages.`,
  ].join("\n");
  if (lines.join("\n").length + tasks.length + 1 < 6500) lines.push(tasks);
  else
    lines.push(
      "Bot-task previews omitted; use t3_bot read_continuation and follow nextActiveTaskId with afterTaskId. This excludes Home's delegated/background work; inspect Home activity with t3_thread_read for owned delegate references and await completion without polling.",
    );
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
