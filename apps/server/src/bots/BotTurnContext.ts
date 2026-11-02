import { BotSourcePreference, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as BotStore from "./BotStore.ts";

export type BotTurnContextResult =
  | { readonly _tag: "none" }
  /** The thread is a Bot's home conversation, but the Bot is archived or the project detached. */
  | { readonly _tag: "inactive"; readonly message: string }
  | { readonly _tag: "active"; readonly instructions: string };

export class BotTurnContext extends Context.Service<
  BotTurnContext,
  {
    /** Read at every turn start, so edits and restarts need no provider session state. */
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<BotTurnContextResult, BotStore.BotStoreError>;
  }
>()("t3/bots/BotTurnContext") {}

function buildBotInstructions(input: {
  readonly botName: string;
  readonly botInstructions: string;
  readonly projectTitle: string;
  readonly guidance: string;
  readonly sources: ReadonlyArray<BotSourcePreference>;
}): string {
  const sections = [
    `You are "${input.botName}", a Bot the user configured in T3 Code. This conversation belongs to the project "${input.projectTitle}". Apply the project-specific guidance below only to this project.`,
    input.botInstructions === ""
      ? null
      : `Bot instructions from the user:\n${input.botInstructions}`,
    input.guidance === "" ? null : `Project guidance from the user:\n${input.guidance}`,
    input.sources.length === 0
      ? null
      : [
          "Established sources for this project. Prefer them when they contain relevant information; they are not an exclusive list.",
          ...input.sources.map((source) => `- ${source.label}: ${source.location}`),
        ].join("\n"),
  ];
  return `<t3_bot>\n${sections.filter((section) => section !== null).join("\n\n")}\n</t3_bot>`;
}

const decodeSources = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(BotSourcePreference)),
);

export const layer = Layer.effect(
  BotTurnContext,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* BotStore.BotStore;

    const forThread = Effect.fn("BotTurnContext.forThread")(function* (threadId: ThreadId) {
      const context = yield* store.getContextByThread(threadId);
      if (context === undefined) return { _tag: "none" } as const;
      const bot = yield* store.getBot(context.bot_id);
      if (bot === undefined || bot.archived_at !== null) {
        return {
          _tag: "inactive",
          message: "This Bot is archived. Restore it to continue this conversation.",
        } as const;
      }
      if (context.detached_at !== null) {
        return {
          _tag: "inactive",
          message: `${bot.name} is detached from this project. Reattach it to continue this conversation.`,
        } as const;
      }
      const project = yield* sql<{ readonly title: string }>`
        SELECT title FROM projection_projects WHERE project_id = ${context.project_id}
      `.pipe(
        Effect.mapError(
          (cause) => new BotStore.BotStoreError({ operation: "read-project", cause }),
        ),
      );
      const sources = yield* decodeSources(context.sources_json).pipe(
        Effect.mapError(
          (cause) => new BotStore.BotStoreError({ operation: "decode-sources", cause }),
        ),
      );
      return {
        _tag: "active",
        instructions: buildBotInstructions({
          botName: bot.name,
          botInstructions: bot.instructions,
          projectTitle: project[0]?.title ?? context.project_id,
          guidance: context.guidance,
          sources,
        }),
      } as const;
    });

    return BotTurnContext.of({ forThread });
  }),
).pipe(Layer.provide(BotStore.layer));

export const layerEmpty = Layer.succeed(
  BotTurnContext,
  BotTurnContext.of({
    forThread: Effect.fn("BotTurnContext.forThreadEmpty")(function* (_threadId: ThreadId) {
      return yield* Effect.succeed({ _tag: "none" } as const);
    }),
  }),
);
