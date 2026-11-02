import {
  BotDetail,
  type BotId,
  type BotLearningPolicy,
  BotSourcePreference,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** A pending archive or unarchive of a home thread, recorded before the thread command runs. */
export type BotThreadSync = "archive" | "unarchive";

export interface BotRow {
  readonly bot_id: string;
  readonly name: string;
  readonly instructions: string;
  readonly model_selection_json: string;
  readonly learning_policy: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
}

export interface BotContextRow {
  readonly home_thread_id: string;
  readonly bot_id: string;
  readonly project_id: string;
  readonly guidance: string;
  readonly sources_json: string;
  readonly revision: number;
  readonly thread_sync: string | null;
  readonly attached_at: string;
  readonly detached_at: string | null;
  readonly updated_at: string;
}

export class BotStoreError extends Schema.TaggedError<BotStoreError>()("BotStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

const ModelSelectionJson = Schema.fromJsonString(BotDetail.fields.modelSelection);
const SourcesJson = Schema.fromJsonString(Schema.Array(BotSourcePreference));
const encodeModelSelection = Schema.encodeSync(ModelSelectionJson);
export const encodeSources = Schema.encodeSync(SourcesJson);
const decodeDetail = Schema.decodeUnknownEffect(BotDetail);
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelectionJson);
const decodeSources = Schema.decodeUnknownEffect(SourcesJson);

export class BotStore extends Context.Service<
  BotStore,
  {
    readonly listBots: Effect.Effect<ReadonlyArray<BotRow>, BotStoreError>;
    readonly getBot: (botId: string) => Effect.Effect<BotRow | undefined, BotStoreError>;
    readonly listContexts: (
      botId?: string,
    ) => Effect.Effect<ReadonlyArray<BotContextRow>, BotStoreError>;
    readonly getContext: (
      botId: BotId,
      projectId: ProjectId,
    ) => Effect.Effect<BotContextRow | undefined, BotStoreError>;
    readonly getContextByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<BotContextRow | undefined, BotStoreError>;
    readonly insertBot: (row: BotRow) => Effect.Effect<void, BotStoreError>;
    readonly updateBot: (row: BotRow) => Effect.Effect<void, BotStoreError>;
    readonly upsertContext: (row: BotContextRow) => Effect.Effect<void, BotStoreError>;
    /** Clears a sync only if no newer transition replaced it. */
    readonly clearThreadSync: (input: {
      readonly homeThreadId: ThreadId;
      readonly revision: number;
    }) => Effect.Effect<void, BotStoreError>;
    readonly pendingThreadSyncs: Effect.Effect<ReadonlyArray<BotContextRow>, BotStoreError>;
    readonly attachedBotNames: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<string>, BotStoreError>;
    /** Forgets detached contexts once their project, and with it their conversation, is deleted. */
    readonly deleteContextsForProject: (projectId: ProjectId) => Effect.Effect<void, BotStoreError>;
  }
>()("t3/bots/BotStore") {}

export const toDetail = Effect.fn("BotStore.toDetail")(function* (
  bot: BotRow,
  contexts: ReadonlyArray<BotContextRow>,
) {
  const projects = yield* Effect.forEach(contexts, (context) =>
    decodeSources(context.sources_json).pipe(
      Effect.map((sources) => ({
        projectId: context.project_id,
        homeThreadId: context.home_thread_id,
        guidance: context.guidance,
        sources,
        attachedAt: context.attached_at,
        detachedAt: context.detached_at,
        updatedAt: context.updated_at,
      })),
    ),
  );
  return yield* decodeDetail({
    id: bot.bot_id,
    name: bot.name,
    instructions: bot.instructions,
    modelSelection: yield* decodeModelSelection(bot.model_selection_json),
    learningPolicy: bot.learning_policy,
    createdAt: bot.created_at,
    updatedAt: bot.updated_at,
    archivedAt: bot.archived_at,
    projects,
  });
});

export function botRow(input: {
  readonly botId: BotId;
  readonly name: string;
  readonly instructions: string;
  readonly modelSelection: ModelSelection;
  readonly learningPolicy: BotLearningPolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}): BotRow {
  return {
    bot_id: input.botId,
    name: input.name,
    instructions: input.instructions,
    model_selection_json: encodeModelSelection(input.modelSelection),
    learning_policy: input.learningPolicy,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    archived_at: input.archivedAt,
  };
}

export const layer = Layer.effect(
  BotStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fail = (operation: string) => (cause: unknown) => new BotStoreError({ operation, cause });

    const getBot = Effect.fn("BotStore.getBot")(
      function* (botId: string) {
        const rows = yield* sql<BotRow>`SELECT * FROM bots WHERE bot_id = ${botId}`;
        return rows[0];
      },
      Effect.mapError(fail("get-bot")),
    );

    const listContexts = Effect.fn("BotStore.listContexts")(
      function* (botId?: string) {
        return botId === undefined
          ? yield* sql<BotContextRow>`
            SELECT * FROM bot_project_contexts ORDER BY attached_at, project_id
          `
          : yield* sql<BotContextRow>`
            SELECT * FROM bot_project_contexts
            WHERE bot_id = ${botId} ORDER BY attached_at, project_id
          `;
      },
      Effect.mapError(fail("list-contexts")),
    );

    const getContext = Effect.fn("BotStore.getContext")(
      function* (botId: BotId, projectId: ProjectId) {
        const rows = yield* sql<BotContextRow>`
        SELECT * FROM bot_project_contexts WHERE bot_id = ${botId} AND project_id = ${projectId}
      `;
        return rows[0];
      },
      Effect.mapError(fail("get-context")),
    );

    const getContextByThread = Effect.fn("BotStore.getContextByThread")(
      function* (threadId: ThreadId) {
        const rows = yield* sql<BotContextRow>`
        SELECT * FROM bot_project_contexts WHERE home_thread_id = ${threadId}
      `;
        return rows[0];
      },
      Effect.mapError(fail("get-context-by-thread")),
    );

    const insertBot = Effect.fn("BotStore.insertBot")(
      function* (row: BotRow) {
        yield* sql`
        INSERT INTO bots (
          bot_id, name, instructions, model_selection_json, learning_policy,
          created_at, updated_at, archived_at
        ) VALUES (
          ${row.bot_id}, ${row.name}, ${row.instructions}, ${row.model_selection_json},
          ${row.learning_policy}, ${row.created_at}, ${row.updated_at}, ${row.archived_at}
        )
      `;
      },
      Effect.mapError(fail("insert-bot")),
    );

    const updateBot = Effect.fn("BotStore.updateBot")(
      function* (row: BotRow) {
        yield* sql`
        UPDATE bots SET
          name = ${row.name},
          instructions = ${row.instructions},
          model_selection_json = ${row.model_selection_json},
          learning_policy = ${row.learning_policy},
          updated_at = ${row.updated_at},
          archived_at = ${row.archived_at}
        WHERE bot_id = ${row.bot_id}
      `;
      },
      Effect.mapError(fail("update-bot")),
    );

    const upsertContext = Effect.fn("BotStore.upsertContext")(
      function* (row: BotContextRow) {
        yield* sql`
        INSERT INTO bot_project_contexts (
          home_thread_id, bot_id, project_id, guidance, sources_json, revision, thread_sync,
          attached_at, detached_at, updated_at
        ) VALUES (
          ${row.home_thread_id}, ${row.bot_id}, ${row.project_id}, ${row.guidance},
          ${row.sources_json}, ${row.revision}, ${row.thread_sync}, ${row.attached_at},
          ${row.detached_at}, ${row.updated_at}
        )
        ON CONFLICT (home_thread_id) DO UPDATE SET
          guidance = excluded.guidance,
          sources_json = excluded.sources_json,
          revision = excluded.revision,
          thread_sync = excluded.thread_sync,
          attached_at = excluded.attached_at,
          detached_at = excluded.detached_at,
          updated_at = excluded.updated_at
      `;
      },
      Effect.mapError(fail("upsert-context")),
    );

    const clearThreadSync = Effect.fn("BotStore.clearThreadSync")(
      function* (input: { readonly homeThreadId: ThreadId; readonly revision: number }) {
        yield* sql`
        UPDATE bot_project_contexts SET thread_sync = NULL
        WHERE home_thread_id = ${input.homeThreadId} AND revision = ${input.revision}
      `;
      },
      Effect.mapError(fail("clear-thread-sync")),
    );

    const attachedBotNames = Effect.fn("BotStore.attachedBotNames")(
      function* (projectId: ProjectId) {
        const rows = yield* sql<{ readonly name: string }>`
        SELECT bots.name FROM bot_project_contexts
        JOIN bots ON bots.bot_id = bot_project_contexts.bot_id
        WHERE bot_project_contexts.project_id = ${projectId}
          AND bot_project_contexts.detached_at IS NULL
        ORDER BY bots.name
      `;
        return rows.map((row) => row.name);
      },
      Effect.mapError(fail("attached-bot-names")),
    );

    const deleteContextsForProject = Effect.fn("BotStore.deleteContextsForProject")(
      function* (projectId: ProjectId) {
        yield* sql`DELETE FROM bot_project_contexts WHERE project_id = ${projectId}`;
      },
      Effect.mapError(fail("delete-contexts-for-project")),
    );

    return BotStore.of({
      listBots: sql<BotRow>`SELECT * FROM bots ORDER BY created_at, bot_id`.pipe(
        Effect.mapError(fail("list-bots")),
      ),
      getBot,
      listContexts,
      getContext,
      getContextByThread,
      insertBot,
      updateBot,
      upsertContext,
      clearThreadSync,
      pendingThreadSyncs: sql<BotContextRow>`
        SELECT * FROM bot_project_contexts WHERE thread_sync IS NOT NULL
      `.pipe(Effect.mapError(fail("pending-thread-syncs"))),
      attachedBotNames,
      deleteContextsForProject,
    });
  }),
);
