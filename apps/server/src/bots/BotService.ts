import {
  BOT_HOME_THREAD_ID_PREFIX,
  type BotAttachProjectInput,
  type BotCreateInput,
  type BotDetachProjectInput,
  type BotDetail,
  BotError,
  type BotGetInput,
  type BotId,
  type BotListResult,
  type BotSetArchivedInput,
  type BotUpdateInput,
  type BotUpdateProjectContextInput,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotProjectGuard from "./BotProjectGuard.ts";
import * as BotStore from "./BotStore.ts";

/** The only driver whose adapter delivers Bot instructions on every turn so far. */
const BOT_SUPPORTED_DRIVER = "codex";

export class BotService extends Context.Service<
  BotService,
  {
    readonly list: Effect.Effect<BotListResult, BotError>;
    readonly subscribeList: () => Stream.Stream<BotListResult, BotError>;
    readonly get: (input: BotGetInput) => Effect.Effect<BotDetail, BotError>;
    readonly create: (input: BotCreateInput) => Effect.Effect<BotDetail, BotError>;
    readonly update: (input: BotUpdateInput) => Effect.Effect<BotDetail, BotError>;
    readonly setArchived: (input: BotSetArchivedInput) => Effect.Effect<BotDetail, BotError>;
    readonly attachProject: (input: BotAttachProjectInput) => Effect.Effect<BotDetail, BotError>;
    readonly updateProjectContext: (
      input: BotUpdateProjectContextInput,
    ) => Effect.Effect<BotDetail, BotError>;
    readonly detachProject: (input: BotDetachProjectInput) => Effect.Effect<BotDetail, BotError>;
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

const errorMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message !== "" ? cause.message : String(cause);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* BotStore.BotStore;
  const guard = yield* BotProjectGuard.BotProjectGuard;
  const projects = yield* ProjectService.ProjectService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const scheduler = yield* Scheduler.Scheduler;
  const crypto = yield* Crypto.Crypto;
  // Subscribers re-read the full list, so only the newest change signal matters.
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const syncLocks = yield* KeyedLock.make<ThreadId>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const storeError = (botId?: BotId) => botError("Bot storage failed.", botId);

  const readDetail = Effect.fn("BotService.readDetail")(function* (botId: BotId) {
    const bot = yield* store.getBot(botId).pipe(Effect.mapError(storeError(botId)));
    if (bot === undefined) return yield* botError("Bot not found.", botId)();
    const contexts = yield* store.listContexts(botId).pipe(Effect.mapError(storeError(botId)));
    return yield* BotStore.toDetail(bot, contexts).pipe(Effect.mapError(storeError(botId)));
  });

  const requireActiveBot = Effect.fn("BotService.requireActiveBot")(function* (botId: BotId) {
    const bot = yield* store.getBot(botId).pipe(Effect.mapError(storeError(botId)));
    if (bot === undefined) return yield* botError("Bot not found.", botId)();
    if (bot.archived_at !== null) {
      return yield* botError("This Bot is archived. Restore it first.", botId)();
    }
    return bot;
  });

  const requireSupportedSelection = Effect.fn("BotService.requireSupportedSelection")(function* (
    botId: BotId,
    modelSelection: ModelSelection,
  ) {
    const instance = yield* providerInstances.getInstance(modelSelection.instanceId);
    if (instance === undefined) {
      return yield* botError(
        `Provider instance ${modelSelection.instanceId} is not configured.`,
        botId,
      )();
    }
    if (instance.driverKind !== BOT_SUPPORTED_DRIVER) {
      return yield* botError("Bots currently support Codex providers only.", botId)();
    }
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

  const syncThreads = (botId: BotId, contexts: ReadonlyArray<BotStore.BotContextRow>) =>
    Effect.forEach(contexts, syncThread, { discard: true }).pipe(
      Effect.mapError((cause) =>
        botError(`Failed to update the Bot conversation: ${errorMessage(cause)}`, botId)(cause),
      ),
    );

  const list: BotService["Service"]["list"] = Effect.gen(function* () {
    const bots = yield* store.listBots;
    const contexts = yield* store.listContexts();
    const details = yield* Effect.forEach(bots, (bot) =>
      BotStore.toDetail(
        bot,
        contexts.filter((context) => context.bot_id === bot.bot_id),
      ),
    );
    return {
      bots: details.map(({ instructions: _instructions, projects: botProjects, ...bot }) => ({
        ...bot,
        projects: botProjects.map((project) => ({
          projectId: project.projectId,
          homeThreadId: project.homeThreadId,
          attachedAt: project.attachedAt,
          detachedAt: project.detachedAt,
        })),
      })),
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

  const create: BotService["Service"]["create"] = Effect.fn("BotService.create")(function* (input) {
    yield* requireSupportedSelection(input.botId, input.modelSelection);
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
      yield* requireSupportedSelection(input.botId, modelSelection);
      // Home threads follow the Bot through the normal thread switch path.
      const commandSuffix = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError(botError("Failed to allocate a command id.", input.botId)));
      const attached = current.projects.filter((project) => project.detachedAt === null);
      yield* Effect.forEach(
        attached,
        (project) =>
          threads.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make(`bot-model:${commandSuffix}:${project.homeThreadId}`),
            threadId: project.homeThreadId,
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
            const contexts = (yield* store.listContexts(input.botId)).filter(
              (context) => context.detached_at === null,
            );
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
      // A repeated request finishes a transition an earlier one left pending.
      yield* syncThreads(input.botId, attached);
      return yield* readDetail(input.botId);
    },
  );

  const attachProject: BotService["Service"]["attachProject"] = Effect.fn(
    "BotService.attachProject",
  )(function* (input) {
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
    const commandSuffix = yield* crypto
      .randomUUIDv4()
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
    if (existing === undefined || existing.detached_at !== null) {
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
    if (next !== existing) {
      yield* store.upsertContext(next).pipe(Effect.mapError(storeError(input.botId)));
      yield* notifyChanged;
    }
    yield* syncThreads(input.botId, [next]);
    return yield* readDetail(input.botId);
  });

  const resolveProject: BotService["Service"]["resolveProject"] = Effect.fn(
    "BotService.resolveProject",
  )(function* (input) {
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

  return BotService.of({
    list,
    subscribeList,
    get: Effect.fn("BotService.get")(function* (input: BotGetInput) {
      return yield* readDetail(input.botId);
    }),
    create,
    update,
    setArchived,
    attachProject,
    updateProjectContext,
    detachProject,
    resolveProject,
  });
});

export const layer = Layer.effect(BotService, make).pipe(Layer.provide(BotStore.layer));
