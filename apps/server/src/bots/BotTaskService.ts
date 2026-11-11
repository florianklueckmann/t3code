import {
  BOT_TASK_TERMINAL_STATUSES,
  BOT_WORK_THREAD_ID_PREFIX,
  type BotCancelTaskInput,
  BotError,
  type BotId,
  type BotStartTaskInput,
  BotTaskId,
  type BotTaskResult,
  type BotTaskResultInput,
  type BotTaskListInput,
  type BotTaskListResult,
  type BotTaskOrigin,
  type BotTaskStatus,
  BotTaskSummary,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ModelSelection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProjectId,
  type RuntimeMode,
  ThreadId,
  RunId,
} from "@t3tools/contracts";
import { invalidOptionSelections } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as BotDatabase from "./persistence/BotDatabase.ts";

import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  BOT_ROUTINE_RUNTIME_MODE,
  type BotRoutineAdmission,
  type BotRoutineOccurrence,
  BotRoutineTarget,
  type BotRoutineTargetShape,
} from "../scheduledTasks/BotRoutineTarget.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { isNoChangesTask } from "./BotExecutionConstraint.ts";
import * as BotStore from "./BotStore.ts";
import { isDirectHomeInput, latestDirectHomeInput } from "./homeReturn.ts";

const LIST_LIMIT = 50;
export const BOT_SUPPORTED_DRIVER = "codex";

interface BotTaskRow {
  readonly task_id: string;
  readonly bot_id: string;
  readonly project_id: string;
  readonly home_thread_id: string;
  readonly work_thread_id: string | null;
  readonly origin: string;
  readonly title: string;
  readonly prompt: string;
  readonly scheduled_task_id: string | null;
  readonly occurrence_key: string | null;
  readonly occurrence_due_at: string | null;
  readonly session_at: string | null;
  readonly allow_changes: number;
  readonly runtime_mode: string;
  readonly status: string;
  readonly detail: string | null;
  readonly dispatched_at: string | null;
  readonly cancel_requested_at: string | null;
  readonly result_run_id: string | null;
  readonly completed_at: string | null;
  readonly notified_at: string | null;
  readonly return_home_run_id: string | null;
  readonly return_home_message_id: string | null;
  readonly return_finished_at: string | null;
  /** Direct tasks: what the work thread runs on. Null for routines and older tasks, which follow the Bot. */
  readonly model_selection_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const decodeSummary = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...BotTaskSummary.fields,
    modelSelection: Schema.optional(Schema.fromJsonString(ModelSelection)),
  }),
);
const isBotError = Schema.is(BotError);

const isTerminal = (status: BotTaskStatus) => BOT_TASK_TERMINAL_STATUSES.has(status);

/**
 * The task's status from its work thread's persisted runs. A completed run whose background work
 * is still pending is not finished, and a stop the user asked for reads as cancelled.
 */
export function deriveTaskStatus(input: {
  readonly cancelRequested: boolean;
  readonly shell: Pick<
    OrchestrationV2ThreadShell,
    "status" | "pendingRuntimeRequest" | "pendingBackgroundTasks" | "deletedAt"
  > | null;
}): BotTaskStatus {
  const { shell } = input;
  if (shell === null || shell.deletedAt !== null) {
    return input.cancelRequested ? "cancelled" : "interrupted";
  }
  switch (shell.status) {
    case "idle":
    case "preparing":
    case "queued":
    case "starting":
      return "accepted";
    case "running":
      return shell.pendingRuntimeRequest !== null && shell.pendingRuntimeRequest.blocking !== false
        ? "waiting"
        : "running";
    case "waiting":
      return "waiting";
    case "completed":
      return (shell.pendingBackgroundTasks?.length ?? 0) > 0 ? "running" : "completed";
    // A server restart also ends runs as cancelled, so only a stop someone asked for counts.
    case "interrupted":
    case "cancelled":
      return input.cancelRequested ? "cancelled" : "interrupted";
    case "failed":
    case "rolled_back":
      return "failed";
  }
}

export interface BotTaskAwareness {
  readonly taskId: BotTaskId;
  readonly projectId: ProjectId;
  readonly workThreadId: ThreadId;
  readonly status: BotTaskStatus;
  readonly resultRunId: RunId | null;
  readonly completedAt: string | null;
}

