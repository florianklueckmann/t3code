import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { BotId, BotTaskId, BotTaskStatus } from "./bot.ts";

export const BOT_CONTINUATION_SECTIONS = ["requests", "waiting", "decided", "context"] as const;
export const BOT_CONTINUATION_LIMITS = {
  items: 20,
  itemChars: 400,
  textChars: 4000,
  revisions: 20,
  injectionChars: 8000,
} as const;
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_CONTINUATION_LIMITS.itemChars));
const InputItem = Schema.Struct({
  text: Text,
  quote: Schema.optional(Text),
  taskIds: Schema.optional(Schema.Array(BotTaskId).check(Schema.isMaxLength(2))),
});
const sectionFields = <S extends Schema.Top>(item: S) => ({
  requests: Schema.Array(item),
  waiting: Schema.Array(item),
  decided: Schema.Array(item),
  context: Schema.Array(item),
});
const withinBounds = Schema.makeFilter(
  (
    note: Readonly<
      Record<(typeof BOT_CONTINUATION_SECTIONS)[number], readonly { readonly text: string }[]>
    >,
  ) => {
    const items = BOT_CONTINUATION_SECTIONS.flatMap((section) => note[section]);
    return (
      (items.length <= BOT_CONTINUATION_LIMITS.items &&
        items.reduce((sum, item) => sum + item.text.length, 0) <=
          BOT_CONTINUATION_LIMITS.textChars) ||
      "Working notes allow 20 items and 4000 total text characters."
    );
  },
);
export const BotContinuationNoteInput = Schema.Struct(sectionFields(InputItem)).check(withinBounds);
export type BotContinuationNoteInput = typeof BotContinuationNoteInput.Type;
export const BotContinuationRef = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("message"),
    messageId: MessageId,
    ordinal: NonNegativeInt,
    digest: Schema.String,
    quote: Schema.String,
    directUser: Schema.Boolean,
    availability: Schema.Literals(["available", "historical_unverified"]),
  }),
  Schema.Struct({ kind: Schema.Literal("user"), revision: PositiveInt }),
  Schema.Struct({
    kind: Schema.Literal("task"),
    taskId: BotTaskId,
    status: Schema.NullOr(BotTaskStatus),
    resultRunId: Schema.NullOr(RunId),
    availability: Schema.Literals(["available", "historical_unverified"]),
  }),
]);
export type BotContinuationRef = typeof BotContinuationRef.Type;
export const BotContinuationNote = Schema.Struct(
  sectionFields(
    Schema.Struct({
      text: Text,
      refs: Schema.Array(BotContinuationRef).check(Schema.isMaxLength(3)),
    }),
  ),
).check(withinBounds);
export type BotContinuationNote = typeof BotContinuationNote.Type;
export const BotContinuationScope = Schema.Struct({ botId: BotId, projectId: ProjectId });
export type BotContinuationScope = typeof BotContinuationScope.Type;
export const BotContinuationBasis = Schema.Struct({
  token: Schema.String.check(Schema.isMaxLength(4096)),
  fromOrdinal: Schema.NullOr(NonNegativeInt),
  throughOrdinal: Schema.NullOr(NonNegativeInt),
});
export type BotContinuationBasis = typeof BotContinuationBasis.Type;
export const BotContinuationWriter = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("bot"), threadId: ThreadId, runId: RunId }),
]);
export const BotContinuationRevision = Schema.Struct({
  revision: PositiveInt,
  note: BotContinuationNote,
  updatedBy: BotContinuationWriter,
  updatedAt: IsoDateTime,
  restoredFrom: Schema.NullOr(PositiveInt),
  coverage: Schema.NullOr(
    Schema.Struct({
      fromOrdinal: Schema.NullOr(NonNegativeInt),
      throughOrdinal: Schema.NullOr(NonNegativeInt),
    }),
  ),
});
export type BotContinuationRevision = typeof BotContinuationRevision.Type;
export const BotContinuationView = Schema.Struct({
  ...BotContinuationScope.fields,
  homeThreadId: ThreadId,
  revision: Schema.NullOr(PositiveInt),
  note: BotContinuationNote,
  updatedBy: Schema.NullOr(BotContinuationWriter),
  updatedAt: Schema.NullOr(IsoDateTime),
  restoredFrom: Schema.NullOr(PositiveInt),
  coverage: BotContinuationRevision.fields.coverage,
  basis: Schema.NullOr(BotContinuationBasis),
  writable: Schema.Boolean,
  newerInputs: Schema.Struct({
    count: NonNegativeInt,
    firstOrdinal: Schema.NullOr(NonNegativeInt),
    lastOrdinal: Schema.NullOr(NonNegativeInt),
  }),
  sources: Schema.Array(
    Schema.Struct({
      messageId: MessageId,
      ordinal: NonNegativeInt,
      text: Schema.String,
      directUser: Schema.Boolean,
    }),
  ),
  moreSources: NonNegativeInt,
  activeTasks: Schema.Array(
    Schema.Struct({
      taskId: BotTaskId,
      title: Schema.String,
      status: BotTaskStatus,
      workThreadId: Schema.NullOr(ThreadId),
    }),
  ),
  moreActiveTasks: NonNegativeInt,
});
export type BotContinuationView = typeof BotContinuationView.Type;
export const BotContinuationHistory = Schema.Struct({
  revisions: Schema.Array(BotContinuationRevision),
});
export type BotContinuationHistory = typeof BotContinuationHistory.Type;
export const BotSaveContinuationInput = Schema.Struct({
  ...BotContinuationScope.fields,
  baseRevision: Schema.NullOr(PositiveInt),
  updateId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  note: BotContinuationNoteInput,
  basis: Schema.optional(BotContinuationBasis),
  restoredFrom: Schema.optional(PositiveInt),
});
export type BotSaveContinuationInput = typeof BotSaveContinuationInput.Type;
export const BotSaveContinuationResult = Schema.Union([
  Schema.TaggedStruct("saved", {
    acceptedRevision: PositiveInt,
    duplicate: Schema.Boolean,
    view: BotContinuationView,
  }),
  Schema.TaggedStruct("conflict", {
    reason: Schema.Literals(["revision", "update_id", "basis"]),
    current: BotContinuationView,
  }),
]);
export type BotSaveContinuationResult = typeof BotSaveContinuationResult.Type;
