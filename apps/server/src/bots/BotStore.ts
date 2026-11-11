import {
  BotAppearance,
  BotDetail,
  type BotId,
  type BotLearningPolicy,
  BotLearningSource,
  type BotLearningStatus,
  type BotMcpGrants,
  BotSourcePreference,
  type McpConnectionId,
  type ModelSelection,
  type ProjectId,
  ReceivedBotAppearance,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as BotDatabase from "./persistence/BotDatabase.ts";

/** A pending archive or unarchive of a home thread, recorded before the thread command runs. */
export type BotThreadSync = "archive" | "unarchive";

export interface BotRow {
  readonly bot_id: string;
  readonly name: string;
  readonly instructions: string;
  readonly model_selection_json: string;
  readonly learning_policy: string;
  /** Null keeps the Bot on the default look derived from its id. */
  readonly appearance_json: string | null;
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

export interface BotLearningRow {
  readonly entry_id: string;
  readonly revision: number;
  readonly bot_id: string;
  readonly project_id: string | null;
  readonly kind: string;
  readonly text: string;
  readonly normalized_text: string;
  readonly rationale: string;
  readonly evidence: string;
  readonly origin: string;
  readonly source_json: string;
  readonly learned_in_project_id: string;
  readonly status: BotLearningStatus;
  readonly base_revision: number | null;
  readonly conflicts_with_instruction: number;
  readonly created_at: string;
  readonly decided_at: string | null;
}

export class BotStoreError extends Schema.TaggedError<BotStoreError>()("BotStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

const ModelSelectionJson = Schema.fromJsonString(BotDetail.fields.modelSelection);
const SourcesJson = Schema.fromJsonString(Schema.Array(BotSourcePreference));
const AppearanceJson = Schema.fromJsonString(ReceivedBotAppearance);
export const encodeModelSelection = Schema.encodeSync(ModelSelectionJson);
export const encodeSources = Schema.encodeSync(SourcesJson);
const encodeAppearanceJson = Schema.encodeSync(Schema.fromJsonString(BotAppearance));
export const encodeAppearance = (appearance: BotAppearance | null): string | null =>
  appearance === null ? null : encodeAppearanceJson(appearance);
const decodeDetail = Schema.decodeUnknownEffect(BotDetail);
export const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelectionJson);
const decodeSources = Schema.decodeUnknownEffect(SourcesJson);
const decodeAppearance = Schema.decodeUnknownEffect(AppearanceJson);

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
    /**
     * Forgets detached contexts and their project's learning once the project, and with it
     * their conversation, is deleted.
     */
    readonly deleteContextsForProject: (projectId: ProjectId) => Effect.Effect<void, BotStoreError>;
    /** Every revision of the Bot's learning, or of all Bots, oldest first within an entry. */
    readonly listLearning: (
      botId?: string,
    ) => Effect.Effect<ReadonlyArray<BotLearningRow>, BotStoreError>;
    readonly pendingLearningCounts: Effect.Effect<ReadonlyMap<string, number>, BotStoreError>;
    readonly insertLearning: (row: BotLearningRow) => Effect.Effect<void, BotStoreError>;
    readonly setLearningStatus: (input: {
      readonly entryId: string;
      readonly revision: number;
      readonly status: BotLearningStatus;
      readonly decidedAt: string;
    }) => Effect.Effect<void, BotStoreError>;
    /** Every Bot's grants, or one Bot's; a Bot without any has revision 0 or its last one. */
    readonly listMcpGrants: (
      botId?: string,
    ) => Effect.Effect<ReadonlyMap<string, BotMcpGrants>, BotStoreError>;
    /** Replaces the set and the switch and advances the revision; run it in the caller's transaction. */
    readonly replaceMcpGrants: (input: {
      readonly botId: string;
      readonly connectionIds: ReadonlyArray<McpConnectionId>;
      readonly ownCodexMcpServers: boolean;
    }) => Effect.Effect<void, BotStoreError>;
    /** Removes a connection from every Bot that has it and returns those Bots. */
    readonly forgetMcpConnection: (
      connectionId: McpConnectionId,
    ) => Effect.Effect<ReadonlyArray<string>, BotStoreError>;
  }
>()("t3/bots/BotStore") {}

const SourceJson = Schema.fromJsonString(BotLearningSource);
export const encodeLearningSource = Schema.encodeSync(SourceJson);
const decodeLearningSource = Schema.decodeUnknownEffect(SourceJson);

export const learningSourceOf = (row: BotLearningRow) =>
  decodeLearningSource(row.source_json).pipe(
    Effect.mapError((cause) => new BotStoreError({ operation: "decode-learning-source", cause })),
  );

/**
 * The project an entry belongs to, null when shared: that of its newest revision that was ever in
 * use, so a proposal to move it changes nothing until adopted.
 */
export const learningScopeOf = (revisions: ReadonlyArray<BotLearningRow>): string | null =>
  (
    revisions.findLast(
      (row) => row.status === "active" || row.status === "superseded" || row.status === "retired",
    ) ?? revisions[0]
  )?.project_id ?? null;

/** Groups revision rows into entries, in the order each entry first appears. */
const toLearningEntries = Effect.fn("BotStore.toLearningEntries")(function* (
  rows: ReadonlyArray<BotLearningRow>,
) {
  const entries = new Map<string, { rows: Array<BotLearningRow>; revisions: Array<unknown> }>();
  for (const row of rows) {
    const revision = {
      revision: row.revision,
      projectId: row.project_id,
      text: row.text,
      rationale: row.rationale,
      evidence: row.evidence,
      origin: row.origin,
      source: yield* decodeLearningSource(row.source_json),
      learnedInProjectId: row.learned_in_project_id,
      status: row.status,
      baseRevision: row.base_revision,
      conflictsWithInstruction: row.conflicts_with_instruction !== 0,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
    };
    const entry = entries.get(row.entry_id);
    if (entry === undefined) entries.set(row.entry_id, { rows: [row], revisions: [revision] });
    else {
      entry.rows.push(row);
      entry.revisions.push(revision);
    }
  }
  return [...entries.entries()].map(([id, entry]) => ({
    id,
    projectId: learningScopeOf(entry.rows),
    kind: entry.rows[0]?.kind,
    revisions: entry.revisions,
  }));
});

export const toDetail = Effect.fn("BotStore.toDetail")(function* (
  bot: BotRow,
  contexts: ReadonlyArray<BotContextRow>,
  learning: ReadonlyArray<BotLearningRow>,
  mcpGrants?: BotMcpGrants,
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
    appearance: bot.appearance_json === null ? null : yield* decodeAppearance(bot.appearance_json),
    ...(mcpGrants === undefined ? {} : { mcpGrants }),
    createdAt: bot.created_at,
    updatedAt: bot.updated_at,
    archivedAt: bot.archived_at,
    projects,
    learning: yield* toLearningEntries(learning),
    pendingLearning: learning.filter((row) => row.status === "pending").length,
  });
});

