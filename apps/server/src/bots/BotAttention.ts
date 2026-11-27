import {
  BOT_ALERT_DEFAULT_DAILY_LIMIT,
  BOT_ALERT_DEFAULT_QUIET_HOURS,
  type BotAttentionView,
  type BotConfigureAttentionInput,
  type BotConfigureAttentionResult,
  BotError,
  type BotId,
  type BotQuietHours,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";

interface SettingsRow {
  readonly revision: number;
  readonly daily_limit: number;
  readonly quiet_start: string | null;
  readonly quiet_end: string | null;
  readonly remit: string;
}

interface Settings {
  readonly revision: number;
  readonly dailyLimit: number;
  readonly quietHours: BotQuietHours | null;
  readonly remit: string;
}

const DEFAULTS: Settings = {
  revision: 0,
  dailyLimit: BOT_ALERT_DEFAULT_DAILY_LIMIT,
  quietHours: BOT_ALERT_DEFAULT_QUIET_HOURS,
  remit: "",
};

/** A proactive Bot result that would alert: one run of one task. */
export interface BotAlert {
  readonly botId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly workThreadId: string;
  readonly homeThreadId: string;
  readonly phase: "completed" | "failed";
  readonly endedAt: DateTime.DateTime | null;
  /** A result that waits for the user: held and sent with the others that come in shortly. */
  readonly gather?: boolean;
}

export interface BotAlertCounts {
  readonly sentToday: number;
  readonly held: number;
}

/** One Bot's held alerts, claimed as a single push. */
export interface BotAlertDigest {
  readonly botId: string;
  readonly botName: string;
  /** The newest held alert's Home and project; the digest opens that Home. */
  readonly homeThreadId: ThreadId;
  readonly projectId: string | null;
  readonly held: number;
  readonly allFailed: boolean;
  /** Held alerts in it that were gathered because their results wait for the user. */
  readonly needYou: number;
  /** When it was claimed: its relay identity and alert time, the same on every retry. */
  readonly digestAt: string;
}

/**
 * The view plus what decides a new alert now, for the Bot's read-only MCP view. `digestAt` carries
 * the local offset.
 */
export interface BotAttentionStatus extends BotAttentionView {
  /** The zone quiet hours and the day's limit are counted in. */
  readonly timeZone: string;
  readonly quietNow: boolean;
  readonly limitReached: boolean;
}

export class BotAttention extends Context.Service<
  BotAttention,
  {
    readonly get: (botId: BotId) => Effect.Effect<BotAttentionView, BotError>;
    readonly status: (botId: BotId) => Effect.Effect<BotAttentionStatus, BotError>;
    readonly configure: (
      input: BotConfigureAttentionInput,
    ) => Effect.Effect<BotConfigureAttentionResult, BotError>;
    /**
     * The one admission for proactive Bot alerts: decides once per task run whether it goes out
     * now or waits for the digest, and records it, so repeats and restarts get the same answer.
     */
    readonly admit: (alert: BotAlert) => Effect.Effect<"send" | "hold", BotError>;
    readonly hasHeldAlerts: Effect.Effect<boolean, BotError>;
    /**
     * Claims each Bot's held alerts whose release time has passed, outside its quiet hours, as one
     * digest; an unsent claim comes back as it was until it is too old to alert.
     */
    readonly claimDigests: Effect.Effect<ReadonlyArray<BotAlertDigest>, BotError>;
    /** Unsent, young enough for the relay to ring, and outside the Bot's quiet hours now. */
    readonly canSendDigest: (digest: BotAlertDigest) => Effect.Effect<boolean, BotError>;
    readonly markDigestSent: (digest: BotAlertDigest) => Effect.Effect<void, BotError>;
    /** Each Bot's alerts sent today and held; a Bot without any is absent. */
    readonly counts: Effect.Effect<ReadonlyMap<string, BotAlertCounts>, BotError>;
    /** Signals each new decision and each digest sent, the moments the counts move. */
    readonly changes: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  }
>()("t3/bots/BotAttention") {}

/**
 * How long a sent or digested decision is kept. Counts read only today's, which a time-zone change
 * moves by a day at most; a repeated publish of a run this old is not decided anew (see `admit`).
 */
const DECISION_RETENTION_DAYS = 7;

/** How long the first result waiting for the user waits for others, to go out as one alert. */
const GATHER_MINUTES = 5;

/** The relay rings for a completion at most this old; an older unsent claim gets a new identity. */
const DIGEST_RECLAIM_MS = 2 * 60_000;
const isFresh = (digestAt: string, now: DateTime.DateTime) =>
  DateTime.toEpochMillis(now) - Date.parse(digestAt) < DIGEST_RECLAIM_MS;

const isBotError = Schema.is(BotError);
const failure = (cause: unknown) =>
  isBotError(cause)
    ? cause
    : new BotError({ message: "Could not read or change the Bot's alerts.", cause });

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Whether a local time falls in quiet hours; a span whose end is earlier crosses midnight. */
function inQuietHours(now: DateTime.Zoned, quiet: BotQuietHours | null): boolean {
  if (quiet === null) return false;
  const parts = DateTime.toParts(now);
  const minute = parts.hour * 60 + parts.minute;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** When an alert held at `heldAt` may go out: as quiet hours end, or as the next local day starts. */
function digestDueAt(heldAt: DateTime.Zoned, quiet: BotQuietHours | null): DateTime.DateTime {
  return (
    nextScheduledRunAt({ type: "fixed_time", timeOfDay: quiet?.end ?? "00:00" }, heldAt) ?? heldAt
  );
}

const settingsOf = (row: SettingsRow | undefined): Settings =>
  row === undefined
    ? DEFAULTS
    : {
        revision: row.revision,
        dailyLimit: row.daily_limit,
        quietHours:
          row.quiet_start === null || row.quiet_end === null
            ? null
            : { start: row.quiet_start, end: row.quiet_end },
        remit: row.remit,
      };

export const make = Effect.gen(function* () {
  const sql = yield* BotDatabase.BotDatabase;
  const zone = yield* DateTime.CurrentTimeZone;
  const localNow = DateTime.now.pipe(Effect.map((now) => DateTime.setZone(now, zone)));
  const local = (iso: string) => DateTime.setZone(DateTime.makeUnsafe(iso), zone);
  // Readers re-read the counts, so only the newest signal matters.
  const changed = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changed, undefined).pipe(Effect.asVoid);

  /**
   * When a held alert may go out: its gathering's end while today's limit has room for that one
   * alert, or else the digest's time.
   */
  const releaseAt = (
    row: { readonly decided_at: string; readonly release_at: string | null },
    quiet: BotQuietHours | null,
    roomToday: boolean,
  ): DateTime.DateTime => {
    const digest = digestDueAt(local(row.decided_at), quiet);
    if (row.release_at === null) return digest;
    const gathered = DateTime.makeUnsafe(row.release_at);
    // Never before its gathering ends, also when it falls back to the digest.
    return roomToday ? gathered : DateTime.max(gathered, digest);
  };

  const sentOn = (botId: string, day: string) =>
    sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM bot_alerts
      WHERE bot_id = ${botId} AND day = ${day} AND held = 0`.pipe(
      Effect.map((rows) => rows[0]?.count ?? 0),
    );

  const settings = (botId: string) =>
    sql<SettingsRow>`SELECT revision, daily_limit, quiet_start, quiet_end, remit
      FROM bot_attention WHERE bot_id = ${botId}`.pipe(Effect.map((rows) => settingsOf(rows[0])));

  const get = Effect.fn("BotAttention.get")(function* (botId: BotId) {
    const [bot] = yield* sql<{
      readonly archived_at: string | null;
    }>`SELECT archived_at FROM bots WHERE bot_id = ${botId}`;
    if (bot === undefined) return yield* new BotError({ message: "Bot not found.", botId });
    const current = yield* settings(botId);
    const now = yield* localNow;
    const today = DateTime.formatIsoDate(now);
    const sent = yield* sentOn(botId, today);
    const held = yield* sql<{
      readonly decided_at: string;
      readonly release_at: string | null;
      readonly day: string;
      readonly digest_at: string | null;
    }>`SELECT decided_at, release_at, day, digest_at FROM bot_alerts
      WHERE bot_id = ${botId} AND held = 1 AND digest_sent_at IS NULL`;
    // A claimed digest goes out at its claim, also while the relay retries it.
    const releases = held.map((row) =>
      row.digest_at !== null
        ? DateTime.makeUnsafe(row.digest_at)
        : releaseAt(row, current.quietHours, row.day === today && sent < current.dailyLimit),
    );
    return {
      botId,
      revision: current.revision,
      dailyLimit: current.dailyLimit,
      quietHours: current.quietHours,
      remit: current.remit,
      writable: bot.archived_at === null,
      sentToday: sent,
      held: held.length,
      digestAt:
        releases.length === 0
          ? null
          : DateTime.formatIso(releases.reduce((earliest, at) => DateTime.min(earliest, at))),
    } satisfies BotAttentionView;
  }, Effect.mapError(failure));

  const status = Effect.fn("BotAttention.status")(function* (botId: BotId) {
    const view = yield* get(botId);
    return {
      ...view,
      // With the local offset: models read a UTC time as the quiet hours' local time.
      digestAt: view.digestAt === null ? null : DateTime.formatIsoOffset(local(view.digestAt)),
      timeZone: DateTime.zoneToString(zone),
      quietNow: inQuietHours(yield* localNow, view.quietHours),
      limitReached: view.sentToday >= view.dailyLimit,
    } satisfies BotAttentionStatus;
  });

  const configure = Effect.fn("BotAttention.configure")(function* (
    input: BotConfigureAttentionInput,
  ) {
    const view = yield* get(input.botId);
    if (view.revision !== input.baseRevision) return { _tag: "conflict", current: view } as const;
    if (!view.writable)
      return yield* new BotError({
        message: "This Bot is archived. Restore it to change its alerts.",
        botId: input.botId,
      });
    const now = DateTime.formatIso(yield* DateTime.now);
    const remit = input.remit.trim();
    const committed = yield* sql.withTransaction(
      Effect.gen(function* () {
        const latest = yield* settings(input.botId);
        if (latest.revision !== input.baseRevision) return false;
        yield* sql`INSERT INTO bot_attention (bot_id, revision, daily_limit, quiet_start, quiet_end, remit, updated_at)
          VALUES (${input.botId}, 1, ${input.dailyLimit}, ${input.quietHours?.start ?? null},
            ${input.quietHours?.end ?? null}, ${remit}, ${now})
          ON CONFLICT (bot_id) DO UPDATE SET revision = revision + 1, daily_limit = excluded.daily_limit,
            quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, remit = excluded.remit,
            updated_at = excluded.updated_at`;
        return true;
      }),
    );
    if (!committed) return { _tag: "conflict", current: yield* get(input.botId) } as const;
    return { _tag: "saved", view: yield* get(input.botId) } as const;
  }, Effect.mapError(failure));

  const admit = Effect.fn("BotAttention.admit")(function* (alert: BotAlert) {
    const key = `${alert.taskId}:${alert.runId}`;
    const { decision, recorded } = yield* sql.withTransaction(
      Effect.gen(function* () {
        const [decided] = yield* sql<{
          readonly held: number;
        }>`SELECT held FROM bot_alerts WHERE alert_key = ${key}`;
        if (decided !== undefined)
          return { decision: decided.held === 1 ? "hold" : "send", recorded: false } as const;
        const now = yield* localNow;
        const retained = DateTime.subtract(now, { days: DECISION_RETENTION_DAYS });
        // Its decision may be pruned. The relay no longer rings for a run this old, and deciding
        // again would count it today or hold it for another digest.
        if (alert.endedAt !== null && DateTime.isLessThan(alert.endedAt, retained))
          return { decision: "send", recorded: false } as const;
        const current = yield* settings(alert.botId);
        const day = DateTime.formatIsoDate(now);
        const [sent] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM bot_alerts WHERE bot_id = ${alert.botId} AND day = ${day} AND held = 0`;
        const budgetHolds =
          inQuietHours(now, current.quietHours) || (sent?.count ?? 0) >= current.dailyLimit;
        const gathers = !budgetHolds && alert.gather === true;
        const held = budgetHolds || gathers;
        // Results waiting for the user join the gathering already open, which goes out as one alert.
        const [open] = gathers
          ? yield* sql<{ readonly release_at: string }>`SELECT release_at FROM bot_alerts
              WHERE bot_id = ${alert.botId} AND held = 1 AND digest_at IS NULL
                AND release_at > ${DateTime.formatIso(now)} ORDER BY release_at LIMIT 1`
          : [];
        const releaseAt = gathers
          ? (open?.release_at ?? DateTime.formatIso(DateTime.add(now, { minutes: GATHER_MINUTES })))
          : null;
        yield* sql`INSERT INTO bot_alerts (alert_key, bot_id, task_id, work_thread_id, home_thread_id, phase, day, decided_at, held, release_at)
          VALUES (${key}, ${alert.botId}, ${alert.taskId}, ${alert.workThreadId}, ${alert.homeThreadId},
            ${alert.phase}, ${day}, ${DateTime.formatIso(now)}, ${held ? 1 : 0}, ${releaseAt})`;
        // A held alert stays until its digest went out.
        yield* sql`DELETE FROM bot_alerts WHERE bot_id = ${alert.botId}
          AND day < ${DateTime.formatIsoDate(retained)} AND (held = 0 OR digest_sent_at IS NOT NULL)`;
        return { decision: held ? "hold" : "send", recorded: true } as const;
      }),
    );
    if (recorded) yield* notifyChanged;
    return decision;
  }, Effect.mapError(failure));

  /** Polled by the scheduler tick, so it opens no span. */
  const hasHeldAlerts =
    sql`SELECT 1 FROM bot_alerts WHERE held = 1 AND digest_sent_at IS NULL LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(failure),
    );

  // One transaction, so the budget a claim reads is the budget it takes from.
  const claimDigests = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly alert_key: string;
      readonly bot_id: string;
      readonly name: string;
      readonly home_thread_id: string;
      readonly project_id: string | null;
      readonly phase: string;
      readonly decided_at: string;
      readonly release_at: string | null;
      readonly day: string;
      readonly digest_at: string | null;
    }>`SELECT a.alert_key, a.bot_id, b.name, a.home_thread_id, c.project_id, a.phase, a.decided_at,
        a.release_at, a.day, a.digest_at
      FROM bot_alerts a JOIN bots b ON b.bot_id = a.bot_id
      LEFT JOIN bot_project_contexts c ON c.home_thread_id = a.home_thread_id
      WHERE a.held = 1 AND a.digest_sent_at IS NULL ORDER BY a.decided_at, a.alert_key`;
    if (rows.length === 0) return [];
    const now = yield* localNow;
    const nowIso = DateTime.formatIso(now);
    const digests: Array<BotAlertDigest> = [];
    for (const botId of new Set(rows.map((row) => row.bot_id))) {
      const { quietHours, dailyLimit } = yield* settings(botId);
      if (inQuietHours(now, quietHours)) continue;
      const today = DateTime.formatIsoDate(now);
      const roomToday = (yield* sentOn(botId, today)) < dailyLimit;
      // A gathering counts against its own day; one left from an earlier day joins the digest.
      const gathersToday = (row: (typeof rows)[number]) =>
        row.release_at !== null && row.day === today && roomToday;
      const held = rows.filter((row) => row.bot_id === botId);
      const claimed = held.find((row) => row.digest_at !== null)?.digest_at ?? null;
      let digestAt = claimed;
      let batch = held.filter((row) => row.digest_at === claimed);
      if (claimed === null || !isFresh(claimed, now)) {
        // Each alert waits for its own release, so one held a moment ago waits for the next.
        batch = held.filter(
          (row) =>
            row.digest_at !== null ||
            !DateTime.isGreaterThan(releaseAt(row, quietHours, gathersToday(row)), now),
        );
        if (batch.length === 0) continue;
        digestAt = nowIso;
        yield* sql`UPDATE bot_alerts SET digest_at = ${digestAt}
          WHERE alert_key IN ${sql.in(batch.map((row) => row.alert_key))}`;
        // Gathered results go out as one alert instead of their own, so the claim takes one of
        // today's alerts before any other can. Keyed to the gathering, so a renewed claim reuses it.
        const gathering = batch.find(gathersToday);
        if (gathering !== undefined)
          yield* sql`INSERT OR IGNORE INTO bot_alerts (alert_key, bot_id, task_id, work_thread_id, home_thread_id, phase, day, decided_at, held)
            VALUES (${`digest:${gathering.alert_key}`}, ${botId}, '', '', ${gathering.home_thread_id},
              'completed', ${today}, ${nowIso}, 0)`;
      }
      const newest = batch.at(-1)!;
      digests.push({
        botId,
        botName: newest.name,
        homeThreadId: ThreadId.make(newest.home_thread_id),
        projectId: newest.project_id,
        held: batch.length,
        allFailed: batch.every((row) => row.phase === "failed"),
        needYou: batch.filter((row) => row.release_at !== null).length,
        digestAt: digestAt!,
      });
    }
    return digests;
  }).pipe(sql.withTransaction, Effect.mapError(failure));

  const canSendDigest = Effect.fn("BotAttention.canSendDigest")(function* (digest: BotAlertDigest) {
    const now = yield* localNow;
    // Margin for the request itself, so the relay still sees the claim as fresh when it lands.
    if (DateTime.toEpochMillis(now) - Date.parse(digest.digestAt) >= DIGEST_RECLAIM_MS - 30_000)
      return false;
    if (inQuietHours(now, (yield* settings(digest.botId)).quietHours)) return false;
    const rows = yield* sql`SELECT 1 FROM bot_alerts WHERE bot_id = ${digest.botId}
        AND digest_at = ${digest.digestAt} AND digest_sent_at IS NULL LIMIT 1`;
    return rows.length > 0;
  }, Effect.mapError(failure));

  const markDigestSent = Effect.fn("BotAttention.markDigestSent")(function* (
    digest: BotAlertDigest,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`UPDATE bot_alerts SET digest_sent_at = ${now}
      WHERE bot_id = ${digest.botId} AND digest_at = ${digest.digestAt} AND digest_sent_at IS NULL`;
    yield* notifyChanged;
  }, Effect.mapError(failure));

  const counts = Effect.gen(function* () {
    const today = DateTime.formatIsoDate(yield* localNow);
    const rows = yield* sql<{
      readonly bot_id: string;
      readonly sent_today: number;
      readonly held: number;
    }>`SELECT bot_id, SUM(held = 0) AS sent_today, SUM(held = 1) AS held FROM bot_alerts
      WHERE (day = ${today} AND held = 0) OR (held = 1 AND digest_sent_at IS NULL)
      GROUP BY bot_id`;
    return new Map(
      rows.map((row) => [row.bot_id, { sentToday: row.sent_today, held: row.held }] as const),
    );
  }).pipe(Effect.mapError(failure), Effect.withSpan("BotAttention.counts"));

  return BotAttention.of({
    get,
    status,
    configure,
    admit,
    hasHeldAlerts,
    claimDigests,
    canSendDigest,
    markDigestSent,
    counts,
    changes: PubSub.subscribe(changed).pipe(Effect.map(Stream.fromSubscription)),
  });
});

export const layer = Layer.effect(BotAttention, make).pipe(
  Layer.provide(DateTime.layerCurrentZoneLocal),
);