export class BotTaskService extends Context.Service<
  BotTaskService,
  {
    /** Admits a direct request as a task in a new work thread of the Bot's project. */
    readonly start: (
      input: BotStartTaskInput,
      options?: { readonly returnToHomeFrom: ThreadId },
    ) => Effect.Effect<BotTaskSummary, BotError>;
    /** The same admission for a routine occurrence; idempotent per occurrence key. */
    readonly admitRoutine: (
      occurrence: BotRoutineOccurrence,
    ) => Effect.Effect<BotRoutineAdmission, BotError>;
    readonly requireRunnable: (input: {
      readonly botId: BotId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<{ readonly modelSelection: ModelSelection }, BotError>;
    readonly get: (taskId: BotTaskId) => Effect.Effect<BotTaskSummary, BotError>;
    /** Reads routing identity without loading prompts or saved answer content. */
    readonly getAwarenessTasks: (
      workThreadId?: ThreadId,
    ) => Effect.Effect<ReadonlyArray<BotTaskAwareness>, BotError>;
    readonly getResult: (input: BotTaskResultInput) => Effect.Effect<BotTaskResult, BotError>;
    readonly list: (input: BotTaskListInput) => Effect.Effect<BotTaskListResult, BotError>;
    readonly subscribeList: (input: BotTaskListInput) => Stream.Stream<BotTaskListResult, BotError>;
    readonly cancel: (input: BotCancelTaskInput) => Effect.Effect<BotTaskSummary, BotError>;
    /** Stops unfinished work when the Bot is archived or a project detached. */
    readonly cancelForContext: (input: {
      readonly botId: BotId;
      readonly projectId?: ProjectId | undefined;
    }) => Effect.Effect<void, BotError>;
    /** Starts admitted work a crash left, records status changes and publishes results once. */
    readonly reconcile: Effect.Effect<void, BotError>;
    /** Ids of tasks whose status changed. */
    /**
     * Subscribes now and streams the ids of tasks whose status changed, so nothing published
     * after this returns is missed. Events before it are not replayed; read the tasks after
     * subscribing to catch up.
     */
    readonly changes: Effect.Effect<Stream.Stream<BotTaskId>, never, Scope.Scope>;
  }
>()("t3/bots/BotTaskService") {}

const botError = (message: string, botId?: BotId) => (cause?: unknown) =>
  new BotError({
    message,
    ...(botId === undefined ? {} : { botId }),
    ...(cause === undefined ? {} : { cause }),
  });

const errorMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message !== "" ? cause.message : String(cause);

const isMcpUnsupported = Schema.is(RuntimePolicy.RuntimePolicyMcpUnsupportedError);

/** A launch refused because its policy can't be enforced says why, under its launch wrappers. */
const launchFailureMessage = (error: unknown): string => {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (RuntimePolicy.isRuntimePolicyUnsupportedError(current) || isMcpUnsupported(current))
      return current.message;
    if (!Predicate.hasProperty(current, "cause")) break;
    current = current.cause;
  }
  return errorMessage(error);
};

const make = Effect.gen(function* () {
  const sql = yield* BotDatabase.BotDatabase;
  const store = yield* BotStore.BotStore;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const scheduler = yield* Scheduler.Scheduler;
  const random = yield* SecureRandom.SecureRandom;
  const changes = yield* PubSub.sliding<{
    readonly taskId: BotTaskId;
    readonly workThreadId: string | null;
  }>(1024);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const storageError = botError("Bot task storage failed.");

  const toSummary = (row: BotTaskRow) =>
    decodeSummary({
      id: row.task_id,
      botId: row.bot_id,
      projectId: row.project_id,
      homeThreadId: row.home_thread_id,
      workThreadId: row.work_thread_id,
      origin: row.origin,
      title: row.title,
      scheduledTaskId: row.scheduled_task_id,
      occurrenceDueAt: row.occurrence_due_at,
      sessionAt: row.session_at,
      runtimeMode: row.runtime_mode,
      status: row.status,
      detail: row.detail,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      returnToHome: row.return_home_run_id !== null,
      ...(row.model_selection_json === null ? {} : { modelSelection: row.model_selection_json }),
      changes: isNoChangesTask(row) ? "none" : null,
    }).pipe(Effect.mapError(storageError));

  const readRow = (taskId: string) =>
    sql<BotTaskRow>`SELECT * FROM bot_tasks WHERE task_id = ${taskId}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError(storageError),
    );

  const publish = (row: Pick<BotTaskRow, "task_id" | "work_thread_id">) =>
    PubSub.publish(changes, {
      taskId: BotTaskId.make(row.task_id),
      workThreadId: row.work_thread_id,
    }).pipe(Effect.asVoid);

  /** The attached, unarchived context, or a reason the Bot cannot work there. */
  const activeContext = Effect.fn("BotTaskService.activeContext")(function* (
    botId: BotId,
    projectId: ProjectId,
  ) {
    const bot = yield* store.getBot(botId);
    if (bot === undefined) return { _tag: "inactive", reason: "Bot not found." } as const;
    if (bot.archived_at !== null) {
      return { _tag: "inactive", reason: `${bot.name} is archived.` } as const;
    }
    const context = yield* store.getContext(botId, projectId);
    if (context === undefined || context.detached_at !== null) {
      return {
        _tag: "inactive",
        reason: `${bot.name} is not attached to this project.`,
      } as const;
    }
    return { _tag: "active", bot, context } as const;
  }, Effect.mapError(storageError));

  const requireRunnable: BotTaskService["Service"]["requireRunnable"] = Effect.fn(
    "BotTaskService.requireRunnable",
  )(function* (input) {
    const context = yield* activeContext(input.botId, input.projectId);
    if (context._tag === "inactive") return yield* botError(context.reason, input.botId)();
    const detail = yield* BotStore.toDetail(context.bot, [], []).pipe(
      Effect.mapError(storageError),
    );
    return { modelSelection: detail.modelSelection };
  });

  /**
   * Stops the work thread's run. The id is keyed to that run, so a repeat replays once the stop
   * took effect, and a stop sent before the launch admitted its run cannot stand in for it.
   */
  const stopWorkThread = Effect.fn("BotTaskService.stopWorkThread")(function* (
    row: BotTaskRow,
    workThreadId: string,
  ) {
    const shell = yield* threads
      .getThreadShell(ThreadId.make(workThreadId))
      .pipe(Effect.mapError(botError("Failed to read the Bot task's work thread.")));
    if (shell === null || shell.latestRunId === null) return;
    yield* threads
      .dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`bot-task-cancel:${row.task_id}:${shell.latestRunId}`),
        threadId: ThreadId.make(workThreadId),
        reason: row.detail ?? "The Bot task was cancelled.",
      })
      .pipe(
        Effect.mapError((cause) =>
          botError(`Failed to stop the Bot task: ${errorMessage(cause)}`)(cause),
        ),
      );
  });

  /**
   * Launches the work thread. The same ids make a retried launch replay instead of duplicating.
   * A cancel can land while the launch runs, so the cancel flag is checked again after it.
   */
  const dispatch = Effect.fn("BotTaskService.dispatch")(function* (stale: BotTaskRow) {
    const row = yield* readRow(stale.task_id);
    if (row === undefined || row.completed_at !== null || row.cancel_requested_at !== null) return;
    const bot = yield* store.getBot(row.bot_id).pipe(Effect.mapError(storageError));
    if (bot === undefined || row.work_thread_id === null) return;
    const modelSelection =
      row.model_selection_json === null
        ? (yield* BotStore.toDetail(bot, [], []).pipe(Effect.mapError(storageError))).modelSelection
        : yield* BotStore.decodeModelSelection(row.model_selection_json).pipe(
            Effect.mapError(storageError),
          );
    const launched = yield* threadLaunch
      .launch({
        commandId: CommandId.make(`bot-task-launch:${row.task_id}`),
        threadId: ThreadId.make(row.work_thread_id),
        projectId: row.project_id as ProjectId,
        title: row.title,
        modelSelection,
        runtimeMode: row.runtime_mode as RuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make(`bot-task-message:${row.task_id}`),
          text: row.prompt,
          attachments: [],
        },
        createdBy: row.origin === "routine" ? "system" : "user",
        creationSource: "server",
      })
      .pipe(Effect.exit);
    const now = yield* nowIso;
    if (launched._tag === "Success") {
      yield* sql`
        UPDATE bot_tasks SET dispatched_at = ${now}, updated_at = ${now}
        WHERE task_id = ${row.task_id} AND dispatched_at IS NULL
      `.pipe(Effect.mapError(storageError));
      const after = yield* readRow(row.task_id);
      if (after?.cancel_requested_at != null) {
        yield* stopWorkThread(after, row.work_thread_id);
      }
    } else {
      // A launch that was refused is not retried: nothing broadens or repeats work on its own.
      yield* sql`
        UPDATE bot_tasks
        SET status = 'failed', detail = ${`The work thread could not start: ${launchFailureMessage(Cause.squash(launched.cause))}`},
            completed_at = ${now}, updated_at = ${now}
        WHERE task_id = ${row.task_id} AND completed_at IS NULL
      `.pipe(Effect.mapError(storageError));
    }
    yield* publish(row);
  });

  const insertTask = (row: BotTaskRow) =>
    sql`
      INSERT INTO bot_tasks (
        task_id, bot_id, project_id, home_thread_id, work_thread_id, origin, title, prompt,
        scheduled_task_id, occurrence_key, occurrence_due_at, session_at, allow_changes, runtime_mode, status,
        detail, dispatched_at, cancel_requested_at, result_run_id, completed_at, notified_at,
        created_at, updated_at, return_home_run_id, return_home_message_id, return_finished_at,
        model_selection_json
      ) VALUES (
        ${row.task_id}, ${row.bot_id}, ${row.project_id}, ${row.home_thread_id},
        ${row.work_thread_id}, ${row.origin}, ${row.title}, ${row.prompt},
        ${row.scheduled_task_id}, ${row.occurrence_key}, ${row.occurrence_due_at},
        ${row.session_at}, ${row.allow_changes}, ${row.runtime_mode}, ${row.status}, ${row.detail},
        ${row.dispatched_at}, ${row.cancel_requested_at}, ${row.result_run_id},
        ${row.completed_at}, ${row.notified_at}, ${row.created_at}, ${row.updated_at},
        ${row.return_home_run_id}, ${row.return_home_message_id}, ${row.return_finished_at},
        ${row.model_selection_json}
      )
      ON CONFLICT DO NOTHING
    `;

  const newRow = (input: {
    readonly taskId: string;
    readonly botId: string;
    readonly projectId: string;
    readonly homeThreadId: string;
    readonly origin: BotTaskOrigin;
    readonly title: string;
    readonly prompt: string;
    readonly runtimeMode: RuntimeMode;
    readonly now: string;
    readonly occurrence?: BotRoutineOccurrence;
    readonly skipReason?: string;
  }): BotTaskRow => ({
    task_id: input.taskId,
    bot_id: input.botId,
    project_id: input.projectId,
    home_thread_id: input.homeThreadId,
    work_thread_id:
      input.skipReason === undefined ? `${BOT_WORK_THREAD_ID_PREFIX}${input.taskId}` : null,
    origin: input.origin,
    title: input.title,
    prompt: input.prompt,
    scheduled_task_id: input.occurrence?.scheduledTaskId ?? null,
    occurrence_key: input.occurrence?.occurrenceKey ?? null,
    occurrence_due_at: input.occurrence?.dueAt ?? null,
    session_at: input.occurrence?.sessionAt ?? null,
    allow_changes: input.occurrence?.allowChanges ? 1 : 0,
    runtime_mode: input.runtimeMode,
    status: input.skipReason === undefined ? "accepted" : "skipped",
    detail: input.skipReason ?? null,
    dispatched_at: null,
    cancel_requested_at: null,
    result_run_id: null,
    completed_at: input.skipReason === undefined ? null : input.now,
    notified_at: null,
    return_home_run_id: null,
    return_home_message_id: null,
    return_finished_at: null,
    model_selection_json: null,
    created_at: input.now,
    updated_at: input.now,
  });

  /** A task's own selection must be one its project could start a Bot on now. */
  const requireTaskSelection = Effect.fn("BotTaskService.requireTaskSelection")(function* (
    input: BotStartTaskInput,
    selection: ModelSelection,
  ) {
    const refuse = (message: string) => botError(message, input.botId)();
    const { instanceId } = selection;
    const provider = (yield* providers.getProviders).find(
      (candidate) => candidate.instanceId === instanceId,
    );
    if (provider === undefined)
      return yield* refuse(`Provider instance ${instanceId} is not configured.`);
    if (provider.driver !== BOT_SUPPORTED_DRIVER)
      return yield* refuse("Bots currently support Codex providers only.");
    if (!provider.enabled) return yield* refuse(`Provider instance ${instanceId} is disabled.`);
    if (
      !(yield* threads.isProviderInstanceEnabledForProject({
        projectId: input.projectId,
        instanceId,
      }))
    )
      return yield* refuse(`Provider instance ${instanceId} is turned off for this project.`);
    if (provider.models.length === 0)
      return yield* refuse(
        `Provider instance ${instanceId} has no model catalog. Refresh the provider before choosing a task model.`,
      );
    const model = provider.models.find((candidate) => candidate.slug === selection.model);
    if (model === undefined)
      return yield* refuse(`Model ${selection.model} is not offered by provider ${instanceId}.`);
    const problems = invalidOptionSelections(
      selection.options ?? [],
      model.capabilities?.optionDescriptors ?? [],
    );
    if (problems.length > 0)
      return yield* refuse(
        `Model ${selection.model} on provider ${instanceId} rejected options: ${problems.join(" ")}`,
      );
  });

  const start: BotTaskService["Service"]["start"] = Effect.fn("BotTaskService.start")(
    function* (input, options) {
      const suffix =
        input.commandId ??
        (yield* random
          .uuidV4()
          .pipe(Effect.mapError(botError("Failed to allocate a task id.", input.botId))));
      const taskId = `bot-task:${suffix}`;
      const existing = yield* readRow(taskId);
      if (existing !== undefined) return yield* toSummary(existing);
      const context = yield* activeContext(input.botId, input.projectId);
      if (context._tag === "inactive") return yield* botError(context.reason, input.botId)();
      if (input.modelSelection !== undefined) {
        yield* requireTaskSelection(input, input.modelSelection);
      }
      // Fixed at admission, so a restart before launch keeps what the task was started with.
      const modelSelection =
        input.modelSelection ??
        (yield* BotStore.toDetail(context.bot, [], []).pipe(Effect.mapError(storageError)))
          .modelSelection;
      // A direct request runs in the mode the user gave the Bot's conversation.
      const home = yield* threads
        .getThreadShell(ThreadId.make(context.context.home_thread_id))
        .pipe(Effect.mapError(botError("Failed to read the Bot conversation.", input.botId)));
      let returnHomeRunId: string | null = null;
      let returnHomeMessageId: string | null = null;
      if (options !== undefined) {
        if (
          options.returnToHomeFrom !== context.context.home_thread_id ||
          home === null ||
          home.id !== options.returnToHomeFrom ||
          home.projectId !== input.projectId ||
          home.deletedAt !== null ||
          home.archivedAt !== null ||
          home.status !== "running" ||
          home.activeRunId === null ||
          home.activeRunId !== home.latestRunId
        )
          return yield* botError(
            "A result can return only from the Bot's active Home user turn.",
            input.botId,
          )();
        const records = yield* threads
          .getProjectThreadRecords(
            { projectId: input.projectId, threadId: options.returnToHomeFrom },
            ["runs", "messages", "turnItems"],
            {
              runIds: [home.activeRunId],
              messageRunIds: [home.activeRunId],
              messageRoles: ["user"],
              turnItemRunIds: [home.activeRunId],
              turnItemTypes: ["user_message"],
            },
          )
          .pipe(Effect.mapError(botError("Failed to read the Home user turn.", input.botId)));
        const run = records.runs.find((candidate) => candidate.id === home.activeRunId);
        const message = records.messages.find((candidate) => candidate.id === run?.userMessageId);
        if (
          run?.status !== "running" ||
          run.threadId !== options.returnToHomeFrom ||
          !isDirectHomeInput(message)
        )
          return yield* botError(
            "Automatic turns cannot authorize another return to Home.",
            input.botId,
          )();
        const inputMessage = latestDirectHomeInput(records);
        if (inputMessage === undefined)
          return yield* botError("The direct Home input is unavailable.", input.botId)();
        returnHomeRunId = run.id;
        returnHomeMessageId = inputMessage.id;
      }
      const row = {
        ...newRow({
          taskId,
          botId: input.botId,
          projectId: input.projectId,
          homeThreadId: context.context.home_thread_id,
          origin: "direct",
          title: input.title ?? `${context.bot.name}: ${input.prompt.split("\n")[0]?.slice(0, 60)}`,
          prompt: input.prompt,
          runtimeMode: home?.runtimeMode ?? BOT_ROUTINE_RUNTIME_MODE,
          now: yield* nowIso,
        }),
        return_home_run_id: returnHomeRunId,
        return_home_message_id: returnHomeMessageId,
        model_selection_json: BotStore.encodeModelSelection(modelSelection),
      };
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            if (returnHomeRunId !== null) {
              const attached = yield* activeContext(input.botId, input.projectId);
              if (
                attached._tag === "inactive" ||
                attached.context.home_thread_id !== row.home_thread_id
              )
                return yield* botError(
                  "The Bot is no longer attached to this Home.",
                  input.botId,
                )();
              const pending = yield* sql`SELECT task_id FROM bot_tasks
            WHERE home_thread_id = ${row.home_thread_id} AND return_home_message_id = ${returnHomeMessageId}
              AND return_home_run_id IS NOT NULL AND return_finished_at IS NULL AND task_id <> ${row.task_id} LIMIT 1`;
              if (pending.length > 0)
                return yield* botError(
                  "This Home input turn already has a pending task return. Cancel it before starting another.",
                  input.botId,
                )();
            }
            yield* insertTask(row);
          }),
        )
        .pipe(Effect.mapError((cause) => (isBotError(cause) ? cause : storageError(cause))));
      yield* dispatch(row);
      return yield* get(BotTaskId.make(taskId));
    },
  );

  const admitRoutine: BotTaskService["Service"]["admitRoutine"] = Effect.fn(
    "BotTaskService.admitRoutine",
  )(function* (occurrence) {
    const taskId = `bot-task:${occurrence.occurrenceKey}`;
    const decided = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql<BotTaskRow>`
            SELECT * FROM bot_tasks WHERE occurrence_key = ${occurrence.occurrenceKey}
          `;
          if (existing[0] !== undefined) return { row: existing[0], fresh: false } as const;
          const context = yield* activeContext(occurrence.botId, occurrence.projectId);
          if (context._tag === "inactive") return { inactive: context.reason } as const;
          const now = yield* nowIso;
          const open = yield* sql<{ readonly task_id: string }>`
            SELECT task_id FROM bot_tasks
            WHERE scheduled_task_id = ${occurrence.scheduledTaskId} AND completed_at IS NULL
            LIMIT 1
          `;
          const skipReason =
            occurrence.sessionAt !== null && now >= occurrence.sessionAt
              ? "The event had already started when this routine was due."
              : open.length > 0
                ? "The previous run of this routine was still working."
                : undefined;
          const row = newRow({
            taskId,
            botId: occurrence.botId,
            projectId: occurrence.projectId,
            homeThreadId: context.context.home_thread_id,
            origin: "routine",
            title: occurrence.title,
            prompt: occurrence.prompt,
            runtimeMode: BOT_ROUTINE_RUNTIME_MODE,
            now,
            occurrence,
            ...(skipReason === undefined ? {} : { skipReason }),
          });
          yield* insertTask(row);
          return { row, fresh: true } as const;
        }),
      )
      .pipe(Effect.mapError((cause) => (isBotError(cause) ? cause : storageError(cause))));
    if ("inactive" in decided) return { _tag: "inactive", reason: decided.inactive } as const;
    const { row, fresh } = decided;
    if (fresh) {
      if (row.work_thread_id !== null) yield* dispatch(row);
      else yield* publish(row);
    }
    if (row.work_thread_id === null) {
      return { _tag: "skipped", reason: row.detail ?? "Skipped." } as const;
    }
    return { _tag: "admitted", workThreadId: ThreadId.make(row.work_thread_id) } as const;
  });

  const get: BotTaskService["Service"]["get"] = Effect.fn("BotTaskService.get")(function* (taskId) {
    const row = yield* readRow(taskId);
    if (row === undefined) return yield* botError("Bot task not found.")();
    return yield* toSummary(row);
  });

  const getAwarenessTasks = Effect.fn("BotTaskService.getAwarenessTasks")(function* (
    workThreadId?: ThreadId,
  ) {
    const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 2 }));
    const rows = yield* sql<
      Pick<
        BotTaskRow,
        "task_id" | "project_id" | "work_thread_id" | "status" | "result_run_id" | "completed_at"
      >
    >`
      SELECT task_id, project_id, work_thread_id, status, result_run_id, completed_at
      FROM bot_tasks WHERE work_thread_id IS NOT NULL
        AND ${
          workThreadId === undefined
            ? sql`(completed_at IS NULL OR completed_at >= ${cutoff})`
            : sql`work_thread_id = ${workThreadId}`
        }
    `.pipe(Effect.mapError(storageError));
    return rows.flatMap((row): BotTaskAwareness[] =>
      row.work_thread_id === null
        ? []
        : [
            {
              taskId: BotTaskId.make(row.task_id),
              projectId: ProjectId.make(row.project_id),
              workThreadId: ThreadId.make(row.work_thread_id),
              status: row.status as BotTaskStatus,
              resultRunId: row.result_run_id === null ? null : RunId.make(row.result_run_id),
              completedAt: row.completed_at,
            },
          ],
    );
  });

  const getResult: BotTaskService["Service"]["getResult"] = Effect.fn("BotTaskService.getResult")(
    function* (input) {
      const row = yield* readRow(input.taskId);
      if (row === undefined) return yield* botError("Bot task not found.")();
      const task = yield* toSummary(row);
      if (task.status !== "completed") return { task, result: { state: "not_completed" } };
      const unavailable = { task, result: { state: "unavailable" } } as const;
      if (row.result_run_id === null || task.workThreadId === null) return unavailable;
      const shell = yield* threads
        .getThreadShell(task.workThreadId)
        .pipe(Effect.mapError(botError("Failed to read the Bot task's work thread.")));
      if (shell === null || shell.deletedAt !== null) return unavailable;
      const runId = RunId.make(row.result_run_id);
      const records = yield* threads
        .getProjectThreadRecords(
          { projectId: task.projectId, threadId: task.workThreadId },
          ["runs", "messages", "turnItems"],
          {
            runIds: [runId],
            messageRoles: ["assistant"],
            messageRunIds: [runId],
            turnItemRunIds: [runId],
            turnItemTypes: ["assistant_message"],
          },
        )
        .pipe(
          Effect.catchTags({ ThreadManagementThreadNotFoundError: () => Effect.succeed(null) }),
          Effect.mapError(botError("Failed to read the Bot task's saved result.")),
        );
      if (
        records === null ||
        records.thread.id !== task.workThreadId ||
        records.thread.projectId !== task.projectId ||
        records.thread.deletedAt !== null
      )
        return unavailable;
      const run = records.runs.find(
        (candidate) => candidate.id === runId && candidate.threadId === task.workThreadId,
      );
      if (run === undefined || run.status !== "completed") return unavailable;
      const assistantItems = records.turnItems.filter(
        (item): item is Extract<OrchestrationV2TurnItem, { type: "assistant_message" }> =>
          item.threadId === task.workThreadId &&
          item.runId === runId &&
          item.type === "assistant_message",
      );
      // Older adapters did not distinguish final answers from intermediate messages.
      const classified = assistantItems.some((item) => item.responseKind !== undefined);
      const finalItem = assistantItems
        .filter((item) => !classified || item.responseKind === "final")
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      const messages = records.messages.filter(
        (message) =>
          message.threadId === task.workThreadId &&
          message.runId === runId &&
          message.role === "assistant",
      );
      // Turn item order survives providers finalizing several messages at the same timestamp.
      const message =
        finalItem === undefined && assistantItems.length === 0
          ? messages.toSorted(
              (left, right) =>
                DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
                DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
            )[0]
          : messages.find((candidate) => candidate.id === finalItem?.messageId);
      if (
        message?.streaming ||
        (finalItem !== undefined && (finalItem.streaming || finalItem.status !== "completed"))
      )
        return unavailable;
      if (message === undefined && finalItem?.textOmitted === true) return unavailable;
      const text = message?.text ?? finalItem?.text ?? "";
      return {
        task,
        result:
          text.trim() === "" ? { state: "empty", runId } : { state: "available", runId, text },
      };
    },
  );

  const list: BotTaskService["Service"]["list"] = Effect.fn("BotTaskService.list")(
    function* (input) {
      const rows = yield* sql<BotTaskRow>`
        SELECT * FROM bot_tasks
        WHERE (${input.botId ?? null} IS NULL OR bot_id = ${input.botId ?? null})
          AND (${input.projectId ?? null} IS NULL OR project_id = ${input.projectId ?? null})
          AND ${input.workThreadId === undefined ? sql`1 = 1` : sql`work_thread_id = ${input.workThreadId}`}
        ORDER BY created_at DESC, task_id DESC
        LIMIT ${LIST_LIMIT}
      `.pipe(Effect.mapError(storageError));
      return { tasks: yield* Effect.forEach(rows, toSummary) };
    },
  );

  const subscribeList: BotTaskService["Service"]["subscribeList"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so a change during the first read is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list(input)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (change) =>
                input.workThreadId === undefined || change.workThreadId === input.workThreadId,
            ),
            Stream.mapEffect(() => list(input)),
          ),
        );
      }),
    );

  const requestCancel = Effect.fn("BotTaskService.requestCancel")(function* (
    stale: BotTaskRow,
    reason: string | null,
  ) {
    const now = yield* nowIso;
    // The flag comes first: a launch still under way checks it when it returns.
    yield* sql`
      UPDATE bot_tasks
      SET cancel_requested_at = COALESCE(cancel_requested_at, ${now}),
          detail = COALESCE(${reason}, detail), updated_at = ${now}
      WHERE task_id = ${stale.task_id} AND completed_at IS NULL
    `.pipe(Effect.mapError(storageError));
    const row = yield* readRow(stale.task_id);
    if (row === undefined || row.completed_at !== null) return;
    // A launch that went through before a restart has a thread but no dispatched_at.
    const workThreadId = row.work_thread_id;
    const launched =
      workThreadId !== null &&
      (row.dispatched_at !== null ||
        (yield* threads
          .getThreadShell(ThreadId.make(workThreadId))
          .pipe(Effect.mapError(botError("Failed to read the Bot task's work thread.")))) !== null);
    if (launched) {
      yield* sql`
        UPDATE bot_tasks SET dispatched_at = COALESCE(dispatched_at, ${now})
        WHERE task_id = ${row.task_id}
      `.pipe(Effect.mapError(storageError));
      yield* stopWorkThread(row, workThreadId);
    } else {
      yield* sql`
        UPDATE bot_tasks
        SET status = 'cancelled', completed_at = ${now}, notified_at = ${now}, updated_at = ${now}
        WHERE task_id = ${row.task_id} AND completed_at IS NULL
      `.pipe(Effect.mapError(storageError));
    }
    yield* publish(row);
  });

  const cancel: BotTaskService["Service"]["cancel"] = Effect.fn("BotTaskService.cancel")(
    function* (input) {
      const row = yield* readRow(input.taskId);
      if (row === undefined) return yield* botError("Bot task not found.")();
      yield* sql`UPDATE bot_tasks SET return_home_run_id = NULL WHERE task_id = ${row.task_id}`.pipe(
        Effect.mapError(storageError),
      );
      if (row.completed_at === null) yield* requestCancel(row, null);
      yield* publish(row);
      return yield* get(input.taskId);
    },
  );

  const cancelForContext: BotTaskService["Service"]["cancelForContext"] = Effect.fn(
    "BotTaskService.cancelForContext",
  )(function* (input) {
    yield* sql`UPDATE bot_tasks SET return_home_run_id = NULL
      WHERE bot_id = ${input.botId} AND return_finished_at IS NULL
        AND (${input.projectId ?? null} IS NULL OR project_id = ${input.projectId ?? null})`.pipe(
      Effect.mapError(storageError),
    );
    const rows = yield* sql<BotTaskRow>`
      SELECT * FROM bot_tasks
      WHERE bot_id = ${input.botId} AND completed_at IS NULL
        AND (${input.projectId ?? null} IS NULL OR project_id = ${input.projectId ?? null})
    `.pipe(Effect.mapError(storageError));
    const reason =
      input.projectId === undefined
        ? "Stopped because the Bot was archived."
        : "Stopped because the Bot was detached from this project.";
    yield* Effect.forEach(rows, (row) => requestCancel(row, reason), { discard: true });
  });

  // Acquire Home before the Bot writer: Home policy resolution reads Bot state.
  const deliverResult = Effect.fn("BotTaskService.deliverResult")(function* (taskId: string) {
    const row = yield* readRow(taskId);
    if (row === undefined) return;
    if (
      row.return_home_run_id === null ||
      row.return_home_message_id === null ||
      row.return_finished_at !== null ||
      row.completed_at === null
    )
      return;
    const finish = sql`UPDATE bot_tasks SET return_finished_at = ${yield* nowIso}
      WHERE task_id = ${row.task_id} AND return_finished_at IS NULL`.pipe(
      Effect.mapError(storageError),
    );
    const context = yield* activeContext(row.bot_id as BotId, row.project_id as ProjectId);
    if (
      row.status !== "completed" ||
      row.result_run_id === null ||
      row.work_thread_id === null ||
      context._tag === "inactive" ||
      context.context.home_thread_id !== row.home_thread_id
    ) {
      yield* finish;
      return;
    }
    const otherWork = yield* sql`SELECT task_id FROM bot_tasks
      WHERE home_thread_id = ${row.home_thread_id} AND task_id <> ${row.task_id} AND completed_at IS NULL LIMIT 1`.pipe(
      Effect.mapError(storageError),
    );
    if (otherWork.length > 0) return;
    const { result } = yield* getResult({ taskId: BotTaskId.make(row.task_id) });
    if (result.state === "unavailable" || result.state === "not_completed") return;
    const text = result.state === "available" ? result.text : "The saved run has no final answer.";
    yield* threads
      .withBotResultDelivery(
        {
          type: "bot-task.result.deliver",
          commandId: CommandId.make(`bot-task-return:${row.task_id}:${row.result_run_id}`),
          threadId: ThreadId.make(row.home_thread_id),
          projectId: row.project_id as ProjectId,
          botId: row.bot_id as BotId,
          taskId: BotTaskId.make(row.task_id),
          sourceThreadId: ThreadId.make(row.work_thread_id),
          resultRunId: RunId.make(row.result_run_id),
          homeRunId: RunId.make(row.return_home_run_id),
          homeMessageId: MessageId.make(row.return_home_message_id),
          messageId: MessageId.make(`bot-task-return:${row.task_id}:${row.result_run_id}`),
          text: `Bot work run completed. Task fulfillment is unverified; existing user instructions and permissions still apply.\nTask: ${row.task_id}\nWork thread: ${row.work_thread_id}\nSaved run: ${row.result_run_id}\n\n${text.slice(0, 16000)}${text.length > 16000 ? "\n[Result truncated; the full saved result remains available on the task.]" : ""}`,
        },
        (commit) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const current = yield* readRow(taskId);
                if (
                  current === undefined ||
                  current.return_finished_at !== null ||
                  current.return_home_run_id !== row.return_home_run_id ||
                  current.return_home_message_id !== row.return_home_message_id
                )
                  return;
                const attached = yield* activeContext(
                  row.bot_id as BotId,
                  row.project_id as ProjectId,
                );
                if (
                  attached._tag === "inactive" ||
                  attached.context.home_thread_id !== row.home_thread_id
                ) {
                  yield* finish;
                  return;
                }
                const pending =
                  yield* sql`SELECT task_id FROM bot_tasks WHERE home_thread_id = ${row.home_thread_id}
            AND task_id <> ${row.task_id} AND completed_at IS NULL LIMIT 1`.pipe(
                    Effect.mapError(storageError),
                  );
                if (pending.length > 0) return;
                const delivery = yield* commit.pipe(
                  Effect.mapError(botError("Failed to return the Bot task result to Home.")),
                );
                if (delivery.deferred !== true) yield* finish;
              }),
            )
            .pipe(Effect.mapError((cause) => (isBotError(cause) ? cause : storageError(cause)))),
      )
      .pipe(
        Effect.mapError((cause) =>
          isBotError(cause)
            ? cause
            : botError("Failed to return the Bot task result to Home.")(cause),
        ),
      );
  });

  /** One step of the reconcile loop for one task; failures stay with that task. */
  const reconcileTask = Effect.fn("BotTaskService.reconcileTask")(function* (row: BotTaskRow) {
    if (row.completed_at === null) {
      const context = yield* activeContext(row.bot_id as BotId, row.project_id as ProjectId);
      if (context._tag === "inactive" && row.cancel_requested_at === null) {
        // An archive or detach that crashed before stopping its work finishes here.
        return yield* requestCancel(row, `Stopped because ${context.reason}`);
      }
      if (row.dispatched_at === null) {
        // A cancel cut short by a restart finishes here, stopping a thread the launch made.
        yield* row.cancel_requested_at === null ? dispatch(row) : requestCancel(row, null);
        return;
      }
      if (row.work_thread_id === null) return;
      const shell = yield* threads
        .getThreadShell(ThreadId.make(row.work_thread_id))
        .pipe(Effect.mapError(botError("Failed to read the Bot task's work thread.")));
      const status = deriveTaskStatus({
        cancelRequested: row.cancel_requested_at !== null,
        shell,
      });
      // A cancelled task still working gets its stop again, for one that failed or came too early.
      if (row.cancel_requested_at !== null && !isTerminal(status)) {
        yield* stopWorkThread(row, row.work_thread_id);
      }
      if (status === row.status) return;
      const now = yield* nowIso;
      const terminal = isTerminal(status);
      yield* sql`
        UPDATE bot_tasks
        SET status = ${status},
            result_run_id = ${terminal ? (shell?.latestRunId ?? null) : row.result_run_id},
            completed_at = ${terminal ? now : null},
            updated_at = ${now}
        WHERE task_id = ${row.task_id} AND completed_at IS NULL
      `.pipe(Effect.mapError(storageError));
      yield* publish(row);
      if (!terminal) return;
    }
    const current = yield* readRow(row.task_id);
    if (current === undefined || current.completed_at === null || current.notified_at !== null) {
      return;
    }
    // The result stays in the work thread; the home conversation shows its card and turns unread.
    if (current.status !== "cancelled") {
      yield* threads.dispatch({
        type: "thread.mark-unread",
        commandId: CommandId.make(`bot-task-notify:${current.task_id}`),
        threadId: ThreadId.make(current.home_thread_id),
      });
    }
    const now = yield* nowIso;
    yield* sql`
      UPDATE bot_tasks SET notified_at = ${now}
      WHERE task_id = ${current.task_id} AND notified_at IS NULL
    `.pipe(Effect.mapError(storageError));
  });

  const reconcile: BotTaskService["Service"]["reconcile"] = Effect.gen(function* () {
    const open = yield* sql<BotTaskRow>`
      SELECT * FROM bot_tasks WHERE completed_at IS NULL OR notified_at IS NULL
        OR (return_home_run_id IS NOT NULL AND return_finished_at IS NULL)
      ORDER BY created_at, task_id
    `.pipe(Effect.mapError(storageError));
    yield* Effect.forEach(
      open,
      (row) =>
        reconcileTask(row).pipe(
          Effect.andThen(deliverResult(row.task_id)),
          Effect.catchCause((cause) =>
            Effect.logWarning("Bot task reconcile failed", { taskId: row.task_id, cause }),
          ),
        ),
      { discard: true },
    );
  }).pipe(Effect.withSpan("BotTaskService.reconcile"));

  yield* scheduler.register("bot-tasks", reconcile);

  return BotTaskService.of({
    start,
    admitRoutine,
    requireRunnable,
    get,
    getResult,
    getAwarenessTasks,
    list,
    subscribeList,
    cancel,
    cancelForContext,
    reconcile,
    changes: PubSub.subscribe(changes).pipe(
      Effect.map((subscription) =>
        Stream.fromSubscription(subscription).pipe(Stream.map((change) => change.taskId)),
      ),
    ),
  });
});

export const layer = Layer.effect(BotTaskService, make).pipe(Layer.provide(BotStore.layer));

/** Routes scheduled routines into the same admission as direct requests. */
export const layerRoutineTarget = Layer.effect(
  BotRoutineTarget,
  Effect.gen(function* () {
    const tasks = yield* BotTaskService;
    return {
      requireRunnable: (input) =>
        tasks.requireRunnable(input).pipe(Effect.mapError((error) => error.message)),
      admit: (occurrence) =>
        tasks.admitRoutine(occurrence).pipe(Effect.mapError((error) => error.message)),
    } satisfies BotRoutineTargetShape;
  }),
);
