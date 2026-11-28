import {
  BOT_TASK_LIMIT_DEFAULT,
  BotAppearance,
  BotDetail,
  type BotHomeAccess,
  type BotId,
  type BotLearningPolicy,
  BotLearningSource,
  type BotLearningStatus,
  type BotMcpGrants,
  BotSourcePreference,
  MAC_CALENDAR_CONNECTION_ID,
  type McpConnectionId,
  type McpGrantLevel,
  type ModelSelection,
  type ProjectId,
  ReceivedBotAppearance,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as BotDatabase from "./persistence/BotDatabase.ts";

type BotInsertRow = Omit<BotRow, "home_access">;
type BotProfileRow = Omit<BotInsertRow, "archived_at" | "created_at">;

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
  /** Read from every stored Bot; absent on rows built before they are saved, which keep the stored one. */
  readonly task_limit?: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
  /** A `BotHomeAccess`; set only through `setHomeAccess`. */
  readonly home_access: string;
}

/** project: a Home in an attached project. bot: the Bot-level Home in the Bot's hidden project. */
export type BotContextKind = "project" | "bot";

export interface BotContextRow {
  readonly home_thread_id: string;
  readonly bot_id: string;
  readonly project_id: string;
  readonly kind: BotContextKind;
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
  /** When the revision first became active; later status changes leave it. */
  readonly activated_at: string | null;
  /** The earlier revision a restore copied. */
  readonly restored_from: number | null;
  /** When the lesson last came up again unchanged; ranks it for a turn like a newer lesson. */
  readonly reinforced_at: string | null;
}

