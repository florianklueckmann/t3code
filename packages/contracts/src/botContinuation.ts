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
const Quote = TrimmedNonEmptyString;
const Text = Quote.check(Schema.isPattern(/^[^\r\n]+$/));
const InputItem = Schema.Struct({
  text: Text,
  quote: Schema.optional(Quote),
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
      Record<
        (typeof BOT_CONTINUATION_SECTIONS)[number],
        readonly { readonly text: string; readonly quote?: string | undefined }[]
      >
    >,
  ) => {
    const items = BOT_CONTINUATION_SECTIONS.flatMap((section) => note[section]);
    const counts = items.reduce(
      (current, item) => ({
        total: current.total + item.text.length,
        longestText: Math.max(current.longestText, item.text.length),
        longestQuote: Math.max(current.longestQuote, item.quote?.length ?? 0),
      }),
      { total: 0, longestText: 0, longestQuote: 0 },
    );
    const exceeded: string[] = [];
    if (items.length > BOT_CONTINUATION_LIMITS.items)
      exceeded.push(`${items.length} items (limit ${BOT_CONTINUATION_LIMITS.items})`);
    if (counts.total > BOT_CONTINUATION_LIMITS.textChars)
      exceeded.push(
        `${counts.total} total text units (limit ${BOT_CONTINUATION_LIMITS.textChars})`,
      );
    if (counts.longestText > BOT_CONTINUATION_LIMITS.itemChars)
      exceeded.push(
        `longest text ${counts.longestText} units (limit ${BOT_CONTINUATION_LIMITS.itemChars})`,
      );
    if (counts.longestQuote > BOT_CONTINUATION_LIMITS.itemChars)
      exceeded.push(
        `longest quote ${counts.longestQuote} units (limit ${BOT_CONTINUATION_LIMITS.itemChars})`,
      );
    return (
      exceeded.length === 0 ||
      `Working notes exceed budget (UTF-16 code units): ${exceeded.join("; ")}.`
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
export const BotContinuationReadInput = Schema.Struct({
  ...BotContinuationScope.fields,
  afterTaskId: Schema.optional(BotTaskId),
});
export type BotContinuationReadInput = typeof BotContinuationReadInput.Type;
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
  /** Oldest first and in full: the Home input and returned results no shown save covers yet. */
  uncovered: Schema.optional(
    Schema.Struct({
      sources: Schema.Array(
        Schema.Struct({
          messageId: MessageId,
          ordinal: NonNegativeInt,
          kind: Schema.Literals(["input", "result"]),
          directUser: Schema.Boolean,
          /** Too large for any read: `parts` hold only its first lines. */
          tooLarge: Schema.optional(
            Schema.Struct({ bytes: NonNegativeInt, createdAt: IsoDateTime }),
          ),
          /**
           * The text in order. Each part ends with its acknowledgement, so a part cut from what
           * the model saw loses its ack and a save cannot certify the item. The last part of a
           * `tooLarge` preview is where the server cut it: it says so and has no ack.
           */
          parts: Schema.Array(
            Schema.Union([
              Schema.Struct({ text: Schema.String, ack: Schema.String }),
              Schema.Struct({ text: Schema.String, cut: Schema.String }),
            ]),
          ),
        }),
      ),
      remaining: NonNegativeInt,
    }),
  ),
  activeTasks: Schema.Array(
    Schema.Struct({
      taskId: BotTaskId,
      title: Schema.String,
      status: BotTaskStatus,
      workThreadId: Schema.NullOr(ThreadId),
    }),
  ),
  moreActiveTasks: NonNegativeInt,
  nextActiveTaskId: Schema.optional(Schema.NullOr(BotTaskId)),
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
  /** The acks of every `uncovered` part the saving run read whole. */
  acks: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(16))).check(Schema.isMaxLength(512)),
  ),
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
