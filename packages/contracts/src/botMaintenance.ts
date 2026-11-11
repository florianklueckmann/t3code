import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { BotContinuationScope } from "./botContinuation.ts";

export const BotMaintenanceView = Schema.Struct({
  ...BotContinuationScope.fields,
  homeThreadId: ThreadId,
  /** Settings revision for compare-and-set; 0 before maintenance was first configured. */
  revision: NonNegativeInt,
  enabled: Schema.Boolean,
  /** When maintenance first started; earlier Home input and finished work are never evidence. */
  startedAt: Schema.NullOr(IsoDateTime),
  /** Why maintenance cannot be turned on here; a string so new reasons stay decodable. */
  unavailableReason: Schema.NullOr(Schema.String),
  /** False while the Bot is archived or the project detached. */
  writable: Schema.Boolean,
});
export type BotMaintenanceView = typeof BotMaintenanceView.Type;

export const BotConfigureMaintenanceInput = Schema.Struct({
  ...BotContinuationScope.fields,
  baseRevision: NonNegativeInt,
  enabled: Schema.Boolean,
});
export type BotConfigureMaintenanceInput = typeof BotConfigureMaintenanceInput.Type;

export const BotConfigureMaintenanceResult = Schema.Union([
  Schema.TaggedStruct("saved", { view: BotMaintenanceView }),
  Schema.TaggedStruct("conflict", { current: BotMaintenanceView }),
]);
export type BotConfigureMaintenanceResult = typeof BotConfigureMaintenanceResult.Type;