/** A project lesson suggested for all projects because another project keeps `matched`. */
export interface BotLearningSuggestionRow {
  readonly entry_id: string;
  readonly bot_id: string;
  /** The revisions that matched; the suggestion holds only while both are still in use. */
  readonly entry_revision: number;
  readonly matched_entry_id: string;
  readonly matched_revision: number;
  readonly created_at: string;
  readonly dismissed_at: string | null;
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
const CalendarChoiceJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeCalendarChoice = Schema.encodeSync(CalendarChoiceJson);
const decodeCalendarChoiceOption = Schema.decodeOption(CalendarChoiceJson);
// An unreadable choice narrows to no calendars rather than widening to all of them.
const decodeCalendarChoice = (json: string) =>
  Option.getOrElse(decodeCalendarChoiceOption(json), () => []);

export class BotStore extends Context.Service<
  BotStore,
  {
    readonly listBots: Effect.Effect<ReadonlyArray<BotRow>, BotStoreError>;
    readonly getBot: (botId: string) => Effect.Effect<BotRow | undefined, BotStoreError>;
    /** The Bot's project Homes, or every Bot's; never a Bot-level Home. */
    readonly listContexts: (
      botId?: string,
    ) => Effect.Effect<ReadonlyArray<BotContextRow>, BotStoreError>;
    /** Bot-level Homes, one per Bot at most, attached or removed. */
    readonly listHomes: (
      botId?: string,
    ) => Effect.Effect<ReadonlyArray<BotContextRow>, BotStoreError>;
    readonly getContext: (
      botId: BotId,
      projectId: ProjectId,
    ) => Effect.Effect<BotContextRow | undefined, BotStoreError>;
    readonly getContextByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<BotContextRow | undefined, BotStoreError>;
    readonly insertBot: (row: BotInsertRow) => Effect.Effect<void, BotStoreError>;
    readonly updateBot: (row: BotProfileRow) => Effect.Effect<void, BotStoreError>;
    readonly setHomeAccess: (
      botId: BotId,
      access: BotHomeAccess,
    ) => Effect.Effect<void, BotStoreError>;
    /** Sets the access only while the Bot-level Home is attached, in one statement; false otherwise. */
    readonly setOpenHomeAccess: (
      botId: BotId,
      access: BotHomeAccess,
    ) => Effect.Effect<boolean, BotStoreError>;
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
    /** The first change to active also records when the revision came into use. */
    readonly setLearningStatus: (input: {
      readonly entryId: string;
      readonly revision: number;
      readonly status: BotLearningStatus;
      readonly decidedAt: string;
      readonly origin?: string;
    }) => Effect.Effect<void, BotStoreError>;
    /** Only a revision still in use is reinforced. */
    readonly setLearningReinforced: (input: {
      readonly entryId: string;
      readonly revision: number;
      readonly reinforcedAt: string;
    }) => Effect.Effect<void, BotStoreError>;
    readonly listLearningSuggestions: (
      botId: string,
    ) => Effect.Effect<ReadonlyArray<BotLearningSuggestionRow>, BotStoreError>;
    /** Records what a lesson matches now; its dismissal survives a new match. */
    readonly upsertLearningSuggestion: (
      row: Omit<BotLearningSuggestionRow, "dismissed_at">,
    ) => Effect.Effect<void, BotStoreError>;
    /** True when the lesson has a suggestion. */
    readonly setLearningSuggestionDismissed: (input: {
      readonly entryId: string;
      readonly dismissedAt: string | null;
    }) => Effect.Effect<boolean, BotStoreError>;
    /** Every Bot's grants, or one Bot's; a Bot without any has revision 0 or its last one. */
    readonly listMcpGrants: (
      botId?: string,
    ) => Effect.Effect<ReadonlyMap<string, BotMcpGrants>, BotStoreError>;
    /** Replaces the set and the switch and advances the revision; run it in the caller's transaction. */
    readonly replaceMcpGrants: (input: {
      readonly botId: string;
      readonly connectionIds: ReadonlyArray<McpConnectionId>;
      readonly ownCodexMcpServers: boolean;
      /** Saved for the granted connections that have levels. */
      readonly levels: Readonly<Partial<Record<McpConnectionId, McpGrantLevel>>>;
      /** Saved with a Calendar (this Mac) grant; undefined uses every selected calendar. */
      readonly calendarIds?: ReadonlyArray<string> | undefined;
    }) => Effect.Effect<void, BotStoreError>;
    /** Removes a connection from every Bot that has it and returns those Bots. */
    readonly forgetMcpConnection: (
      connectionId: McpConnectionId,
    ) => Effect.Effect<ReadonlyArray<string>, BotStoreError>;
    /** Removes these calendars from every Bot's choice and returns the Bots it changed. */
    readonly forgetMacCalendars: (
      calendarIds: ReadonlyArray<string>,
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
      reinforcedAt: row.reinforced_at,
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
  home?: BotContextRow,
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
    taskLimit: bot.task_limit ?? BOT_TASK_LIMIT_DEFAULT,
    appearance: bot.appearance_json === null ? null : yield* decodeAppearance(bot.appearance_json),
    ...(mcpGrants === undefined ? {} : { mcpGrants }),
    createdAt: bot.created_at,
    updatedAt: bot.updated_at,
    archivedAt: bot.archived_at,
    projects,
    home:
      home === undefined
        ? null
        : {
            projectId: home.project_id,
            homeThreadId: home.home_thread_id,
            attachedAt: home.attached_at,
            detachedAt: home.detached_at,
            access: bot.home_access,
          },
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
  readonly taskLimit?: number;
  readonly appearanceJson: string | null;
  readonly updatedAt: string;
}): BotProfileRow {
  return {
    bot_id: input.botId,
    name: input.name,
    instructions: input.instructions,
    model_selection_json: encodeModelSelection(input.modelSelection),
    learning_policy: input.learningPolicy,
    ...(input.taskLimit === undefined ? {} : { task_limit: input.taskLimit }),
    appearance_json: input.appearanceJson,
    updated_at: input.updatedAt,
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
            SELECT * FROM bot_project_contexts WHERE kind = 'project'
            ORDER BY attached_at, project_id
          `
          : yield* sql<BotContextRow>`
            SELECT * FROM bot_project_contexts
            WHERE bot_id = ${botId} AND kind = 'project' ORDER BY attached_at, project_id
          `;
      },
      Effect.mapError(fail("list-contexts")),
    );

    const listHomes = Effect.fn("BotStore.listHomes")(
      function* (botId?: string) {
        return yield* sql<BotContextRow>`
          SELECT * FROM bot_project_contexts
          WHERE kind = 'bot' AND (${botId ?? null} IS NULL OR bot_id = ${botId ?? null})
          ORDER BY bot_id
        `;
      },
      Effect.mapError(fail("list-homes")),
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
      function* (row: BotInsertRow) {
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
      function* (row: BotProfileRow) {
        yield* sql`
        UPDATE bots SET
          name = ${row.name},
          instructions = ${row.instructions},
          model_selection_json = ${row.model_selection_json},
          learning_policy = ${row.learning_policy},
          task_limit = COALESCE(${row.task_limit ?? null}, task_limit),
          appearance_json = ${row.appearance_json},
          updated_at = ${row.updated_at}
        WHERE bot_id = ${row.bot_id}
      `;
      },
      Effect.mapError(fail("update-bot")),
    );

    const upsertContext = Effect.fn("BotStore.upsertContext")(
      function* (row: BotContextRow) {
        yield* sql`
        INSERT INTO bot_project_contexts (
          home_thread_id, bot_id, project_id, kind, guidance, sources_json, revision, thread_sync,
          attached_at, detached_at, updated_at
        ) VALUES (
          ${row.home_thread_id}, ${row.bot_id}, ${row.project_id}, ${row.kind}, ${row.guidance},
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

    const setHomeAccess = Effect.fn("BotStore.setHomeAccess")(
      function* (botId: BotId, access: BotHomeAccess) {
        yield* sql`UPDATE bots SET home_access = ${access} WHERE bot_id = ${botId}`;
      },
      Effect.mapError(fail("set-home-access")),
    );

    const setOpenHomeAccess = Effect.fn("BotStore.setOpenHomeAccess")(
      function* (botId: BotId, access: BotHomeAccess) {
        const rows = yield* sql<{ readonly bot_id: string }>`
          UPDATE bots SET home_access = ${access}
          WHERE bot_id = ${botId} AND EXISTS (
            SELECT 1 FROM bot_project_contexts
            WHERE bot_id = ${botId} AND kind = 'bot' AND detached_at IS NULL
          )
          RETURNING bot_id
        `;
        return rows.length > 0;
      },
      Effect.mapError(fail("set-home-access")),
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
            yield* sql`
              DELETE FROM bot_learning_suggestions
              WHERE entry_id NOT IN (SELECT entry_id FROM bot_learning_revisions)
            `;
            yield* sql`INSERT INTO deleted_bot_homes (home_thread_id)
              SELECT home_thread_id FROM bot_project_contexts WHERE project_id = ${projectId}
              ON CONFLICT (home_thread_id) DO NOTHING`;
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
          conflicts_with_instruction, created_at, decided_at, activated_at, restored_from,
          reinforced_at
        ) VALUES (
          ${row.entry_id}, ${row.revision}, ${row.bot_id}, ${row.project_id}, ${row.kind},
          ${row.text}, ${row.normalized_text}, ${row.rationale}, ${row.evidence}, ${row.origin},
          ${row.source_json}, ${row.learned_in_project_id}, ${row.status}, ${row.base_revision},
          ${row.conflicts_with_instruction}, ${row.created_at}, ${row.decided_at},
          ${row.activated_at}, ${row.restored_from}, ${row.reinforced_at}
        )
      `;
      },
      Effect.mapError(fail("insert-learning")),
    );

    const setLearningReinforced = Effect.fn("BotStore.setLearningReinforced")(
      function* (input: {
        readonly entryId: string;
        readonly revision: number;
        readonly reinforcedAt: string;
      }) {
        yield* sql`
          UPDATE bot_learning_revisions SET reinforced_at = ${input.reinforcedAt}
          WHERE entry_id = ${input.entryId} AND revision = ${input.revision} AND status = 'active'
        `;
      },
      Effect.mapError(fail("set-learning-reinforced")),
    );

    const setLearningStatus = Effect.fn("BotStore.setLearningStatus")(
      function* (input: {
        readonly entryId: string;
        readonly revision: number;
        readonly status: BotLearningStatus;
        readonly decidedAt: string;
        readonly origin?: string;
      }) {
        yield* sql`
        UPDATE bot_learning_revisions SET
          status = ${input.status},
          origin = COALESCE(${input.origin ?? null}, origin),
          decided_at = ${input.decidedAt},
          activated_at = CASE WHEN ${input.status} = 'active'
            THEN COALESCE(activated_at, ${input.decidedAt}) ELSE activated_at END
        WHERE entry_id = ${input.entryId} AND revision = ${input.revision}
      `;
      },
      Effect.mapError(fail("set-learning-status")),
    );

    const listLearningSuggestions = Effect.fn("BotStore.listLearningSuggestions")(
      function* (botId: string) {
        return yield* sql<BotLearningSuggestionRow>`
          SELECT * FROM bot_learning_suggestions WHERE bot_id = ${botId} ORDER BY created_at, entry_id
        `;
      },
      Effect.mapError(fail("list-learning-suggestions")),
    );

    const upsertLearningSuggestion = Effect.fn("BotStore.upsertLearningSuggestion")(
      function* (row: Omit<BotLearningSuggestionRow, "dismissed_at">) {
        yield* sql`
          INSERT INTO bot_learning_suggestions (
            entry_id, bot_id, entry_revision, matched_entry_id, matched_revision, created_at
          )
          VALUES (${row.entry_id}, ${row.bot_id}, ${row.entry_revision}, ${row.matched_entry_id},
            ${row.matched_revision}, ${row.created_at})
          ON CONFLICT(entry_id) DO UPDATE SET
            entry_revision = excluded.entry_revision,
            matched_entry_id = excluded.matched_entry_id,
            matched_revision = excluded.matched_revision
        `;
      },
      Effect.mapError(fail("upsert-learning-suggestion")),
    );

    const setLearningSuggestionDismissed = Effect.fn("BotStore.setLearningSuggestionDismissed")(
      function* (input: { readonly entryId: string; readonly dismissedAt: string | null }) {
        const changed = yield* sql<{ readonly entry_id: string }>`
          UPDATE bot_learning_suggestions SET dismissed_at = ${input.dismissedAt}
          WHERE entry_id = ${input.entryId} RETURNING entry_id
        `;
        return changed.length > 0;
      },
      Effect.mapError(fail("set-learning-suggestion-dismissed")),
    );

    const listMcpGrants = Effect.fn("BotStore.listMcpGrants")(
      function* (botId?: string) {
        const rows = yield* sql<{
          readonly bot_id: string;
          readonly mcp_grant_revision: number;
          readonly mcp_own_codex_servers: number;
          readonly connection_id: string | null;
          readonly level: string | null;
          readonly calendar_ids: string | null;
        }>`
          SELECT
            bots.bot_id, bots.mcp_grant_revision, bots.mcp_own_codex_servers,
            bot_mcp_grants.connection_id, bot_mcp_grants.level, bot_mcp_grants.calendar_ids
          FROM bots LEFT JOIN bot_mcp_grants ON bot_mcp_grants.bot_id = bots.bot_id
          WHERE ${botId ?? null} IS NULL OR bots.bot_id = ${botId ?? null}
          ORDER BY bots.bot_id, bot_mcp_grants.connection_id
        `;
        const grants = new Map<
          string,
          {
            revision: number;
            connectionIds: McpConnectionId[];
            ownCodexMcpServers: boolean;
            levels?: Record<McpConnectionId, string>;
            calendarIds?: ReadonlyArray<string>;
          }
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
            if (row.level !== null) {
              entry.levels = { ...entry.levels, [row.connection_id]: row.level };
            }
            if (row.connection_id === MAC_CALENDAR_CONNECTION_ID && row.calendar_ids !== null) {
              entry.calendarIds = decodeCalendarChoice(row.calendar_ids);
            }
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
        readonly levels: Readonly<Partial<Record<McpConnectionId, McpGrantLevel>>>;
        readonly calendarIds?: ReadonlyArray<string> | undefined;
      }) {
        yield* sql`DELETE FROM bot_mcp_grants WHERE bot_id = ${input.botId}`;
        for (const connectionId of input.connectionIds) {
          const level = input.levels[connectionId] ?? null;
          const calendarIds =
            connectionId === MAC_CALENDAR_CONNECTION_ID && input.calendarIds !== undefined
              ? encodeCalendarChoice(input.calendarIds)
              : null;
          yield* sql`
            INSERT INTO bot_mcp_grants (bot_id, connection_id, level, calendar_ids)
            VALUES (${input.botId}, ${connectionId}, ${level}, ${calendarIds})
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

    const forgetMacCalendars = Effect.fn("BotStore.forgetMacCalendars")(
      function* (calendarIds: ReadonlyArray<string>) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly bot_id: string; readonly calendar_ids: string }>`
              SELECT bot_id, calendar_ids FROM bot_mcp_grants
              WHERE connection_id = ${MAC_CALENDAR_CONNECTION_ID} AND calendar_ids IS NOT NULL
            `;
            const changed: Array<string> = [];
            for (const row of rows) {
              const choice = decodeCalendarChoice(row.calendar_ids);
              const kept = choice.filter((id) => !calendarIds.includes(id));
              if (kept.length === choice.length) continue;
              yield* sql`
                UPDATE bot_mcp_grants SET calendar_ids = ${encodeCalendarChoice(kept)}
                WHERE bot_id = ${row.bot_id} AND connection_id = ${MAC_CALENDAR_CONNECTION_ID}
              `;
              yield* sql`
                UPDATE bots SET mcp_grant_revision = mcp_grant_revision + 1
                WHERE bot_id = ${row.bot_id}
              `;
              changed.push(row.bot_id);
            }
            return changed;
          }),
        );
      },
      Effect.mapError(fail("forget-mac-calendars")),
    );

    return BotStore.of({
      listBots: sql<BotRow>`SELECT * FROM bots ORDER BY created_at, bot_id`.pipe(
        Effect.mapError(fail("list-bots")),
      ),
      getBot,
      listContexts,
      listHomes,
      getContext,
      getContextByThread,
      insertBot,
      updateBot,
      setHomeAccess,
      setOpenHomeAccess,
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
      setLearningReinforced,
      listLearningSuggestions,
      upsertLearningSuggestion,
      setLearningSuggestionDismissed,
      listMcpGrants,
      replaceMcpGrants,
      forgetMcpConnection,
      forgetMacCalendars,
    });
  }),
);
