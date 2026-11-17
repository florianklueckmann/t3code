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

/** One step of a pass; strings so new statuses and reasons stay decodable. */
export const BotMaintenanceRunStep = Schema.Struct({
  /** `error` when the step could not run at all; `reason` then holds the message. */
  status: Schema.String,
  reason: Schema.NullOr(Schema.String),
});
export type BotMaintenanceRunStep = typeof BotMaintenanceRunStep.Type;

export const BotMaintenanceRunResult = Schema.Struct({
  learning: Schema.Struct({
    ...BotMaintenanceRunStep.fields,
    /** Lessons recorded as active, and as proposals waiting for the user. */
    active: NonNegativeInt,
    pending: NonNegativeInt,
  }),
  note: BotMaintenanceRunStep,
  compaction: BotMaintenanceRunStep,
});
export type BotMaintenanceRunResult = typeof BotMaintenanceRunResult.Type;
