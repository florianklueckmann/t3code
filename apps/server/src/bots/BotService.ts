import {
  BOT_HOME_THREAD_ID_PREFIX,
  BOT_LEARNING_RETIRE_SUGGESTIONS,
  BOT_TASK_TERMINAL_STATUSES,
  type BotAttachProjectInput,
  type BotContinuationScope,
  type BotCreateInput,
  type BotDecideLearningInput,
  type BotDecideLearningSuggestionInput,
  type BotDetachProjectInput,
  type BotDetail,
  BotError,
  type BotGetInput,
  BotId,
  type BotLearningNoticesInput,
  type BotLearningNoticesResult,
  type BotLearningRevisionRef,
  BotLearningPolicy,
  type BotLearningSource,
  type BotListResult,
  type BotOpenHomeInput,
  type BotRemoveHomeInput,
  type BotRestoreLearningInput,
  type BotRetireLearningInput,
  type BotSetArchivedInput,
  type BotSetMcpGrantsInput,
  type BotTaskId,
  type BotUpdateInput,
  type BotUpdateProjectContextInput,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  isBotHomeProjectId,
  MAC_CALENDAR_CONNECTION_ID,
  MAC_CALENDAR_LABEL,
  type McpConnectionId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as BotDatabase from "./persistence/BotDatabase.ts";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotAttention from "./BotAttention.ts";
import * as BotContinuation from "./BotContinuation.ts";
import * as BotHomeFolders from "./BotHomeFolders.ts";
import * as BotLearning from "./BotLearning.ts";
import * as BotLearningNotices from "./BotLearningNotices.ts";
import * as BotProjectGuard from "./BotProjectGuard.ts";
import * as BotProviderSupport from "./BotProviderSupport.ts";
import * as BotStore from "./BotStore.ts";
import * as BotTaskService from "./BotTaskService.ts";
import * as BotTurnContext from "./BotTurnContext.ts";

/** The only driver whose adapter delivers Bot instructions on every turn so far. */

export class BotService extends Context.Service<
  BotService,
  {
    readonly list: Effect.Effect<BotListResult, BotError>;
    readonly subscribeList: () => Stream.Stream<BotListResult, BotError>;
    /** A Home's learning notices, sent again only when they change. */
    readonly subscribeLearningNotices: (
      input: BotLearningNoticesInput,
    ) => Stream.Stream<BotLearningNoticesResult, BotError>;
    readonly get: (input: BotGetInput) => Effect.Effect<BotDetail, BotError>;
    readonly create: (input: BotCreateInput) => Effect.Effect<BotDetail, BotError>;
    readonly update: (input: BotUpdateInput) => Effect.Effect<BotDetail, BotError>;
    readonly setArchived: (input: BotSetArchivedInput) => Effect.Effect<BotDetail, BotError>;
    readonly setMcpGrants: (input: BotSetMcpGrantsInput) => Effect.Effect<BotDetail, BotError>;
    /** Drops a removed catalog connection from every Bot's grants, advancing their revisions. */
    readonly forgetMcpConnection: (connectionId: McpConnectionId) => Effect.Effect<void, BotError>;
    /** Removes these Calendar (this Mac) calendars from every Bot's choice. */
    readonly forgetMacCalendars: (
      calendarIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, BotError>;
    /** Runs a change to the Calendar (this Mac) selection with no grant save in between. */
    readonly withMacCalendarLock: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly attachProject: (input: BotAttachProjectInput) => Effect.Effect<BotDetail, BotError>;
    readonly updateProjectContext: (
      input: BotUpdateProjectContextInput,
    ) => Effect.Effect<BotDetail, BotError>;
    readonly detachProject: (input: BotDetachProjectInput) => Effect.Effect<BotDetail, BotError>;
    /** Opens the Bot-level Home in the Bot's hidden project, or reopens a removed one. */
    readonly openHome: (input: BotOpenHomeInput) => Effect.Effect<BotDetail, BotError>;
    /** Archives the Bot-level Home and stops the tasks it started, until `openHome` restores it. */
    readonly removeHome: (input: BotRemoveHomeInput) => Effect.Effect<BotDetail, BotError>;
    /**
     * The Bot, project and task whose conversation or work thread a thread is; "inactive"
     * while that Bot is archived or the project detached.
     */
    readonly scopeOfThread: (
      threadId: ThreadId,
    ) => Effect.Effect<BotTurnContext.BotTurnScope | "inactive" | undefined, BotError>;
    readonly writeOwnerOfThread: (threadId: ThreadId) => Effect.Effect<BotId | undefined, BotError>;
    /** Records a standing instruction or proposes an inferred lesson, as the policy allows. */
    readonly recordLearning: (input: BotLearning.RecordLearningInput) => Effect.Effect<
      {
        readonly bot: BotDetail;
        readonly learned: BotLearning.RecordLearningResult;
      },
      BotError
    >;
    readonly decideLearning: (input: BotDecideLearningInput) => Effect.Effect<BotDetail, BotError>;
    readonly retireLearning: (input: BotRetireLearningInput) => Effect.Effect<BotDetail, BotError>;
    readonly decideLearningSuggestion: (
      input: BotDecideLearningSuggestionInput,
    ) => Effect.Effect<BotDetail, BotError>;
    readonly restoreLearning: (
      input: BotRestoreLearningInput & { readonly source: BotLearningSource },
    ) => Effect.Effect<BotDetail, BotError>;
    /** Settles lessons whose proposing task has finished, by that task's derived status. */
    readonly reconcileTaskLearning: Effect.Effect<void, BotError>;
    /**
     * Maintenance's learning change: the same per-Bot lock and Bot transaction as user changes.
     * `change` may write only the Bot database; it commits or rolls back with its lessons.
     */
    readonly maintainLearning: <A>(
      scope: BotContinuationScope,
      change: (current: {
        readonly policy: BotLearningPolicy;
        readonly bot: BotStore.BotRow;
        readonly context: BotStore.BotContextRow;
        readonly rows: ReadonlyArray<BotStore.BotLearningRow>;
        readonly record: (
          policy: BotLearningPolicy,
          input: BotLearning.RecordLearningInput,
        ) => Effect.Effect<BotLearning.RecordLearningResult, BotError | BotStore.BotStoreError>;
        readonly reinforce: (
          ref: BotLearningRevisionRef,
        ) => Effect.Effect<void, BotStore.BotStoreError>;
        /** Suggests `entry` for all projects because another project keeps `matched`. */
        readonly suggest: (input: {
          readonly botId: string;
          readonly entry: BotLearningRevisionRef;
          readonly matched: BotLearningRevisionRef;
        }) => Effect.Effect<void, BotStore.BotStoreError>;
      }) => Effect.Effect<A, BotError | BotStore.BotStoreError | SqlError.SqlError>,
    ) => Effect.Effect<A, BotError>;
    /**
     * The attached project to use when a caller names none: the only one, or an
     * error listing the choices so the caller can ask the user.
     */
    readonly resolveProject: (input: {
      readonly botId: BotId;
      readonly projectId?: ProjectId | undefined;
    }) => Effect.Effect<BotDetail["projects"][number], BotError>;
  }
>()("t3/bots/BotService") {}

/**
 * Stable per Bot/project pair, so a reattach finds the earlier conversation.
 * Bot ids contain no colon, which keeps the pair recoverable from the id.
 */
function botHomeThreadId(botId: BotId, projectId: ProjectId): ThreadId {
  return ThreadId.make(`${BOT_HOME_THREAD_ID_PREFIX}${botId}:${projectId}`);
}

const botError = (message: string, botId?: BotId) => (cause?: unknown) =>
  new BotError({
    message,
    ...(botId === undefined ? {} : { botId }),
    ...(cause === undefined ? {} : { cause }),
  });

const isLearningPolicy = Schema.is(BotLearningPolicy);

const errorMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message !== "" ? cause.message : String(cause);

const make = Effect.gen(function* () {
  const sql = yield* BotDatabase.BotDatabase;
  const store = yield* BotStore.BotStore;
  const guard = yield* BotProjectGuard.BotProjectGuard;
  const homeFolders = yield* BotHomeFolders.BotHomeFolders;
  const projects = yield* ProjectService.ProjectService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const scheduler = yield* Scheduler.Scheduler;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const botTasks = yield* BotTaskService.BotTaskService;
  const attention = yield* BotAttention.BotAttention;
  const continuation = yield* BotContinuation.BotContinuation;
  const turnContext = yield* BotTurnContext.BotTurnContext;
  const random = yield* SecureRandom.SecureRandom;
  const main = yield* SqlClient.SqlClient;
  // Subscribers re-read the full list, so only the newest change signal matters.
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  // Names the Bot whose learning committed, so a Home's notices reread only for their own Bot.
  const learningChanges = yield* PubSub.unbounded<BotId>();

  const syncLocks = yield* KeyedLock.make<ThreadId>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const storeError = (botId?: BotId) => botError("Bot storage failed.", botId);

  const readDetail = Effect.fn("BotService.readDetail")(function* (botId: BotId) {
    const bot = yield* store.getBot(botId).pipe(Effect.mapError(storeError(botId)));
    if (bot === undefined) return yield* botError("Bot not found.", botId)();
    const contexts = yield* store.listContexts(botId).pipe(Effect.mapError(storeError(botId)));
    const [home] = yield* store.listHomes(botId).pipe(Effect.mapError(storeError(botId)));
    const learning = yield* store.listLearning(botId).pipe(Effect.mapError(storeError(botId)));
    const grants = yield* store.listMcpGrants(botId).pipe(Effect.mapError(storeError(botId)));
    const suggestions = yield* store
      .listLearningSuggestions(botId)
      .pipe(Effect.mapError(storeError(botId)));
    const detail = yield* BotStore.toDetail(bot, contexts, learning, grants.get(botId), home).pipe(
      Effect.mapError(storeError(botId)),
    );
    const instance = yield* providerInstances.getInstance(detail.modelSelection.instanceId);
    return {
      ...detail,
      capabilities: BotProviderSupport.botCapabilities(instance?.driverKind),
      learningSuggestions: BotLearning.currentSuggestions(learning, suggestions, contexts),
      learningRetireSuggestions: BotLearning.retireSuggestions(
        learning,
        contexts,
        DateTime.formatIso(
          DateTime.subtract(yield* DateTime.now, {
            days: BOT_LEARNING_RETIRE_SUGGESTIONS.idleDays,
          }),
        ),
      ),
      projects: detail.projects.map((project) => ({
        ...project,
        turnLearning: BotLearning.turnLearning(learning, project.projectId).summary,
      })),
    } satisfies BotDetail;
  });

  const requireActiveBot = Effect.fn("BotService.requireActiveBot")(function* (botId: BotId) {
    const bot = yield* store.getBot(botId).pipe(Effect.mapError(storeError(botId)));
    if (bot === undefined) return yield* botError("Bot not found.", botId)();
    if (bot.archived_at !== null) {
      return yield* botError("This Bot is archived. Restore it first.", botId)();
    }
    return bot;
  });

  /**
   * Applies the recorded archive intent to a home thread. Intent is written
   * first, so the scheduler finishes what a crash left. Rereading it under a
   * per-thread lock keeps a stale sync from undoing a newer transition.
   */
  const syncThread = Effect.fn("BotService.syncThread")(function* (stale: BotStore.BotContextRow) {
    const homeThreadId = ThreadId.make(stale.home_thread_id);
    yield* syncLocks.withLock(homeThreadId, applyThreadSync(homeThreadId));
  });

  const applyThreadSync = Effect.fn("BotService.applyThreadSync")(function* (
    homeThreadId: ThreadId,
  ) {
    const context = yield* store.getContextByThread(homeThreadId);
    if (context === undefined || context.thread_sync === null) return;
    const shell = yield* threads.getThreadShell(homeThreadId);
    const wantArchived = context.thread_sync === "archive";
    if (
      shell !== null &&
      shell.deletedAt === null &&
      (shell.archivedAt !== null) !== wantArchived
    ) {
      yield* threads.dispatch({
        type: wantArchived ? "thread.archive" : "thread.unarchive",
        commandId: CommandId.make(
          `bot-sync:${context.home_thread_id}:${context.revision}:${context.thread_sync}`,
        ),
        threadId: homeThreadId,
      });
    }
    yield* store.clearThreadSync({ homeThreadId, revision: context.revision });
  });

  /** Archive and detach owe Home nothing: no pending returns and no pending early Home checks. */
  const revokeHomeReturns = Effect.fn("BotService.revokeHomeReturns")(function* (
    botId: BotId,
    projectId?: ProjectId,
  ) {
    yield* sql`UPDATE bot_tasks SET return_home_run_id = NULL
      WHERE bot_id = ${botId} AND return_finished_at IS NULL
        AND (${projectId ?? null} IS NULL OR project_id = ${projectId ?? null})`;
    // Claimed ones too: a running check that later fails must not hand them back after a reattach.
    yield* sql`DELETE FROM bot_home_check_outcomes
      WHERE home_thread_id IN (SELECT home_thread_id FROM bot_project_contexts
        WHERE bot_id = ${botId} AND (${projectId ?? null} IS NULL OR project_id = ${projectId ?? null}))`;
  });

  /**
   * Archive and detach pause routines before stopping unfinished work, so nothing new starts
   * meanwhile. Restore and reattach leave routines paused until the user resumes them.
   */
  const stopWork = Effect.fn("BotService.stopWork")(function* (
    botId: BotId,
    projectId?: ProjectId,
  ) {
    yield* scheduledTasks
      .pauseBotRoutines({ botId, projectId })
      .pipe(Effect.mapError((cause) => botError(cause.message, botId)(cause)));
    yield* botTasks.cancelForContext({ botId, projectId });
  });

  const syncThreads = (botId: BotId, contexts: ReadonlyArray<BotStore.BotContextRow>) =>
    Effect.forEach(contexts, syncThread, { discard: true }).pipe(
      Effect.mapError((cause) =>
        botError(`Failed to update the Bot conversation: ${errorMessage(cause)}`, botId)(cause),
      ),
    );

  const list: BotService["Service"]["list"] = Effect.gen(function* () {
    const bots = yield* store.listBots;
    const contexts = yield* store.listContexts();
    const homes = yield* store.listHomes();
    const pendingLearning = yield* store.pendingLearningCounts;
    const alerts = yield* attention.counts;
    const notesRevisions = yield* continuation.latestRevisions;
    const grants = yield* store.listMcpGrants();
    const details = yield* Effect.forEach(bots, (bot) =>
      BotStore.toDetail(
        bot,
        contexts.filter((context) => context.bot_id === bot.bot_id),
        [],
        grants.get(bot.bot_id),
        homes.find((home) => home.bot_id === bot.bot_id),
      ),
    );
    return {
      bots: details.map(
        ({
          instructions: _instructions,
          learning: _learning,
          projects: botProjects,
          home,
          ...bot
        }) => ({
          ...bot,
          pendingLearning: pendingLearning.get(bot.id) ?? 0,
          alerts: alerts.get(bot.id) ?? { sentToday: 0, held: 0 },
          projects: botProjects.map((project) => ({
            projectId: project.projectId,
            homeThreadId: project.homeThreadId,
            attachedAt: project.attachedAt,
            detachedAt: project.detachedAt,
            notesRevision: notesRevisions.get(project.homeThreadId) ?? null,
          })),
          home:
            home == null
              ? null
              : { ...home, notesRevision: notesRevisions.get(home.homeThreadId) ?? null },
        }),
      ),
    };
  }).pipe(Effect.mapError(storeError()), Effect.withSpan("BotService.list"));

  const subscribeList: BotService["Service"]["subscribeList"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so a change during the first read is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
        );
      }),
    );

  const learningNotices = Effect.fn("BotService.learningNotices")(function* (
    input: BotLearningNoticesInput,
  ) {
    const rows = yield* store.listLearning(input.botId);
    const attachedContexts = (yield* store.listContexts(input.botId)).filter(
      (context) => context.detached_at === null,
    );
    const attached = new Set(attachedContexts.map((context) => context.project_id));
    // Read as of the change itself, so later chatting, detaching or deleting never moves it.
    const cutoffs = [
      ...new Set(
        rows
          .filter((row) => row.project_id === null && !attached.has(row.learned_in_project_id))
          .map((row) => row.created_at),
      ),
    ].sort();
    const fallback = yield* mostActiveHomesAt(attachedContexts, cutoffs);
    const suggested = new Set<string>(
      BotLearning.currentSuggestions(
        rows,
        yield* store.listLearningSuggestions(input.botId),
        attachedContexts,
      )
        .filter((suggestion) => suggestion.dismissedAt === null)
        .map((suggestion) => suggestion.entryId),
    );
    return yield* BotLearningNotices.forHome(
      rows,
      input.projectId,
      { attached, fallback },
      suggested,
    );
  }, Effect.mapError(storeError()));

  /**
   * For each cutoff, the Home where the user wrote last up to then; a tie goes to the Home
   * attached last. Agent and maintenance prompts do not count. One read, swept in time order.
   */
  const mostActiveHomesAt = Effect.fn("BotService.mostActiveHomesAt")(function* (
    contexts: ReadonlyArray<BotStore.BotContextRow>,
    cutoffs: ReadonlyArray<string>,
  ) {
    const fallback = new Map<string, string | null>();
    const last = cutoffs.at(-1);
    if (last === undefined) return fallback;
    const messages =
      contexts.length === 0
        ? []
        : yield* main<{ readonly thread_id: string; readonly created_at: string }>`
            SELECT thread_id, created_at FROM orchestration_v2_projection_messages
            WHERE thread_id IN ${main.in(contexts.map((context) => context.home_thread_id))}
              AND role = 'user' AND json_extract(payload_json, '$.createdBy') = 'user'
              AND created_at <= ${last}
            ORDER BY created_at`;
    const lastAt = new Map<string, string>();
    let next = 0;
    for (const cutoff of cutoffs) {
      for (; next < messages.length && messages[next]!.created_at <= cutoff; next++)
        lastAt.set(messages[next]!.thread_id, messages[next]!.created_at);
      let latest: { readonly projectId: string; readonly at: string } | null = null;
      for (const context of contexts) {
        const at = lastAt.get(context.home_thread_id) ?? "";
        if (latest === null || at >= latest.at) latest = { projectId: context.project_id, at };
      }
      fallback.set(cutoff, latest?.projectId ?? null);
    }
    return fallback;
  });

  // A change to another project's entries leaves this Home's notices as they were; skip resending.
  const subscribeLearningNotices: BotService["Service"]["subscribeLearningNotices"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(learningChanges);
        return Stream.concat(
          Stream.fromEffect(learningNotices(input)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((botId) => botId === input.botId),
            Stream.mapEffect(() => learningNotices(input)),
          ),
        );
      }),
    ).pipe(Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)));

  const create: BotService["Service"]["create"] = Effect.fn("BotService.create")(function* (input) {
    yield* botTasks.requireSupportedModel(input);
    const now = yield* nowIso;
    const row = BotStore.botRow({
      ...input,
      appearanceJson: BotStore.encodeAppearance(input.appearance ?? null),
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    const existing = yield* store
      .getBot(input.botId)
      .pipe(Effect.mapError(storeError(input.botId)));
    if (existing !== undefined) {
      const sameRequest =
        existing.name === row.name &&
        existing.instructions === row.instructions &&
        existing.model_selection_json === row.model_selection_json &&
        existing.learning_policy === row.learning_policy &&
        existing.appearance_json === row.appearance_json;
      if (!sameRequest) return yield* botError("A Bot with this id already exists.", input.botId)();
      return yield* readDetail(input.botId);
    }
    yield* store.insertBot(row).pipe(Effect.mapError(storeError(input.botId)));
    yield* notifyChanged;
    return yield* readDetail(input.botId);
  });

  const update: BotService["Service"]["update"] = Effect.fn("BotService.update")(function* (input) {
    const bot = yield* requireActiveBot(input.botId);
    const current = yield* readDetail(input.botId);
    if (input.modelSelection !== undefined) {
      const modelSelection = input.modelSelection;
      yield* botTasks.requireSupportedModel({ botId: input.botId, modelSelection });
      // Home threads follow the Bot through the normal thread switch path.
      const commandSuffix = yield* random
        .uuidV4()
        .pipe(Effect.mapError(botError("Failed to allocate a command id.", input.botId)));
      const attached = [...current.projects, ...(current.home == null ? [] : [current.home])]
        .filter((home) => home.detachedAt === null)
        .map((home) => home.homeThreadId);
      yield* Effect.forEach(
        attached,
        (homeThreadId) =>
          threads.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make(`bot-model:${commandSuffix}:${homeThreadId}`),
            threadId: homeThreadId,
            modelSelection,
          }),
        { discard: true },
      ).pipe(
        Effect.mapError((cause) =>
          botError(
            `Failed to switch a Bot conversation: ${errorMessage(cause)}`,
            input.botId,
          )(cause),
        ),
      );
    }
    const now = yield* nowIso;
    yield* store
      .updateBot(
        BotStore.botRow({
          botId: input.botId,
          name: input.name ?? current.name,
          instructions: input.instructions ?? current.instructions,
          modelSelection: input.modelSelection ?? current.modelSelection,
          learningPolicy: input.learningPolicy ?? current.learningPolicy,
          ...(input.taskLimit === undefined ? {} : { taskLimit: input.taskLimit }),
          appearanceJson:
            input.appearance === undefined
              ? bot.appearance_json
              : BotStore.encodeAppearance(input.appearance),
          createdAt: bot.created_at,
          updatedAt: now,
          archivedAt: null,
        }),
      )
      .pipe(Effect.mapError(storeError(input.botId)));
    yield* notifyChanged;
    return yield* readDetail(input.botId);
  });

  const setArchived: BotService["Service"]["setArchived"] = Effect.fn("BotService.setArchived")(
    function* (input) {
      const bot = yield* store.getBot(input.botId).pipe(Effect.mapError(storeError(input.botId)));
      if (bot === undefined) return yield* botError("Bot not found.", input.botId)();
      const now = yield* nowIso;
      const sync = input.archived ? "archive" : "unarchive";
      const changed = (bot.archived_at !== null) !== input.archived;
      const attached = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const contexts = [
              ...(yield* store.listContexts(input.botId)),
              ...(yield* store.listHomes(input.botId)),
            ].filter((context) => context.detached_at === null);
            if (input.archived) yield* revokeHomeReturns(input.botId);
            if (!changed) return contexts;
            yield* store.updateBot({
              ...bot,
              archived_at: input.archived ? now : null,
              updated_at: now,
            });
            const next = contexts.map((context) => ({
              ...context,
              revision: context.revision + 1,
              thread_sync: sync,
              updated_at: now,
            }));
            yield* Effect.forEach(next, store.upsertContext, { discard: true });
            return next;
          }),
        )
        .pipe(Effect.mapError(storeError(input.botId)));
      if (changed) yield* notifyChanged;
      if (input.archived) yield* stopWork(input.botId);
      // A repeated request finishes a transition an earlier one left pending.
      yield* syncThreads(input.botId, attached);
      return yield* readDetail(input.botId);
    },
  );

  // Orders grant saves with changes to the Calendar (this Mac) selection, which validate against it.
  const macCalendarLock = yield* Semaphore.make(1);
  const setMcpGrants: BotService["Service"]["setMcpGrants"] = Effect.fn("BotService.setMcpGrants")(
    function* (input) {
      const { mcpConnections: catalog, macCalendar } = yield* serverSettings.getSettings.pipe(
        Effect.mapError(botError("Could not read MCP connections.", input.botId)),
      );
      const connectionIds = [...new Set(input.connectionIds)];
      if (
        input.calendarIds?.some((id) => !macCalendar.calendars.some((entry) => entry.id === id))
      ) {
        return yield* botError(
          `One of these calendars is no longer selected for ${MAC_CALENDAR_LABEL}. Reload and try again.`,
          input.botId,
        )();
      }
      // Calendar (this Mac) is built in, and only a Mac has it.
      const calendarHere = (yield* HostProcess.Platform) === "darwin";
      // Removed connections are never granted anew; only a stale row left by removal survives.
      if (
        connectionIds.some(
          (id) => catalog[id] === undefined && !(id === MAC_CALENDAR_CONNECTION_ID && calendarHere),
        )
      ) {
        return yield* botError(
          "One of these MCP connections no longer exists. Reload and try again.",
          input.botId,
        )();
      }
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const bot = yield* requireActiveBot(input.botId);
            const current = (yield* store.listMcpGrants(input.botId)).get(input.botId);
            if (current?.revision !== input.expectedRevision) {
              return yield* botError(
                "This Bot's MCP connections changed since you opened them. Review them and try again.",
                input.botId,
              )();
            }
            const ownCodexMcpServers =
              input.ownCodexMcpServers ?? current.ownCodexMcpServers === true;
            // Removing grants and turning the switch off stay possible on every model.
            if (connectionIds.length > 0 || ownCodexMcpServers) {
              const { instanceId } = yield* BotStore.decodeModelSelection(bot.model_selection_json);
              const support = BotProviderSupport.botDriverSupport(
                (yield* providerInstances.getInstance(instanceId))?.driverKind,
              );
              if (!support.mcpGrants) {
                return yield* botError(
                  `${bot.name} can't load MCP connections or your own MCP servers on its model yet. Switch it to a Codex model first.`,
                  input.botId,
                )();
              }
              if (ownCodexMcpServers && !support.ownMcpServers) {
                return yield* botError(
                  `${bot.name} can't load your own Codex MCP servers on its model. Switch it to a Codex model first.`,
                  input.botId,
                )();
              }
            }
            yield* store.replaceMcpGrants({
              botId: input.botId,
              connectionIds,
              ownCodexMcpServers,
              levels: connectionIds.includes(MAC_CALENDAR_CONNECTION_ID)
                ? {
                    [MAC_CALENDAR_CONNECTION_ID]:
                      input.levels?.[MAC_CALENDAR_CONNECTION_ID] ?? ("read" as const),
                  }
                : {},
              calendarIds:
                input.calendarIds === undefined
                  ? current.calendarIds
                  : input.calendarIds === null
                    ? undefined
                    : [...new Set(input.calendarIds)],
            });
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "BotError" ? cause : storeError(input.botId)(cause),
          ),
        );
      yield* notifyChanged;
      return yield* readDetail(input.botId);
    },
    (effect) => macCalendarLock.withPermits(1)(effect),
  );

  const forgetMcpConnection: BotService["Service"]["forgetMcpConnection"] = Effect.fn(
    "BotService.forgetMcpConnection",
  )(function* (connectionId) {
    const affected = yield* store
      .forgetMcpConnection(connectionId)
      .pipe(Effect.mapError(storeError()));
    if (affected.length > 0) yield* notifyChanged;
  });

  const forgetMacCalendars: BotService["Service"]["forgetMacCalendars"] = Effect.fn(
    "BotService.forgetMacCalendars",
  )(function* (calendarIds) {
    const affected = yield* store
      .forgetMacCalendars(calendarIds)
      .pipe(Effect.mapError(storeError()));
    if (affected.length > 0) yield* notifyChanged;
  });

  const attachProject: BotService["Service"]["attachProject"] = Effect.fn(
    "BotService.attachProject",
  )(function* (input) {
    if (isBotHomeProjectId(input.projectId)) {
      return yield* botError(
        "This project holds a Bot's own Home. Attach the Bot to one of your projects instead.",
        input.botId,
      )();
    }
    return yield* attachContext({ ...input, kind: "project" });
  });

  const openHome: BotService["Service"]["openHome"] = Effect.fn("BotService.openHome")(
    function* (input) {
      yield* requireActiveBot(input.botId);
      const { projectId } = yield* homeFolders
        .ensureProject(input.botId)
        .pipe(Effect.mapError((cause) => botError(cause.message, input.botId)(cause)));
      if (input.access !== undefined) {
        const [home] = yield* store
          .listHomes(input.botId)
          .pipe(Effect.mapError(storeError(input.botId)));
        if (home !== undefined) {
          // Changing the access of an existing Home must not reopen one another client removed.
          const changed = yield* store
            .setOpenHomeAccess(input.botId, input.access)
            .pipe(Effect.mapError(storeError(input.botId)));
          if (!changed) {
            return yield* botError(
              "This Bot's own Home was removed. Reopen it before changing its access.",
              input.botId,
            )();
          }
          yield* notifyChanged;
          return yield* readDetail(input.botId);
        }
        yield* store
          .setHomeAccess(input.botId, input.access)
          .pipe(Effect.mapError(storeError(input.botId)));
      }
      return yield* attachContext({
        botId: input.botId,
        projectId,
        kind: "bot",
        refuseReattach: input.access !== undefined,
      });
    },
  );

  /** Attaches a project Home or the Bot-level Home, or reattaches a detached one. */
  const attachContext = Effect.fn("BotService.attachContext")(function* (
    input: BotAttachProjectInput & {
      readonly kind: BotStore.BotContextKind;
      /** Set when opening with an access: a Home removed meanwhile stays removed. */
      readonly refuseReattach?: boolean;
    },
  ) {
    const result = yield* guard.withProjectLock(
      input.projectId,
      Effect.gen(function* () {
        const bot = yield* requireActiveBot(input.botId);
        const project = Option.getOrUndefined(
          yield* projects
            .getById(input.projectId)
            .pipe(Effect.mapError(botError("Failed to read the project.", input.botId))),
        );
        if (project === undefined || project.deletedAt !== null) {
          return yield* botError("Project not found.", input.botId)();
        }
        const existing = yield* store
          .getContext(input.botId, input.projectId)
          .pipe(Effect.mapError(storeError(input.botId)));
        const now = yield* nowIso;
        if (existing === undefined) {
          const detail = yield* readDetail(input.botId);
          const homeThreadId = botHomeThreadId(input.botId, input.projectId);
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError(botError("Failed to read settings.", input.botId)),
          );
          // The thread comes first: a crash before the row leaves an ordinary
          // thread that the retried attach adopts through the same command id.
          yield* threadLaunch
            .launch({
              commandId: CommandId.make(`bot-attach:${homeThreadId}`),
              threadId: homeThreadId,
              projectId: input.projectId,
              title: bot.name,
              modelSelection: detail.modelSelection,
              runtimeMode: resolveProjectSettings(settings, input.projectId, project).settings
                .defaultRuntimeMode,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              workspaceStrategy: { type: "root" },
              createdBy: "user",
              creationSource: "server",
            })
            .pipe(
              Effect.mapError((cause) =>
                botError(
                  `Failed to start the Bot conversation: ${errorMessage(cause)}`,
                  input.botId,
                )(cause),
              ),
            );
          yield* store
            .upsertContext({
              home_thread_id: homeThreadId,
              bot_id: input.botId,
              project_id: input.projectId,
              kind: input.kind,
              guidance: input.guidance ?? "",
              sources_json: BotStore.encodeSources(input.sources ?? []),
              revision: 0,
              thread_sync: null,
              attached_at: now,
              detached_at: null,
              updated_at: now,
            })
            .pipe(Effect.mapError(storeError(input.botId)));
          return undefined;
        }
        const reattach = existing.detached_at !== null;
        if (reattach && input.refuseReattach === true) {
          return yield* botError(
            "This Bot's own Home was removed. Reopen it before changing its access.",
            input.botId,
          )();
        }
        const next: BotStore.BotContextRow = {
          ...existing,
          guidance: input.guidance ?? existing.guidance,
          sources_json:
            input.sources === undefined
              ? existing.sources_json
              : BotStore.encodeSources(input.sources),
          revision: reattach ? existing.revision + 1 : existing.revision,
          thread_sync: reattach ? "unarchive" : existing.thread_sync,
          attached_at: reattach ? now : existing.attached_at,
          detached_at: null,
          updated_at: now,
        };
        yield* store.upsertContext(next).pipe(Effect.mapError(storeError(input.botId)));
        return next;
      }),
    );
    yield* notifyChanged;
    // Which Home shows a shared change from a detached one depends on what is attached.
    yield* PubSub.publish(learningChanges, input.botId);
    if (result !== undefined) {
      yield* syncThreads(input.botId, [result]);
      // Model changes skip detached conversations, so a reattach catches them up.
      yield* followBotModel(input.botId, ThreadId.make(result.home_thread_id));
    }
    return yield* readDetail(input.botId);
  });

  const followBotModel = Effect.fn("BotService.followBotModel")(function* (
    botId: BotId,
    homeThreadId: ThreadId,
  ) {
    const detail = yield* readDetail(botId);
    const shell = yield* threads
      .getThreadShell(homeThreadId)
      .pipe(Effect.mapError(botError("Failed to read the Bot conversation.", botId)));
    if (
      shell === null ||
      BotStore.encodeModelSelection(shell.modelSelection) ===
        BotStore.encodeModelSelection(detail.modelSelection)
    ) {
      return;
    }
    const commandSuffix = yield* random
      .uuidV4()
      .pipe(Effect.mapError(botError("Failed to allocate a command id.", botId)));
    yield* threads
      .dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`bot-model:${commandSuffix}:${homeThreadId}`),
        threadId: homeThreadId,
        modelSelection: detail.modelSelection,
      })
      .pipe(
        Effect.mapError((cause) =>
          botError(`Failed to switch the Bot conversation: ${errorMessage(cause)}`, botId)(cause),
        ),
      );
  });

  const updateProjectContext: BotService["Service"]["updateProjectContext"] = Effect.fn(
    "BotService.updateProjectContext",
  )(function* (input) {
    yield* requireActiveBot(input.botId);
    const existing = yield* store
      .getContext(input.botId, input.projectId)
      .pipe(Effect.mapError(storeError(input.botId)));
    if (existing === undefined || existing.detached_at !== null || existing.kind === "bot") {
      return yield* botError("The Bot is not attached to this project.", input.botId)();
    }
    yield* store
      .upsertContext({
        ...existing,
        guidance: input.guidance ?? existing.guidance,
        sources_json:
          input.sources === undefined
            ? existing.sources_json
            : BotStore.encodeSources(input.sources),
        updated_at: yield* nowIso,
      })
      .pipe(Effect.mapError(storeError(input.botId)));
    yield* notifyChanged;
    return yield* readDetail(input.botId);
  });

  const detachProject: BotService["Service"]["detachProject"] = Effect.fn(
    "BotService.detachProject",
  )(function* (input) {
    const existing = yield* store
      .getContext(input.botId, input.projectId)
      .pipe(Effect.mapError(storeError(input.botId)));
    if (existing === undefined) {
      return yield* botError("The Bot is not attached to this project.", input.botId)();
    }
    if (existing.kind === "bot") {
      return yield* botError(
        "This project holds the Bot's own Home. Remove the Home instead.",
        input.botId,
      )();
    }
    return yield* detachContext(existing, stopWork(input.botId, input.projectId));
  });

  const removeHome: BotService["Service"]["removeHome"] = Effect.fn("BotService.removeHome")(
    function* (input) {
      const [existing] = yield* store
        .listHomes(input.botId)
        .pipe(Effect.mapError(storeError(input.botId)));
      if (existing === undefined) {
        return yield* botError("This Bot has no Home of its own.", input.botId)();
      }
      return yield* detachContext(
        existing,
        botTasks.cancelForContext({
          botId: input.botId,
          homeThreadId: ThreadId.make(existing.home_thread_id),
        }),
      );
    },
  );

  /** Detaches a Home, runs `stop` for the work it owns and archives its thread. */
  const detachContext = Effect.fn("BotService.detachContext")(function* (
    existing: BotStore.BotContextRow,
    stop: Effect.Effect<void, BotError>,
  ) {
    const input = {
      botId: BotId.make(existing.bot_id),
      projectId: ProjectId.make(existing.project_id),
    };
    const now = yield* nowIso;
    const next: BotStore.BotContextRow =
      existing.detached_at !== null
        ? existing
        : {
            ...existing,
            revision: existing.revision + 1,
            thread_sync: "archive",
            detached_at: now,
            updated_at: now,
          };
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (next !== existing) yield* store.upsertContext(next);
          yield* revokeHomeReturns(input.botId, input.projectId);
        }),
      )
      .pipe(Effect.mapError(storeError(input.botId)));
    if (next !== existing) {
      yield* notifyChanged;
      yield* PubSub.publish(learningChanges, input.botId);
    }
    yield* stop;
    yield* syncThreads(input.botId, [next]);
    return yield* readDetail(input.botId);
  });

  const resolveProject: BotService["Service"]["resolveProject"] = Effect.fn(
    "BotService.resolveProject",
  )(function* (input) {
    if (input.projectId !== undefined && isBotHomeProjectId(input.projectId)) {
      return yield* botError(
        "Tasks run in one of the Bot's attached projects, never in its own Home's project.",
        input.botId,
      )();
    }
    const detail = yield* readDetail(input.botId);
    const attached = detail.projects.filter((project) => project.detachedAt === null);
    if (input.projectId !== undefined) {
      const match = attached.find((project) => project.projectId === input.projectId);
      if (match === undefined) {
        return yield* botError("The Bot is not attached to this project.", input.botId)();
      }
      return match;
    }
    const [only, ...others] = attached;
    if (only === undefined) {
      return yield* botError("The Bot is not attached to any project.", input.botId)();
    }
    if (others.length > 0) {
      return yield* botError(
        `The Bot serves several projects; choose one: ${attached.map((project) => project.projectId).join(", ")}.`,
        input.botId,
      )();
    }
    return only;
  });

  const scopeOfThread: BotService["Service"]["scopeOfThread"] = Effect.fn(
    "BotService.scopeOfThread",
  )(function* (threadId) {
    const result = yield* turnContext.forThread(threadId).pipe(Effect.mapError(storeError()));
    return result._tag === "none"
      ? undefined
      : result._tag === "inactive"
        ? "inactive"
        : result.scope;
  });

  const learning = BotLearning.make({
    store,
    now: nowIso,
    newEntryId: random
      .uuidV4()
      .pipe(Effect.mapError(botError("Failed to allocate a learning entry id."))),
    taskStatus: (taskId) => botTasks.get(taskId).pipe(Effect.map((task) => task.status)),
  });
  // Revision numbers, duplicates and staleness are decided from one read of the Bot's learning.
  const learningLocks = yield* KeyedLock.make<BotId>();

  const changeLearning = <A>(
    botId: BotId,
    change: (
      bot: BotStore.BotRow,
    ) => Effect.Effect<A, BotError | BotStore.BotStoreError | SqlError.SqlError>,
  ) =>
    learningLocks
      .withLock(
        botId,
        Effect.gen(function* () {
          const bot = yield* requireActiveBot(botId);
          return yield* sql.withTransaction(
            change(bot).pipe(Effect.tap(() => learning.syncSuggestions(botId))),
          );
        }),
      )
      .pipe(
        Effect.catchTags({
          BotStoreError: storeError(botId),
          SqlError: storeError(botId),
        }),
        Effect.tap(() => notifyChanged),
        Effect.tap(() => PubSub.publish(learningChanges, botId)),
      );

  const recordLearning: BotService["Service"]["recordLearning"] = Effect.fn(
    "BotService.recordLearning",
  )(function* (input) {
    const learned = yield* changeLearning(input.botId, (bot) =>
      Effect.gen(function* () {
        const context = yield* store.getContext(input.botId, input.projectId);
        if (context === undefined || context.detached_at !== null) {
          return yield* botError("The Bot is not attached to this project.", input.botId)();
        }
        if (!isLearningPolicy(bot.learning_policy)) {
          return yield* botError("The Bot's learning policy is unreadable.", input.botId)();
        }
        return yield* learning.record(bot.learning_policy, input);
      }),
    );
    return { bot: yield* readDetail(input.botId), learned };
  });

  const maintainLearning: BotService["Service"]["maintainLearning"] = (scope, change) =>
    changeLearning(scope.botId, (bot) =>
      Effect.gen(function* () {
        const context = yield* store.getContext(scope.botId, scope.projectId);
        if (context === undefined || context.detached_at !== null) {
          return yield* botError("The Bot is not attached to this project.", scope.botId)();
        }
        if (!isLearningPolicy(bot.learning_policy)) {
          return yield* botError("The Bot's learning policy is unreadable.", scope.botId)();
        }
        const rows = yield* store.listLearning(scope.botId);
        return yield* change({
          policy: bot.learning_policy,
          bot,
          context,
          rows,
          record: learning.record,
          reinforce: learning.reinforce,
          suggest: learning.suggest,
        });
      }),
    ).pipe(Effect.withSpan("BotService.maintainLearning"));

  const decideLearning: BotService["Service"]["decideLearning"] = Effect.fn(
    "BotService.decideLearning",
  )(function* (input) {
    yield* changeLearning(input.botId, () => learning.decide(input));
    return yield* readDetail(input.botId);
  });

  const retireLearning: BotService["Service"]["retireLearning"] = Effect.fn(
    "BotService.retireLearning",
  )(function* (input) {
    yield* changeLearning(input.botId, () => learning.retire(input));
    return yield* readDetail(input.botId);
  });

  const decideLearningSuggestion: BotService["Service"]["decideLearningSuggestion"] = Effect.fn(
    "BotService.decideLearningSuggestion",
  )(function* (input) {
    yield* changeLearning(input.botId, (bot) =>
      isLearningPolicy(bot.learning_policy)
        ? learning.decideSuggestion(bot.learning_policy, input)
        : botError("The Bot's learning policy is unreadable.", input.botId)(),
    );
    return yield* readDetail(input.botId);
  });

  const restoreLearning: BotService["Service"]["restoreLearning"] = Effect.fn(
    "BotService.restoreLearning",
  )(function* (input) {
    yield* changeLearning(input.botId, () => learning.restore(input));
    return yield* readDetail(input.botId);
  });

  const syncPending = store.pendingThreadSyncs.pipe(
    Effect.flatMap((pending) =>
      Effect.forEach(
        pending,
        (context) =>
          syncThread(context).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Bot conversation sync failed", {
                homeThreadId: context.home_thread_id,
                cause,
              }),
            ),
          ),
        { discard: true },
      ),
    ),
  );
  yield* scheduler.register("bot-thread-sync", syncPending);

  const reconcileTaskLearning: BotService["Service"]["reconcileTaskLearning"] = Effect.gen(
    function* () {
      const rows = yield* store.listLearning().pipe(Effect.mapError(storeError()));
      const waiting = new Map<string, { readonly botId: BotId; readonly taskId: BotTaskId }>();
      for (const row of rows) {
        if (row.status !== "pending") continue;
        const source = yield* BotStore.learningSourceOf(row).pipe(Effect.mapError(storeError()));
        if (source.kind !== "task") continue;
        waiting.set(`${row.bot_id}\u0000${source.taskId}`, {
          botId: BotId.make(row.bot_id),
          taskId: source.taskId,
        });
      }
      yield* Effect.forEach(
        waiting.values(),
        ({ botId, taskId }) =>
          Effect.gen(function* () {
            const task = yield* botTasks.get(taskId);
            if (!BOT_TASK_TERMINAL_STATUSES.has(task.status)) return;
            yield* changeLearning(botId, (bot) =>
              isLearningPolicy(bot.learning_policy)
                ? learning.settleTask({
                    botId,
                    policy: bot.learning_policy,
                    taskId,
                    status: task.status,
                  })
                : botError("The Bot's learning policy is unreadable.", botId)(),
            );
          }).pipe(
            // An archived Bot keeps its waiting lessons until it is restored.
            Effect.catchCause((cause) =>
              Effect.logWarning("Bot task learning reconcile failed", { taskId, cause }),
            ),
          ),
        { discard: true },
      );
    },
  ).pipe(Effect.withSpan("BotService.reconcileTaskLearning"));

  // Task changes settle lessons at once; the scheduler covers changes missed while down.
  const taskChanges = yield* botTasks.changes;
  yield* taskChanges.pipe(
    Stream.runForEach(() => reconcileTaskLearning.pipe(Effect.ignore({ log: true }))),
    Effect.forkScoped,
  );
  yield* scheduler.register("bot-task-learning", reconcileTaskLearning);
  // The alert counts and note revisions ride on the list, so open views follow them.
  yield* Stream.merge(yield* attention.changes, yield* continuation.changes).pipe(
    Stream.runForEach(() => notifyChanged),
    Effect.forkScoped,
  );

  return BotService.of({
    list,
    subscribeList,
    subscribeLearningNotices,
    get: Effect.fn("BotService.get")(function* (input: BotGetInput) {
      return yield* readDetail(input.botId);
    }),
    create,
    update,
    setArchived,
    setMcpGrants,
    forgetMcpConnection,
    forgetMacCalendars,
    withMacCalendarLock: macCalendarLock.withPermits(1),
    attachProject,
    updateProjectContext,
    detachProject,
    openHome,
    removeHome,
    resolveProject,
    scopeOfThread,
    writeOwnerOfThread: Effect.fn("BotService.writeOwnerOfThread")(function* (threadId) {
      const access = yield* turnContext
        .mcpAccessForThreadId(threadId)
        .pipe(Effect.mapError(storeError()));
      if (access._tag === "refused") return yield* new BotError({ message: access.message });
      return access._tag === "bot" ? access.botId : undefined;
    }),
    recordLearning,
    decideLearning,
    retireLearning,
    restoreLearning,
    decideLearningSuggestion,
    reconcileTaskLearning,
    maintainLearning,
  });
});

export const layer = Layer.effect(BotService, make).pipe(
  Layer.provide(
    Layer.mergeAll(BotStore.layer, BotTurnContext.layer, BotAttention.layer, BotContinuation.layer),
  ),
);
