import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";
import { BotId } from "./bot.ts";
import { BotHomeCheckTimeOfDay } from "./botHomeCheck.ts";

export const BOT_ALERT_DAILY_LIMIT_MAX = 10;
export const BOT_ALERT_DEFAULT_DAILY_LIMIT = 3;
export const BOT_ALERT_DEFAULT_QUIET_HOURS = { start: "22:00", end: "07:00" } as const;
export const BOT_REMIT_MAX_LENGTH = 500;

/** Local times in the server's time zone; the span may cross midnight. */
export const BotQuietHours = Schema.Struct({
  start: BotHomeCheckTimeOfDay,
  end: BotHomeCheckTimeOfDay,
}).check(
  Schema.makeFilter(
    (hours: { readonly start: string; readonly end: string }) =>
      hours.start !== hours.end || "Quiet hours must not start and end at the same time.",
  ),
);
export type BotQuietHours = typeof BotQuietHours.Type;

export const BotAlertDailyLimit = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(BOT_ALERT_DAILY_LIMIT_MAX),
);

export const BotRemit = Schema.String.check(Schema.isMaxLength(BOT_REMIT_MAX_LENGTH));

/**
 * How much of a Bot's proactive work may reach the user: its alert budget, and the user's remit,
 * their guidance on what deserves a Waiting item.
 */
export const BotAttentionView = Schema.Struct({
  botId: BotId,
  /** Settings revision for compare-and-set; 0 before they were first saved. */
  revision: NonNegativeInt,
  /** Proactive alerts per environment-local day; results of work you started do not count. */
  dailyLimit: BotAlertDailyLimit,
  /** Null when quiet hours are off. */
  quietHours: Schema.NullOr(BotQuietHours),
  remit: BotRemit,
  /** False while the Bot is archived. */
  writable: Schema.Boolean,
  /** Proactive alerts sent today. */
  sentToday: NonNegativeInt,
  /** Alerts held for the next digest. */
  held: NonNegativeInt,
  /** When the held alerts go out as one digest; null with nothing held. */
  digestAt: Schema.NullOr(IsoDateTime),
});
export type BotAttentionView = typeof BotAttentionView.Type;

export const BotAttentionInput = Schema.Struct({ botId: BotId });
export type BotAttentionInput = typeof BotAttentionInput.Type;

export const BotConfigureAttentionInput = Schema.Struct({
  botId: BotId,
  baseRevision: NonNegativeInt,
  dailyLimit: BotAlertDailyLimit,
  quietHours: Schema.NullOr(BotQuietHours),
  remit: BotRemit,
});
export type BotConfigureAttentionInput = typeof BotConfigureAttentionInput.Type;

export const BotConfigureAttentionResult = Schema.Union([
  Schema.TaggedStruct("saved", { view: BotAttentionView }),
  Schema.TaggedStruct("conflict", { current: BotAttentionView }),
]);
export type BotConfigureAttentionResult = typeof BotConfigureAttentionResult.Type;
