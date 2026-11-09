import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const DraftItems = Schema.Array(
  Schema.Struct({ text: Schema.String, quote: Schema.optional(Schema.String) }),
);
const Draft = Schema.Struct({
  requests: DraftItems,
  waiting: DraftItems,
  decided: DraftItems,
  context: DraftItems,
});
const decodeDraft = Schema.decodeUnknownOption(Schema.Struct({ note: Draft }));
const decodeCall = Schema.decodeUnknownSync(
  Schema.Struct({
    toolName: Schema.String,
    input: Schema.Struct({
      action: Schema.optional(Schema.String),
      botId: Schema.optional(Schema.String),
      projectId: Schema.optional(Schema.String),
      continuation: Schema.optional(Schema.Unknown),
    }),
  }),
);

export const readToolCalls = (
  items: readonly {
    readonly type: string;
    readonly runId: string | null;
    readonly text: string | null;
  }[],
) =>
  items.flatMap((item) => {
    if (item.type === "user_message" || item.type === "assistant_message") return [];
    try {
      const decoded: unknown = JSON.parse(item.text ?? "");
      const result = decodeCall(decoded);
      const { continuation, ...input } = result.input;
      const draft = Option.getOrUndefined(decodeDraft(continuation));
      const noteBudget =
        draft === undefined
          ? undefined
          : Object.values(draft.note)
              .flat()
              .reduce(
                (budget, entry) => ({
                  items: budget.items + 1,
                  totalTextUnits: budget.totalTextUnits + entry.text.length,
                  maxTextUnits: Math.max(budget.maxTextUnits, entry.text.length),
                  maxQuoteUnits: Math.max(budget.maxQuoteUnits, entry.quote?.length ?? 0),
                }),
                { items: 0, totalTextUnits: 0, maxTextUnits: 0, maxQuoteUnits: 0 },
              );
      return [
        {
          runId: item.runId,
          ...input,
          noteBudget,
          action: result.toolName.endsWith("t3_bot")
            ? (input.action ?? "")
            : (result.toolName.split(".").at(-1) ?? result.toolName),
        },
      ];
    } catch {
      return [];
    }
  });
