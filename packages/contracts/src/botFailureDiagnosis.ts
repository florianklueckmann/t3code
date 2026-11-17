import * as Schema from "effect/Schema";
import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BotContinuationScope } from "./botContinuation.ts";

export const BOT_FAILURE_DIAGNOSIS_BRIEF_MAX_CHARS = 4_000;

/** Model-facing: what a diagnostic task looks into when the user has not written a brief. */
export const BOT_FAILURE_DIAGNOSIS_DEFAULT_BRIEF =
  "Find out why this routine run failed. Name the step that failed, the likely cause and what the user could change so the next run succeeds.";

export const BotFailureDiagnosisBrief = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BOT_FAILURE_DIAGNOSIS_BRIEF_MAX_CHARS),
);

export const BotFailureDiagnosisView = Schema.Struct({
  ...BotContinuationScope.fields,
  homeThreadId: ThreadId,
  /** Settings revision for compare-and-set; 0 before the rule was first configured. */
  revision: NonNegativeInt,
  enabled: Schema.Boolean,
  brief: BotFailureDiagnosisBrief,
  /**
   * Why a diagnosis could not run No changes here, so the rule cannot be turned on; a string so
   * new reasons stay decodable.
   */
  unavailableReason: Schema.NullOr(Schema.String),
  /** False while the Bot is archived or the project detached. */
  writable: Schema.Boolean,
});
export type BotFailureDiagnosisView = typeof BotFailureDiagnosisView.Type;

export const BotConfigureFailureDiagnosisInput = Schema.Struct({
  ...BotContinuationScope.fields,
  baseRevision: NonNegativeInt,
  enabled: Schema.Boolean,
  brief: Schema.optionalKey(BotFailureDiagnosisBrief),
});
export type BotConfigureFailureDiagnosisInput = typeof BotConfigureFailureDiagnosisInput.Type;

export const BotConfigureFailureDiagnosisResult = Schema.Union([
  Schema.TaggedStruct("saved", { view: BotFailureDiagnosisView }),
  Schema.TaggedStruct("conflict", { current: BotFailureDiagnosisView }),
]);
export type BotConfigureFailureDiagnosisResult = typeof BotConfigureFailureDiagnosisResult.Type;
