import {
  BOT_TASK_TERMINAL_STATUSES,
  type BotCancelTaskInput,
  BotError,
  type BotId,
  type BotStartTaskInput,
  BotTaskId,
  type BotTaskListInput,
  type BotTaskListResult,
  type BotTaskOrigin,
  type BotTaskStatus,
  BotTaskSummary,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  BOT_ROUTINE_RUNTIME_MODE,
  type BotRoutineAdmission,
  type BotRoutineOccurrence,
  BotRoutineTarget,
  type BotRoutineTargetShape,
} from "../scheduledTasks/BotRoutineTarget.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as BotStore from "./BotStore.ts";

const LIST_LIMIT = 50;

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
  readonly runtime_mode: string;
  readonly status: string;
  readonly detail: string | null;
  readonly dispatched_at: string | null;
  readonly cancel_requested_at: string | null;
  readonly result_run_id: string | null;
  readonly completed_at: string | null;
  readonly notified_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const decodeSummary = Schema.decodeUnknownEffect(BotTaskSummary);
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

export class BotTaskService extends Context.Service<
  BotTaskService,
  {
    /** Admits a direct request as a task in a new work thread of the Bot's project. */
    readonly start: (input: BotStartTaskInput) => Effect.Effect<BotTaskSummary, BotError>;
    /** The same admission for a routine occurrence; idempotent per occurrence key. */
    readonly admitRoutine: (
      occurrence: BotRoutineOccurrence,
    ) => Effect.Effect<BotRoutineAdmission, BotError>;
    readonly requireRunnable: (input: {
      readonly botId: BotId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<{ readonly modelSelection: ModelSelection }, BotError>;
    readonly get: (taskId: BotTaskId) => Effect.Effect<BotTaskSummary, BotError>;
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* BotStore.BotStore;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scheduler = yield* Scheduler.Scheduler;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.sliding<BotTaskId>(1024);

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
    }).pipe(Effect.mapError(storageError));

  const readRow = (taskId: string) =>
    sql<BotTaskRow>`SELECT * FROM bot_tasks WHERE task_id = ${taskId}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError(storageError),
    );

  const publish = (taskId: string) =>
    PubSub.publish(changes, BotTaskId.make(taskId)).pipe(Effect.asVoid);

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
    const detail = yield* BotStore.toDetail(bot, [], []).pipe(Effect.mapError(storageError));
    const launched = yield* threadLaunch
      .launch({
        commandId: CommandId.make(`bot-task-launch:${row.task_id}`),
        threadId: ThreadId.make(row.work_thread_id),
        projectId: row.project_id as ProjectId,
        title: row.title,
        modelSelection: detail.modelSelection,
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
        SET status = 'failed', detail = ${`The work thread could not start: ${errorMessage(Cause.squash(launched.cause))}`},
            completed_at = ${now}, updated_at = ${now}
        WHERE task_id = ${row.task_id} AND completed_at IS NULL
      `.pipe(Effect.mapError(storageError));
    }
    yield* publish(row.task_id);
  });

  const insertTask = (row: BotTaskRow) =>
    sql`
      INSERT INTO bot_tasks (
        task_id, bot_id, project_id, home_thread_id, work_thread_id, origin, title, prompt,
        scheduled_task_id, occurrence_key, occurrence_due_at, session_at, runtime_mode, status,
        detail, dispatched_at, cancel_requested_at, result_run_id, completed_at, notified_at,
        created_at, updated_at
      ) VALUES (
        ${row.task_id}, ${row.bot_id}, ${row.project_id}, ${row.home_thread_id},
        ${row.work_thread_id}, ${row.origin}, ${row.title}, ${row.prompt},
        ${row.scheduled_task_id}, ${row.occurrence_key}, ${row.occurrence_due_at},
        ${row.session_at}, ${row.runtime_mode}, ${row.status}, ${row.detail},
        ${row.dispatched_at}, ${row.cancel_requested_at}, ${row.result_run_id},
        ${row.completed_at}, ${row.notified_at}, ${row.created_at}, ${row.updated_at}
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
    work_thread_id: input.skipReason === undefined ? `bot-work:${input.taskId}` : null,
    origin: input.origin,
    title: input.title,
    prompt: input.prompt,
    scheduled_task_id: input.occurrence?.scheduledTaskId ?? null,
    occurrence_key: input.occurrence?.occurrenceKey ?? null,
    occurrence_due_at: input.occurrence?.dueAt ?? null,
    session_at: input.occurrence?.sessionAt ?? null,
    runtime_mode: input.runtimeMode,
    status: input.skipReason === undefined ? "accepted" : "skipped",
    detail: input.skipReason ?? null,
    dispatched_at: null,
    cancel_requested_at: null,
    result_run_id: null,
    completed_at: input.skipReason === undefined ? null : input.now,
    notified_at: null,
    created_at: input.now,
    updated_at: input.now,
  });

  const start: BotTaskService["Service"]["start"] = Effect.fn("BotTaskService.start")(
    function* (input) {
      const suffix =
        input.commandId ??
        (yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError(botError("Failed to allocate a task id.", input.botId))));
      const taskId = `bot-task:${suffix}`;
      const existing = yield* readRow(taskId);
      if (existing !== undefined) return yield* toSummary(existing);
      const context = yield* activeContext(input.botId, input.projectId);
      if (context._tag === "inactive") return yield* botError(context.reason, input.botId)();
      // A direct request runs in the mode the user gave the Bot's conversation.
      const home = yield* threads
        .getThreadShell(ThreadId.make(context.context.home_thread_id))
        .pipe(Effect.mapError(botError("Failed to read the Bot conversation.", input.botId)));
      const row = newRow({
        taskId,
        botId: input.botId,
        projectId: input.projectId,
        homeThreadId: context.context.home_thread_id,
        origin: "direct",
        title: input.title ?? `${context.bot.name}: ${input.prompt.split("\n")[0]?.slice(0, 60)}`,
        prompt: input.prompt,
        runtimeMode: home?.runtimeMode ?? BOT_ROUTINE_RUNTIME_MODE,
        now: yield* nowIso,
      });
      yield* insertTask(row).pipe(Effect.mapError(storageError));
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
              ? "The session had already started when this preparation was due."
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
      else yield* publish(row.task_id);
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

  const list: BotTaskService["Service"]["list"] = Effect.fn("BotTaskService.list")(
    function* (input) {
      const rows = yield* sql<BotTaskRow>`
        SELECT * FROM bot_tasks
        WHERE (${input.botId ?? null} IS NULL OR bot_id = ${input.botId ?? null})
          AND (${input.projectId ?? null} IS NULL OR project_id = ${input.projectId ?? null})
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
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list(input))),
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
    yield* publish(row.task_id);
  });

  const cancel: BotTaskService["Service"]["cancel"] = Effect.fn("BotTaskService.cancel")(
    function* (input) {
      const row = yield* readRow(input.taskId);
      if (row === undefined) return yield* botError("Bot task not found.")();
      if (row.completed_at === null) yield* requestCancel(row, null);
      return yield* get(input.taskId);
    },
  );

  const cancelForContext: BotTaskService["Service"]["cancelForContext"] = Effect.fn(
    "BotTaskService.cancelForContext",
  )(function* (input) {
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
      yield* publish(row.task_id);
      if (!terminal) return;
    }
    const current = yield* readRow(row.task_id);
    if (current === undefined || current.completed_at === null || current.notified_at !== null) {
      return;
    }
    // The result stays in the work thread; the home conversation shows its card and turns unread.
    if (current.status !== "cancelled") {
      yield* threads
        .dispatch({
          type: "thread.mark-unread",
          commandId: CommandId.make(`bot-task-notify:${current.task_id}`),
          threadId: ThreadId.make(current.home_thread_id),
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not mark the Bot conversation unread", {
              taskId: current.task_id,
              cause,
            }),
          ),
        );
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
      ORDER BY created_at, task_id
    `.pipe(Effect.mapError(storageError));
    yield* Effect.forEach(
      open,
      (row) =>
        reconcileTask(row).pipe(
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
    list,
    subscribeList,
    cancel,
    cancelForContext,
    reconcile,
    changes: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
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
