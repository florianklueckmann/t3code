import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { BotContinuationScope } from "./botContinuation.ts";

/** Local time in the server's time zone. */
export const BotHomeCheckTimeOfDay = Schema.String.check(
  Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/),
).annotate({ description: "Local time as HH:MM, such as 08:00." });

export const BOT_HOME_CHECK_DEFAULT_TIME = "08:00";

export const BotHomeCheckView = Schema.Struct({
  ...BotContinuationScope.fields,
  homeThreadId: ThreadId,
  /** Settings revision for compare-and-set; 0 before the check was first configured. */
  revision: NonNegativeInt,
  enabled: Schema.Boolean,
  timeOfDay: BotHomeCheckTimeOfDay,
  /**
   * Also check early when Bot work in this project finishes or fails; only with the daily check
   * on. Absent from servers without early checks.
   */
  early: Schema.optionalKey(Schema.Boolean),
  /** Why the check cannot be turned on here; a string so new reasons stay decodable. */
  unavailableReason: Schema.NullOr(Schema.String),
  /** False while the Bot is archived or the project detached. */
  writable: Schema.Boolean,
  /** The latest check; `outcome` is a string so new outcomes stay decodable. */
  lastCheck: Schema.NullOr(
    Schema.Struct({
      at: IsoDateTime,
      outcome: Schema.String,
      added: Schema.optionalKey(NonNegativeInt),
      /** True when finished Bot work requested this check ahead of the daily one. */
      early: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type BotHomeCheckView = typeof BotHomeCheckView.Type;

export const BotConfigureHomeCheckInput = Schema.Struct({
  ...BotContinuationScope.fields,
  baseRevision: NonNegativeInt,
  enabled: Schema.Boolean,
  timeOfDay: Schema.optionalKey(BotHomeCheckTimeOfDay),
  /** Omitted keeps the current choice; turning the daily check off turns this off too. */
  early: Schema.optionalKey(Schema.Boolean),
});
export type BotConfigureHomeCheckInput = typeof BotConfigureHomeCheckInput.Type;

export const BotConfigureHomeCheckResult = Schema.Union([
  Schema.TaggedStruct("saved", { view: BotHomeCheckView }),
  Schema.TaggedStruct("conflict", { current: BotHomeCheckView }),
]);
export type BotConfigureHomeCheckResult = typeof BotConfigureHomeCheckResult.Type;
