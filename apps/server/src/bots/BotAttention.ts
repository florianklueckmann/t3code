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
import * as Schema from "effect/Schema";
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
  /** When it was claimed: its relay identity and alert time, the same on every retry. */
  readonly digestAt: string;
}

export class BotAttention extends Context.Service<
  BotAttention,
  {
    readonly get: (botId: BotId) => Effect.Effect<BotAttentionView, BotError>;
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
    readonly isDigestPending: (digest: BotAlertDigest) => Effect.Effect<boolean, BotError>;
    readonly markDigestSent: (digest: BotAlertDigest) => Effect.Effect<void, BotError>;
  }
>()("t3/bots/BotAttention") {}

/** The relay rings for a completion at most this old; an older unsent claim gets a new identity. */
const DIGEST_RECLAIM_MS = 2 * 60_000;

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
    const [sent] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM bot_alerts
      WHERE bot_id = ${botId} AND day = ${DateTime.formatIsoDate(now)} AND held = 0`;
    const [held] = yield* sql<{
      readonly count: number;
      readonly oldest: string | null;
    }>`SELECT COUNT(*) AS count, MIN(decided_at) AS oldest FROM bot_alerts
      WHERE bot_id = ${botId} AND held = 1 AND digest_sent_at IS NULL`;
    return {
      botId,
      revision: current.revision,
      dailyLimit: current.dailyLimit,
      quietHours: current.quietHours,
      remit: current.remit,
      writable: bot.archived_at === null,
      sentToday: sent?.count ?? 0,
      held: held?.count ?? 0,
      digestAt:
        held?.oldest == null
          ? null
          : DateTime.formatIso(digestDueAt(local(held.oldest), current.quietHours)),
    } satisfies BotAttentionView;
  }, Effect.mapError(failure));

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
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [decided] = yield* sql<{
          readonly held: number;
        }>`SELECT held FROM bot_alerts WHERE alert_key = ${key}`;
        if (decided !== undefined) return decided.held === 1 ? "hold" : "send";
        const current = yield* settings(alert.botId);
        const now = yield* localNow;
        const day = DateTime.formatIsoDate(now);
        const [sent] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM bot_alerts WHERE bot_id = ${alert.botId} AND day = ${day} AND held = 0`;
        const held =
          inQuietHours(now, current.quietHours) || (sent?.count ?? 0) >= current.dailyLimit;
        yield* sql`INSERT INTO bot_alerts (alert_key, bot_id, task_id, work_thread_id, home_thread_id, phase, day, decided_at, held)
          VALUES (${key}, ${alert.botId}, ${alert.taskId}, ${alert.workThreadId}, ${alert.homeThreadId},
            ${alert.phase}, ${day}, ${DateTime.formatIso(now)}, ${held ? 1 : 0})`;
        return held ? ("hold" as const) : ("send" as const);
      }),
    );
  }, Effect.mapError(failure));

  /** Polled by the scheduler tick, so it opens no span. */
  const hasHeldAlerts =
    sql`SELECT 1 FROM bot_alerts WHERE held = 1 AND digest_sent_at IS NULL LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(failure),
    );

  const claimDigests = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly alert_key: string;
      readonly bot_id: string;
      readonly name: string;
      readonly home_thread_id: string;
      readonly project_id: string | null;
      readonly phase: string;
      readonly decided_at: string;
      readonly digest_at: string | null;
    }>`SELECT a.alert_key, a.bot_id, b.name, a.home_thread_id, c.project_id, a.phase, a.decided_at, a.digest_at
      FROM bot_alerts a JOIN bots b ON b.bot_id = a.bot_id
      LEFT JOIN bot_project_contexts c ON c.home_thread_id = a.home_thread_id
      WHERE a.held = 1 AND a.digest_sent_at IS NULL ORDER BY a.decided_at, a.alert_key`;
    if (rows.length === 0) return [];
    const now = yield* localNow;
    const nowIso = DateTime.formatIso(now);
    const digests: Array<BotAlertDigest> = [];
    for (const botId of new Set(rows.map((row) => row.bot_id))) {
      const held = rows.filter((row) => row.bot_id === botId);
      const claimed = held.find((row) => row.digest_at !== null)?.digest_at ?? null;
      let digestAt = claimed;
      let batch = held.filter((row) => row.digest_at === claimed);
      if (claimed === null) {
        const { quietHours } = yield* settings(botId);
        if (inQuietHours(now, quietHours)) continue;
        // Each alert waits for its own release, so one held a moment ago waits for the next.
        batch = held.filter(
          (row) => !DateTime.isGreaterThan(digestDueAt(local(row.decided_at), quietHours), now),
        );
        if (batch.length === 0) continue;
        digestAt = nowIso;
        yield* sql`UPDATE bot_alerts SET digest_at = ${digestAt}
          WHERE alert_key IN ${sql.in(batch.map((row) => row.alert_key))}`;
      } else if (DateTime.toEpochMillis(now) - Date.parse(claimed) >= DIGEST_RECLAIM_MS) {
        digestAt = nowIso;
        yield* sql`UPDATE bot_alerts SET digest_at = ${digestAt}
          WHERE bot_id = ${botId} AND digest_at = ${claimed} AND digest_sent_at IS NULL`;
      }
      const newest = batch.at(-1)!;
      digests.push({
        botId,
        botName: newest.name,
        homeThreadId: ThreadId.make(newest.home_thread_id),
        projectId: newest.project_id,
        held: batch.length,
        allFailed: batch.every((row) => row.phase === "failed"),
        digestAt: digestAt!,
      });
    }
    return digests;
  }).pipe(Effect.mapError(failure));

  const isDigestPending = (digest: BotAlertDigest) =>
    sql`SELECT 1 FROM bot_alerts WHERE bot_id = ${digest.botId} AND digest_at = ${digest.digestAt}
      AND digest_sent_at IS NULL LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(failure),
    );

  const markDigestSent = Effect.fn("BotAttention.markDigestSent")(function* (
    digest: BotAlertDigest,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`UPDATE bot_alerts SET digest_sent_at = ${now}
      WHERE bot_id = ${digest.botId} AND digest_at = ${digest.digestAt} AND digest_sent_at IS NULL`;
  }, Effect.mapError(failure));

  return BotAttention.of({
    get,
    configure,
    admit,
    hasHeldAlerts,
    claimDigests,
    isDigestPending,
    markDigestSent,
  });
});

export const layer = Layer.effect(BotAttention, make).pipe(
  Layer.provide(DateTime.layerCurrentZoneLocal),
);