export function botRow(input: {
  readonly botId: BotId;
  readonly name: string;
  readonly instructions: string;
  readonly modelSelection: ModelSelection;
  readonly learningPolicy: BotLearningPolicy;
  readonly appearanceJson: string | null;
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
    appearance_json: input.appearanceJson,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    archived_at: input.archivedAt,
  };
}

export const layer = Layer.effect(
  BotStore,
  Effect.gen(function* () {
    const sql = yield* BotDatabase.BotDatabase;
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
          bot_id, name, instructions, model_selection_json, learning_policy, appearance_json,
          created_at, updated_at, archived_at
        ) VALUES (
          ${row.bot_id}, ${row.name}, ${row.instructions}, ${row.model_selection_json},
          ${row.learning_policy}, ${row.appearance_json}, ${row.created_at}, ${row.updated_at},
          ${row.archived_at}
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
          appearance_json = ${row.appearance_json},
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
        // Shared entries learned there stay; they apply to the Bot's other projects.
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM bot_learning_revisions WHERE project_id = ${projectId}`;
            yield* sql`DELETE FROM bot_project_contexts WHERE project_id = ${projectId}`;
          }),
        );
      },
      Effect.mapError(fail("delete-contexts-for-project")),
    );

    const listLearning = Effect.fn("BotStore.listLearning")(
      function* (botId?: string) {
        return botId === undefined
          ? yield* sql<BotLearningRow>`
            SELECT * FROM bot_learning_revisions ORDER BY created_at, entry_id, revision
          `
          : yield* sql<BotLearningRow>`
            SELECT * FROM bot_learning_revisions
            WHERE bot_id = ${botId} ORDER BY created_at, entry_id, revision
          `;
      },
      Effect.mapError(fail("list-learning")),
    );

    const insertLearning = Effect.fn("BotStore.insertLearning")(
      function* (row: BotLearningRow) {
        yield* sql`
        INSERT INTO bot_learning_revisions (
          entry_id, revision, bot_id, project_id, kind, text, normalized_text, rationale,
          evidence, origin, source_json, learned_in_project_id, status, base_revision,
          conflicts_with_instruction, created_at, decided_at
        ) VALUES (
          ${row.entry_id}, ${row.revision}, ${row.bot_id}, ${row.project_id}, ${row.kind},
          ${row.text}, ${row.normalized_text}, ${row.rationale}, ${row.evidence}, ${row.origin},
          ${row.source_json}, ${row.learned_in_project_id}, ${row.status}, ${row.base_revision},
          ${row.conflicts_with_instruction}, ${row.created_at}, ${row.decided_at}
        )
      `;
      },
      Effect.mapError(fail("insert-learning")),
    );

    const setLearningStatus = Effect.fn("BotStore.setLearningStatus")(
      function* (input: {
        readonly entryId: string;
        readonly revision: number;
        readonly status: BotLearningStatus;
        readonly decidedAt: string;
      }) {
        yield* sql`
        UPDATE bot_learning_revisions SET status = ${input.status}, decided_at = ${input.decidedAt}
        WHERE entry_id = ${input.entryId} AND revision = ${input.revision}
      `;
      },
      Effect.mapError(fail("set-learning-status")),
    );

    const listMcpGrants = Effect.fn("BotStore.listMcpGrants")(
      function* (botId?: string) {
        const rows = yield* sql<{
          readonly bot_id: string;
          readonly mcp_grant_revision: number;
          readonly mcp_own_codex_servers: number;
          readonly connection_id: string | null;
        }>`
          SELECT
            bots.bot_id, bots.mcp_grant_revision, bots.mcp_own_codex_servers,
            bot_mcp_grants.connection_id
          FROM bots LEFT JOIN bot_mcp_grants ON bot_mcp_grants.bot_id = bots.bot_id
          WHERE ${botId ?? null} IS NULL OR bots.bot_id = ${botId ?? null}
          ORDER BY bots.bot_id, bot_mcp_grants.connection_id
        `;
        const grants = new Map<
          string,
          { revision: number; connectionIds: McpConnectionId[]; ownCodexMcpServers: boolean }
        >();
        for (const row of rows) {
          let entry = grants.get(row.bot_id);
          if (entry === undefined) {
            entry = {
              revision: row.mcp_grant_revision,
              connectionIds: [],
              ownCodexMcpServers: row.mcp_own_codex_servers === 1,
            };
            grants.set(row.bot_id, entry);
          }
          if (row.connection_id !== null) {
            entry.connectionIds.push(row.connection_id as McpConnectionId);
          }
        }
        return grants as ReadonlyMap<string, BotMcpGrants>;
      },
      Effect.mapError(fail("list-mcp-grants")),
    );

    const replaceMcpGrants = Effect.fn("BotStore.replaceMcpGrants")(
      function* (input: {
        readonly botId: string;
        readonly connectionIds: ReadonlyArray<McpConnectionId>;
        readonly ownCodexMcpServers: boolean;
      }) {
        yield* sql`DELETE FROM bot_mcp_grants WHERE bot_id = ${input.botId}`;
        for (const connectionId of input.connectionIds) {
          yield* sql`
            INSERT INTO bot_mcp_grants (bot_id, connection_id) VALUES (${input.botId}, ${connectionId})
          `;
        }
        yield* sql`
          UPDATE bots SET
            mcp_grant_revision = mcp_grant_revision + 1,
            mcp_own_codex_servers = ${input.ownCodexMcpServers ? 1 : 0}
          WHERE bot_id = ${input.botId}
        `;
      },
      Effect.mapError(fail("replace-mcp-grants")),
    );

    const forgetMcpConnection = Effect.fn("BotStore.forgetMcpConnection")(
      function* (connectionId: McpConnectionId) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly bot_id: string }>`
              SELECT bot_id FROM bot_mcp_grants WHERE connection_id = ${connectionId}
            `;
            for (const { bot_id } of rows) {
              yield* sql`
                DELETE FROM bot_mcp_grants
                WHERE bot_id = ${bot_id} AND connection_id = ${connectionId}
              `;
              yield* sql`
                UPDATE bots SET mcp_grant_revision = mcp_grant_revision + 1 WHERE bot_id = ${bot_id}
              `;
            }
            return rows.map((row) => row.bot_id);
          }),
        );
      },
      Effect.mapError(fail("forget-mcp-connection")),
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
      listLearning,
      pendingLearningCounts: sql<{ readonly bot_id: string; readonly pending: number }>`
        SELECT bot_id, COUNT(*) AS pending FROM bot_learning_revisions
        WHERE status = 'pending' GROUP BY bot_id
      `.pipe(
        Effect.map((rows) => new Map(rows.map((row) => [row.bot_id, row.pending]))),
        Effect.mapError(fail("pending-learning-counts")),
      ),
      insertLearning,
      setLearningStatus,
      listMcpGrants,
      replaceMcpGrants,
      forgetMcpConnection,
    });
  }),
);
