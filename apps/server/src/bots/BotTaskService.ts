import {
  BOT_TASK_LIMIT_DEFAULT,
  BOT_TASK_TERMINAL_STATUSES,
  BOT_WORK_THREAD_ID_PREFIX,
  BotTaskAcceptance,
  type BotCancelTaskInput,
  type BotClearWorktreePoolResult,
  BotError,
  type BotWorktreePool as BotWorktreePoolView,
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
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as BotDatabase from "./persistence/BotDatabase.ts";

import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  BOT_ROUTINE_RUNTIME_MODE,
  type BotRoutineAdmission,
  type BotRoutineOccurrence,
  BotRoutineTarget,
  type BotRoutineTargetShape,
} from "../scheduledTasks/BotRoutineTarget.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as BotContinuation from "./BotContinuation.ts";
import { isNoChangesTask } from "./BotExecutionConstraint.ts";
import * as Acceptance from "./BotTaskAcceptance.ts";
import * as FailureDiagnosis from "./BotFailureDiagnosis.ts";
import * as BotProviderSupport from "./BotProviderSupport.ts";
import * as BotStore from "./BotStore.ts";
import * as BotWatch from "./BotWatch.ts";
import * as BotWorktreePool from "./BotWorktreePool.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { isDirectHomeInput, isUserHomeInput, latestDirectHomeInput } from "./homeReturn.ts";

const LIST_LIMIT = 50;
/** Posts kept per watch; occasions older than these are long past. */
const WATCH_POSTS_KEPT = 50;
export const BOT_TASK_NOTIFY_COMMAND_PREFIX = "bot-task-notify:";
const HOME_REMOVED = "Stopped because the Bot's Home was removed.";

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
  /** A diagnosis: the failed routine task and run it was admitted for. */
  readonly diagnoses_task_id: string | null;
  readonly diagnoses_run_id: string | null;
  /** 1 when the user started it: from their client, or a Home turn their own message began. */
  readonly by_hand: number;
  /** 1 when admitted as a run of a standing watch, which posts only what is new. */
  readonly watch: number;
  /** 1 once a watch run ended with nothing new: no card, no unread mark, no alert. */
  readonly quiet: number;
  /** The branch of a writing task's own worktree; null for one in the project folder. */
  readonly branch: string | null;
  /** The branch the task named to start from; null starts from the default branch. */
  readonly base_branch: string | null;
  readonly worktree_state: "root" | "held" | "released" | null;
  /** 1 once uncommitted work in the worktree was saved as a commit on the branch. */
  readonly unfinished_work: number;
  /** A completed direct task's BotTaskAcceptance; null for other tasks. */
  readonly acceptance_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Read with the failed task a diagnosis links to, for its summary. */
interface BotTaskSummaryRow extends BotTaskRow {
  readonly diagnoses_title?: string | null;
  readonly diagnoses_work_thread_id?: string | null;
}

/** Stored only: a diagnosis reads as a routine to clients that predate it. */
type StoredTaskOrigin = BotTaskOrigin | "diagnostic";

const decodeSummary = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...BotTaskSummary.fields,
    modelSelection: Schema.optional(Schema.fromJsonString(ModelSelection)),
    acceptance: Schema.optional(Schema.fromJsonString(BotTaskAcceptance)),
  }),
);
const encodeAcceptance = Schema.encodeSync(Schema.fromJsonString(BotTaskAcceptance));
const decodeAcceptance = Schema.decodeUnknownOption(Schema.fromJsonString(BotTaskAcceptance));
/** The result check of a completed direct task, when it waits for the user. */
const acceptanceNeedingYou = (row: Pick<BotTaskRow, "acceptance_json">) =>
  row.acceptance_json === null
    ? undefined
    : Option.filter(
        decodeAcceptance(row.acceptance_json),
        (acceptance) => acceptance.state === "needs_you",
      ).pipe(Option.getOrUndefined);
const needsYou = (row: Pick<BotTaskRow, "acceptance_json">) =>
  acceptanceNeedingYou(row) !== undefined;
const isBotError = Schema.is(BotError);

const isTerminal = (status: BotTaskStatus) => BOT_TASK_TERMINAL_STATUSES.has(status);

/** Direct tasks and Changes allowed routines; No changes routines, watches and diagnoses only read. */
const writesFiles = (row: Pick<BotTaskRow, "origin" | "allow_changes" | "watch">) =>
  !isNoChangesTask(row) && row.watch !== 1;

/** Stable per task, so a retried dispatch names the same branch. */
export const taskBranchName = (row: Pick<BotTaskRow, "task_id" | "title">) => {
  const slug = row.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  // From the whole id: routine ids differ only in timestamps whose last digits repeat.
  let hash = 0x811c9dc5;
  for (const character of row.task_id) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  return `bot/${slug === "" ? "task" : slug}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

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
  readonly botId: BotId;
  readonly projectId: ProjectId;
  readonly homeThreadId: ThreadId;
  /** Results of work the user started push at once; the rest go through the alert budget. */
  readonly byHand: boolean;
  /** A watch run that ended with nothing new; it never alerts. */
  readonly quiet: boolean;
  /** A result that waits for the user; its alert is gathered with others under the alert budget. */
  readonly needsYou: boolean;
  readonly workThreadId: ThreadId;
  readonly status: BotTaskStatus;
  readonly resultRunId: RunId | null;
  readonly completedAt: string | null;
}

export class BotTaskService extends Context.Service<
  BotTaskService,
  {
    /**
     * Admits a direct request as a task in a new work thread of the Bot's project. Without
     * options the user's own client asked; `requestedIn` is the thread whose turn asked, null
     * for an agent outside T3 Code's threads.
     */
    readonly start: (
      input: BotStartTaskInput,
      options?: {
        readonly returnToHomeFrom?: ThreadId;
        readonly requestedIn?: ThreadId | null;
      },
    ) => Effect.Effect<BotTaskSummary, BotError>;
    /** The same admission for a routine occurrence; idempotent per occurrence key. */
    readonly admitRoutine: (
      occurrence: BotRoutineOccurrence,
    ) => Effect.Effect<BotRoutineAdmission, BotError>;
    /** With `allowChanges: false`, also refuses a Bot whose model cannot run No changes. */
    readonly requireRunnable: (input: {
      readonly botId: BotId;
      readonly projectId: ProjectId;
      readonly allowChanges?: boolean | undefined;
    }) => Effect.Effect<{ readonly modelSelection: ModelSelection }, BotError>;
    /** Refuses a model the Bot cannot run on with its current settings. */
    readonly requireSupportedModel: (input: {
      readonly botId: BotId;
      readonly modelSelection: ModelSelection;
    }) => Effect.Effect<void, BotError>;
    readonly get: (taskId: BotTaskId) => Effect.Effect<BotTaskSummary, BotError>;
    /** Reads routing identity without loading prompts or saved answer content. */
    readonly getAwarenessTasks: (
      workThreadId?: ThreadId,
    ) => Effect.Effect<ReadonlyArray<BotTaskAwareness>, BotError>;
    readonly getResult: (input: BotTaskResultInput) => Effect.Effect<BotTaskResult, BotError>;
    readonly list: (input: BotTaskListInput) => Effect.Effect<BotTaskListResult, BotError>;
    readonly subscribeList: (input: BotTaskListInput) => Stream.Stream<BotTaskListResult, BotError>;
    readonly cancel: (input: BotCancelTaskInput) => Effect.Effect<BotTaskSummary, BotError>;
    /** Stops unfinished work when the Bot is archived, a project detached or a Home removed. */
    readonly cancelForContext: (input: {
      readonly botId: BotId;
      readonly projectId?: ProjectId | undefined;
      /** Only the tasks this Home started. */
      readonly homeThreadId?: ThreadId | undefined;
    }) => Effect.Effect<void, BotError>;
    /**
     * Starts admitted work a crash left or a wait held back, records status changes, publishes
     * results once, and gives finished tasks' worktrees back to the pool.
     */
    readonly reconcile: Effect.Effect<void, BotError>;
    /** The project's Bot task worktrees: how many are free, in use, and their disk use. */
    readonly worktreePool: (projectId: ProjectId) => Effect.Effect<BotWorktreePoolView, BotError>;
    /** Removes the project's free worktrees; ones in use stay. */
    readonly clearWorktreePool: (
      projectId: ProjectId,
    ) => Effect.Effect<BotClearWorktreePoolResult, BotError>;
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
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const main = yield* SqlClient.SqlClient;
  const scheduler = yield* Scheduler.Scheduler;
  const random = yield* SecureRandom.SecureRandom;
  const worktrees = yield* BotWorktreePool.BotWorktreePool;
  const evidence = yield* Acceptance.BotTaskEvidence;
  const continuation = yield* BotContinuation.BotContinuation;
  const path = yield* Path.Path;
  const dispatching = yield* Ref.make<ReadonlySet<string>>(new Set());
  const changes = yield* PubSub.sliding<{
    readonly taskId: BotTaskId;
    readonly workThreadId: string | null;
  }>(1024);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const storageError = botError("Bot task storage failed.");

  const enabledInAttachedProjects = (
    table: "bot_maintenance" | "bot_home_checks" | "bot_failure_diagnosis",
    botId: BotId,
  ) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM ${sql(table)} AS feature
      JOIN bot_project_contexts AS context ON context.home_thread_id = feature.home_thread_id
      WHERE context.bot_id = ${botId} AND context.kind = 'project'
        AND context.detached_at IS NULL AND feature.enabled = 1
    `.pipe(Effect.map((rows) => (rows[0]?.count ?? 0) > 0));

  /**
   * What to change before this Bot's settings fit a provider with this support; empty when they do.
   * One task's own model needs only the MCP access that task loads: routines, maintenance, the
   * Home check and diagnosis run on the Bot's model.
   */
  const unsupportedSettings = Effect.fn("BotTaskService.unsupportedSettings")(function* (
    botId: BotId,
    support: ReturnType<typeof BotProviderSupport.botDriverSupport>,
    use: "bot" | "task",
  ) {
    const changes: Array<string> = [];
    const grants = (yield* store.listMcpGrants(botId)).get(botId);
    if (!support.mcpGrants && (grants?.connectionIds.length ?? 0) > 0)
      changes.push("remove its MCP connections");
    if (!support.ownMcpServers && grants?.ownCodexMcpServers === true)
      changes.push('turn off "Use my own Codex MCP servers"');
    if (use === "task") return changes;
    if (!support.readOnlySeal) {
      const noChanges = yield* sql<{ readonly task_id: string }>`
        SELECT task_id FROM bot_routines WHERE bot_id = ${botId} AND bot_allow_changes = 0
      `;
      const [active] =
        noChanges.length === 0
          ? [{ count: 0 }]
          : yield* main<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM scheduled_tasks
              WHERE enabled = 1 AND task_id IN ${main.in(noChanges.map((row) => row.task_id))}
            `;
      if ((active?.count ?? 0) > 0)
        changes.push("pause its No changes routines or set them to Changes allowed");
      if (yield* enabledInAttachedProjects("bot_failure_diagnosis", botId))
        changes.push("turn off Diagnose failed routines");
    }
    if (!support.homeSeal && (yield* enabledInAttachedProjects("bot_home_checks", botId)))
      changes.push("turn off the Daily Home check");
    if (
      !(support.homeSeal && support.sealedGeneration) &&
      (yield* enabledInAttachedProjects("bot_maintenance", botId))
    )
      changes.push("turn off Maintenance");
    return changes;
  });

  /**
   * One rule for every way a Bot gets a model, its own or one task's: a Bot driver only, and
   * only where the provider can honor the settings that model serves. The message lists what to change.
   */
  const requireModelFor = Effect.fn("BotTaskService.requireSupportedModel")(function* (
    input: { readonly botId: BotId; readonly modelSelection: ModelSelection },
    use: "bot" | "task",
  ) {
    const { instanceId } = input.modelSelection;
    const instance = yield* providerInstances.getInstance(instanceId);
    if (instance === undefined)
      return yield* botError(`Provider instance ${instanceId} is not configured.`, input.botId)();
    if (!BotProviderSupport.isBotDriver(instance.driverKind))
      return yield* botError(BotProviderSupport.BOT_DRIVERS_MESSAGE, input.botId)();
    const changes = yield* unsupportedSettings(
      input.botId,
      BotProviderSupport.botDriverSupport(instance.driverKind),
      use,
    ).pipe(Effect.mapError(storageError));
    if (changes.length > 0) {
      const provider =
        instance.driverKind === "claudeAgent"
          ? "Claude"
          : instance.driverKind === "pi"
            ? "Pi"
            : instance.driverKind;
      return yield* botError(
        `${provider} can't enforce some of this Bot's settings yet. First ${changes.join(", ")}, then try again.`,
        input.botId,
      )();
    }
  });
  const requireSupportedModel: BotTaskService["Service"]["requireSupportedModel"] = (input) =>
    requireModelFor(input, "bot");

  const toSummary = (row: BotTaskSummaryRow) =>
    decodeSummary({
      id: row.task_id,
      botId: row.bot_id,
      projectId: row.project_id,
      homeThreadId: row.home_thread_id,
      // A task waiting to start, or cancelled before it did, has no thread to open yet.
      workThreadId: row.dispatched_at === null ? null : row.work_thread_id,
      origin: row.origin === "diagnostic" ? "routine" : row.origin,
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
      ...(row.watch !== 1 || row.by_hand === 1
        ? {}
        : {
            watch: {
              state: row.completed_at === null ? "pending" : row.quiet === 1 ? "quiet" : "shown",
              runId: row.result_run_id,
            },
          }),
      ...(row.diagnoses_task_id === null ||
      row.diagnoses_run_id === null ||
      row.diagnoses_title == null ||
      row.diagnoses_work_thread_id == null
        ? {}
        : {
            diagnosis: {
              taskId: row.diagnoses_task_id,
              runId: row.diagnoses_run_id,
              title: row.diagnoses_title,
              workThreadId: row.diagnoses_work_thread_id,
            },
          }),
      ...(row.branch === null ? {} : { branch: row.branch }),
      ...(row.base_branch === null ? {} : { baseBranch: row.base_branch }),
      ...(row.unfinished_work === 1 ? { unfinishedWork: true } : {}),
      ...(row.acceptance_json === null ? {} : { acceptance: row.acceptance_json }),
    }).pipe(Effect.mapError(storageError));

  const summaryRows = sql`
    SELECT t.*, f.title AS diagnoses_title, f.work_thread_id AS diagnoses_work_thread_id
    FROM bot_tasks t LEFT JOIN bot_tasks f ON f.task_id = t.diagnoses_task_id
  `;

  const readRow = (taskId: string) =>
    sql<BotTaskSummaryRow>`${summaryRows} WHERE t.task_id = ${taskId}`.pipe(
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
    if (context?.kind === "bot") {
      return {
        _tag: "inactive",
        reason: `${bot.name}'s tasks and routines run in its attached projects, never in its own Home's project.`,
      } as const;
    }
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
    if (input.allowChanges === false) {
      const instance = yield* providerInstances.getInstance(detail.modelSelection.instanceId);
      if (!BotProviderSupport.botDriverSupport(instance?.driverKind).readOnlySeal) {
        return yield* botError(
          `${context.bot.name} runs on a model that can't enforce No changes yet, so this routine can't be No changes. Choose Changes allowed, or switch the Bot to a Codex or Claude model.`,
          input.botId,
        )();
      }
    }
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

  /** Leaves the task admitted but not started, saying why; a later reconcile pass tries again. */
  const waitFor = Effect.fn("BotTaskService.waitFor")(function* (row: BotTaskRow, reason: string) {
    if (row.detail === reason) return;
    yield* sql`
      UPDATE bot_tasks SET detail = ${reason}, updated_at = ${yield* nowIso}
      WHERE task_id = ${row.task_id} AND dispatched_at IS NULL AND cancel_requested_at IS NULL
    `.pipe(Effect.mapError(storageError));
    yield* publish(row);
  });

  /**
   * Where the work thread runs: a task that may change files gets a pooled worktree on its own
   * branch, or the project folder one at a time when the project has no Git. Null while it waits.
   */
  const claimWorkspace = Effect.fn("BotTaskService.claimWorkspace")(function* (
    row: BotTaskRow,
    workThreadId: ThreadId,
  ) {
    if (!writesFiles(row)) return { workspaceStrategy: { type: "root" } } as const;
    const branch = row.branch ?? taskBranchName(row);
    const claim = yield* worktrees.take({
      projectId: ProjectId.make(row.project_id),
      workThreadId,
      branch,
      baseBranch: row.base_branch,
    });
    switch (claim._tag) {
      case "full":
        yield* waitFor(
          row,
          `Waiting for a free worktree: ${BotWorktreePool.BOT_WORKTREE_POOL_LIMIT} tasks in this project are working.`,
        );
        return null;
      case "no-git": {
        const started = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const busy = yield* sql`
                SELECT task_id FROM bot_tasks
                WHERE project_id = ${row.project_id} AND worktree_state = 'root'
                  AND completed_at IS NULL AND task_id <> ${row.task_id} LIMIT 1
              `;
              if (busy.length > 0) return false;
              yield* sql`UPDATE bot_tasks SET worktree_state = 'root' WHERE task_id = ${row.task_id}`;
              return true;
            }),
          )
          .pipe(Effect.mapError(storageError));
        if (!started) {
          yield* waitFor(
            row,
            "Waiting for another task that may change files in this folder to finish.",
          );
          return null;
        }
        return { workspaceStrategy: { type: "root" } } as const;
      }
      case "pooled":
      case "create": {
        if (row.branch !== branch)
          yield* sql`UPDATE bot_tasks SET branch = ${branch} WHERE task_id = ${row.task_id}`.pipe(
            Effect.mapError(storageError),
          );
        return claim._tag === "create"
          ? ({ workspaceStrategy: { type: "worktree", baseRef: claim.baseRef, branch } } as const)
          : ({
              workspaceStrategy: {
                type: "existing_worktree",
                worktreePath: claim.worktreePath,
                branch,
              },
              setupScript: claim.setupNeeded ? ("await" as const) : ("skip" as const),
            } as const);
      }
    }
  });

  /**
   * Unfinished direct tasks holding a slot before this one: every started one, and every one
   * admitted earlier, cancelled or not. Slots go oldest first, so two launches deciding at once
   * cannot both take the last. Insert order, which reconcile follows too: timestamps can tie.
   */
  const directTasksAhead = (row: BotTaskRow) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM bot_tasks
      WHERE bot_id = ${row.bot_id} AND origin = 'direct' AND completed_at IS NULL
        AND task_id <> ${row.task_id}
        AND (dispatched_at IS NOT NULL
          OR rowid < (SELECT rowid FROM bot_tasks WHERE task_id = ${row.task_id}))
    `.pipe(
      Effect.map((rows) => rows[0]?.count ?? 0),
      Effect.mapError(storageError),
    );

  /**
   * Launches the work thread. The same ids make a retried launch replay instead of duplicating.
   * A cancel can land while the launch runs, so the cancel flag is checked again after it.
   */
  const dispatch = Effect.fn("BotTaskService.dispatch")(function* (stale: BotTaskRow) {
    // The start call and a reconcile pass can both find a task not yet launched. One claims its
    // worktree and launches; the other leaves it to that one.
    const entered = yield* Ref.modify(dispatching, (current) =>
      current.has(stale.task_id) ? [false, current] : [true, new Set(current).add(stale.task_id)],
    );
    if (!entered) return;
    yield* launchWork(stale).pipe(
      Effect.ensuring(
        Ref.update(dispatching, (current) => {
          const next = new Set(current);
          next.delete(stale.task_id);
          return next;
        }),
      ),
    );
  });

  const launchWork = Effect.fn("BotTaskService.launchWork")(function* (stale: BotTaskRow) {
    const row = yield* readRow(stale.task_id);
    if (
      row === undefined ||
      row.completed_at !== null ||
      row.cancel_requested_at !== null ||
      row.dispatched_at !== null
    )
      return;
    const bot = yield* store.getBot(row.bot_id).pipe(Effect.mapError(storageError));
    if (bot === undefined || row.work_thread_id === null) return;
    if (row.origin === "direct") {
      const limit = bot.task_limit ?? BOT_TASK_LIMIT_DEFAULT;
      if ((yield* directTasksAhead(row)) >= limit) {
        yield* waitFor(
          row,
          `Waiting for a free slot: ${bot.name} runs at most ${limit} ${limit === 1 ? "task" : "tasks"} at once.`,
        );
        return;
      }
    }
    const modelSelection =
      row.model_selection_json === null
        ? (yield* BotStore.toDetail(bot, [], []).pipe(Effect.mapError(storageError))).modelSelection
        : yield* BotStore.decodeModelSelection(row.model_selection_json).pipe(
            Effect.mapError(storageError),
          );
    const workThreadId = ThreadId.make(row.work_thread_id);
    const launched = yield* Effect.gen(function* () {
      const workspace = yield* claimWorkspace(row, workThreadId);
      if (workspace === null) return "waiting" as const;
      // A cancel during the claim ended the task already; its release frees the claim.
      if ((yield* readRow(row.task_id))?.cancel_requested_at != null) return "waiting" as const;
      yield* threadLaunch.launch({
        commandId: CommandId.make(`bot-task-launch:${row.task_id}`),
        threadId: workThreadId,
        projectId: row.project_id as ProjectId,
        title: row.title,
        modelSelection,
        runtimeMode: row.runtime_mode as RuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        ...workspace,
        initialMessage: {
          messageId: MessageId.make(`bot-task-message:${row.task_id}`),
          text: row.prompt,
          attachments: [],
        },
        createdBy: row.origin === "direct" ? "user" : "system",
        creationSource: "server",
      });
      return "launched" as const;
    }).pipe(Effect.exit);
    if (launched._tag === "Success" && launched.value === "waiting") return;
    const now = yield* nowIso;
    if (launched._tag === "Success") {
      // A wait the task went through is over; a cancel's reason stays.
      yield* sql`
        UPDATE bot_tasks SET dispatched_at = ${now}, updated_at = ${now},
          detail = CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE detail END
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
        model_selection_json, diagnoses_task_id, diagnoses_run_id, by_hand, watch, quiet,
        branch, base_branch, worktree_state, unfinished_work
      ) VALUES (
        ${row.task_id}, ${row.bot_id}, ${row.project_id}, ${row.home_thread_id},
        ${row.work_thread_id}, ${row.origin}, ${row.title}, ${row.prompt},
        ${row.scheduled_task_id}, ${row.occurrence_key}, ${row.occurrence_due_at},
        ${row.session_at}, ${row.allow_changes}, ${row.runtime_mode}, ${row.status}, ${row.detail},
        ${row.dispatched_at}, ${row.cancel_requested_at}, ${row.result_run_id},
        ${row.completed_at}, ${row.notified_at}, ${row.created_at}, ${row.updated_at},
        ${row.return_home_run_id}, ${row.return_home_message_id}, ${row.return_finished_at},
        ${row.model_selection_json}, ${row.diagnoses_task_id}, ${row.diagnoses_run_id},
        ${row.by_hand}, ${row.watch}, ${row.quiet},
        ${row.branch}, ${row.base_branch}, ${row.worktree_state}, ${row.unfinished_work}
      )
      ON CONFLICT DO NOTHING
    `;

  const newRow = (input: {
    readonly taskId: string;
    readonly botId: string;
    readonly projectId: string;
    readonly homeThreadId: string;
    readonly origin: StoredTaskOrigin;
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
    diagnoses_task_id: null,
    diagnoses_run_id: null,
    by_hand: 0,
    watch: input.occurrence?.watch === true ? 1 : 0,
    quiet: 0,
    branch: null,
    base_branch: null,
    worktree_state: null,
    unfinished_work: 0,
    acceptance_json: null,
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
    yield* requireModelFor({ botId: input.botId, modelSelection: selection }, "task");
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

  /**
   * The turn running in the Bot's Home, when `requestedIn` names that Home; it is what asked.
   * `projectId` is the Home's own project: the hidden one for the Bot's own Home, where a task's
   * update may already wait behind the turn that is still starting tasks.
   */
  const readRequestingHomeTurn = Effect.fnUntraced(function* (
    input: { readonly botId: BotId; readonly projectId: ProjectId },
    homeThreadId: string,
    home: OrchestrationV2ThreadShell | null,
    requestedIn: ThreadId | null | undefined,
    queuedBehind = false,
  ) {
    if (
      requestedIn === undefined ||
      requestedIn !== homeThreadId ||
      home === null ||
      home.id !== requestedIn ||
      home.projectId !== input.projectId ||
      home.deletedAt !== null ||
      home.archivedAt !== null ||
      home.status !== "running" ||
      home.activeRunId === null ||
      (!queuedBehind && home.activeRunId !== home.latestRunId)
    )
      return undefined;
    const runId = home.activeRunId;
    const records = yield* threads
      .getProjectThreadRecords(
        { projectId: input.projectId, threadId: home.id },
        ["runs", "messages", "turnItems"],
        {
          runIds: [runId],
          messageRunIds: [runId],
          messageRoles: ["user"],
          turnItemRunIds: [runId],
          turnItemTypes: ["user_message"],
        },
      )
      .pipe(Effect.mapError(botError("Failed to read the Home user turn.", input.botId)));
    const run = records.runs.find((candidate) => candidate.id === runId);
    const message = records.messages.find((candidate) => candidate.id === run?.userMessageId);
    return { records, run, message };
  });
  /** The Bot's own Home, when its turn is what asked; refused once removed, so no task strays. */
  const requestingBotHome = Effect.fnUntraced(function* (
    botId: BotId,
    requestedIn: ThreadId | null | undefined,
  ) {
    if (requestedIn == null) return undefined;
    const home = yield* store.getContextByThread(requestedIn).pipe(Effect.mapError(storageError));
    if (home?.kind !== "bot" || home.bot_id !== botId) return undefined;
    if (home.detached_at !== null)
      return yield* botError("This Bot's Home was removed, so it starts no tasks.", botId)();
    return home;
  });

  /** An agent acts by hand only inside a Home turn the user began with a typed message. */
  const isUserTurn = (turn: Effect.Success<ReturnType<typeof readRequestingHomeTurn>>) =>
    turn?.run?.status === "running" && isUserHomeInput(turn.message);

  /** Whether the user asked for this routine run, read before its admission. */
  const routineByHand = Effect.fnUntraced(function* (occurrence: BotRoutineOccurrence) {
    const { requestedBy } = occurrence;
    if (requestedBy === undefined) return false;
    if (requestedBy === "client") return true;
    const context = yield* activeContext(occurrence.botId, occurrence.projectId);
    if (context._tag === "inactive") return false;
    const home = yield* threads
      .getThreadShell(ThreadId.make(context.context.home_thread_id))
      .pipe(Effect.mapError(botError("Failed to read the Bot conversation.", occurrence.botId)));
    return isUserTurn(
      yield* readRequestingHomeTurn(
        occurrence,
        context.context.home_thread_id,
        home,
        requestedBy.requestedIn,
      ),
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
      const readHome = (homeThreadId: string) =>
        threads
          .getThreadShell(ThreadId.make(homeThreadId))
          .pipe(Effect.mapError(botError("Failed to read the Bot conversation.", input.botId)));
      // A direct request runs in the mode the user gave the project's Home, wherever it was asked:
      // the Bot's own Home may be read-only, its tasks are not.
      const projectHome = yield* readHome(context.context.home_thread_id);
      // No options: the user's own client asked. Otherwise the thread whose turn asked, if any.
      const requestedIn =
        options === undefined ? undefined : (options.requestedIn ?? options.returnToHomeFrom);
      // The Bot's own Home starts tasks in its projects; their cards and updates come back to it.
      const botHome = yield* requestingBotHome(input.botId, requestedIn);
      const asking =
        botHome === undefined
          ? {
              homeThreadId: context.context.home_thread_id,
              projectId: input.projectId,
              home: projectHome,
            }
          : {
              homeThreadId: botHome.home_thread_id,
              projectId: ProjectId.make(botHome.project_id),
              home: yield* readHome(botHome.home_thread_id),
            };
      const homeTurn = yield* readRequestingHomeTurn(
        { botId: input.botId, projectId: asking.projectId },
        asking.homeThreadId,
        asking.home,
        requestedIn,
        botHome !== undefined,
      );
      const byHand = options === undefined || isUserTurn(homeTurn);
      let returnHomeRunId: string | null = null;
      let returnHomeMessageId: string | null = null;
      // From the Bot's own Home every result comes back as its own update, so no return is held.
      if (options?.returnToHomeFrom !== undefined && botHome === undefined) {
        if (options.returnToHomeFrom !== requestedIn || homeTurn === undefined)
          return yield* botError(
            "A result can return only from the Bot's active Home user turn.",
            input.botId,
          )();
        const { records, run, message } = homeTurn;
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
          homeThreadId: asking.homeThreadId,
          origin: "direct",
          title: input.title ?? `${context.bot.name}: ${input.prompt.split("\n")[0]?.slice(0, 60)}`,
          prompt: input.prompt,
          runtimeMode: projectHome?.runtimeMode ?? BOT_ROUTINE_RUNTIME_MODE,
          now: yield* nowIso,
        }),
        return_home_run_id: returnHomeRunId,
        return_home_message_id: returnHomeMessageId,
        model_selection_json: BotStore.encodeModelSelection(modelSelection),
        by_hand: byHand ? 1 : 0,
        base_branch: input.baseBranch ?? null,
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
            // A removal that committed since the read above has already swept its tasks.
            if (botHome !== undefined) yield* requestingBotHome(input.botId, requestedIn);
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
    const byHand = yield* routineByHand(occurrence);
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
          const missed = occurrence.sessionAt !== null && now >= occurrence.sessionAt;
          const overlaps = !missed && open.length > 0;
          const skipReason = missed
            ? "The event had already started when this routine was due."
            : overlaps
              ? "The previous run of this routine was still working."
              : undefined;
          const row = {
            ...newRow({
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
            }),
            by_hand: byHand ? 1 : 0,
            // The run still working will report; an unattended watch says nothing about the overlap.
            quiet: overlaps && occurrence.watch === true && !byHand ? 1 : 0,
          };
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
        | "task_id"
        | "bot_id"
        | "project_id"
        | "home_thread_id"
        | "work_thread_id"
        | "by_hand"
        | "quiet"
        | "status"
        | "result_run_id"
        | "completed_at"
      > & { readonly acceptance_state: string | null }
    >`
      SELECT task_id, bot_id, project_id, home_thread_id, work_thread_id, by_hand, quiet, status,
        result_run_id, completed_at, json_extract(acceptance_json, '$.state') AS acceptance_state
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
              botId: row.bot_id as BotId,
              projectId: ProjectId.make(row.project_id),
              homeThreadId: ThreadId.make(row.home_thread_id),
              byHand: row.by_hand === 1,
              quiet: row.quiet === 1,
              needsYou: row.acceptance_state === "needs_you",
              workThreadId: ThreadId.make(row.work_thread_id),
              status: row.status as BotTaskStatus,
              resultRunId: row.result_run_id === null ? null : RunId.make(row.result_run_id),
              completedAt: row.completed_at,
            },
          ],
    );
  });

  /** The final answer of one run of a work thread, as saved. */
  const readSavedResult = Effect.fn("BotTaskService.readSavedResult")(function* (
    task: { readonly projectId: ProjectId; readonly workThreadId: ThreadId },
    runId: RunId,
  ) {
    const unavailable = { state: "unavailable" } as const;
    const shell = yield* threads
      .getThreadShell(task.workThreadId)
      .pipe(Effect.mapError(botError("Failed to read the Bot task's work thread.")));
    if (shell === null || shell.deletedAt !== null) return unavailable;
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
    return text.trim() === ""
      ? ({ state: "empty", runId } as const)
      : ({ state: "available", runId, text } as const);
  });

  const getResult: BotTaskService["Service"]["getResult"] = Effect.fn("BotTaskService.getResult")(
    function* (input) {
      const row = yield* readRow(input.taskId);
      if (row === undefined) return yield* botError("Bot task not found.")();
      const task = yield* toSummary(row);
      if (task.status !== "completed") return { task, result: { state: "not_completed" } };
      if (row.result_run_id === null || task.workThreadId === null)
        return { task, result: { state: "unavailable" } };
      const runId = RunId.make(row.result_run_id);
      const result = yield* readSavedResult(
        { projectId: task.projectId, workThreadId: task.workThreadId },
        runId,
      );
      if (result.state !== "available") return { task, result };
      // The report line is for the server, not part of what the user reads.
      const { text } =
        row.watch === 1
          ? BotWatch.readWatchReport(result.text)
          : row.acceptance_json !== null
            ? Acceptance.readResultReport(result.text)
            : result;
      return {
        task,
        result: text === "" ? { state: "empty", runId } : { state: "available", runId, text },
      };
    },
  );

  const list: BotTaskService["Service"]["list"] = Effect.fn("BotTaskService.list")(
    function* (input) {
      const rows = yield* sql<BotTaskSummaryRow>`
        ${summaryRows}
        WHERE (${input.botId ?? null} IS NULL OR t.bot_id = ${input.botId ?? null})
          AND (${input.projectId ?? null} IS NULL OR t.project_id = ${input.projectId ?? null})
          AND (${input.homeThreadId ?? null} IS NULL OR t.home_thread_id = ${input.homeThreadId ?? null})
          AND ${
            // A quiet watch run is no card anywhere; its own thread still resolves to its task.
            input.workThreadId === undefined
              ? sql`t.quiet = 0`
              : sql`t.work_thread_id = ${input.workThreadId}`
          }
        ORDER BY t.created_at DESC, t.task_id DESC
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
    // A launch under way sees the flag when it returns and stops the thread it made; until a
    // later pass finishes the cancel, the task keeps its slot. Checked before the thread is read.
    if ((yield* Ref.get(dispatching)).has(row.task_id)) return yield* publish(row);
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
      // What it waited for is moot. A launch that recorded itself meanwhile settles by its thread.
      yield* sql`
        UPDATE bot_tasks
        SET status = 'cancelled', completed_at = ${now}, notified_at = ${now}, updated_at = ${now},
          detail = ${reason}
        WHERE task_id = ${row.task_id} AND completed_at IS NULL AND dispatched_at IS NULL
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
    const projectId = input.projectId ?? null;
    const homeThreadId = input.homeThreadId ?? null;
    yield* sql`UPDATE bot_tasks SET return_home_run_id = NULL
      WHERE bot_id = ${input.botId} AND return_finished_at IS NULL
        AND (${projectId} IS NULL OR project_id = ${projectId})
        AND (${homeThreadId} IS NULL OR home_thread_id = ${homeThreadId})`.pipe(
      Effect.mapError(storageError),
    );
    const rows = yield* sql<BotTaskRow>`
      SELECT * FROM bot_tasks
      WHERE bot_id = ${input.botId} AND completed_at IS NULL
        AND (${projectId} IS NULL OR project_id = ${projectId})
        AND (${homeThreadId} IS NULL OR home_thread_id = ${homeThreadId})
    `.pipe(Effect.mapError(storageError));
    const reason =
      homeThreadId !== null
        ? HOME_REMOVED
        : projectId === null
          ? "Stopped because the Bot was archived."
          : "Stopped because the Bot was detached from this project.";
    yield* Effect.forEach(rows, (row) => requestCancel(row, reason), { discard: true });
  });

  /** The saved result run's own end; completed_at is only when a reconcile pass first saw it. */
  const resultEndedAt = Effect.fn("BotTaskService.resultEndedAt")(function* (row: BotTaskRow) {
    if (row.work_thread_id === null || row.result_run_id === null) return null;
    const runId = RunId.make(row.result_run_id);
    const records = yield* threads
      .getProjectThreadRecords(
        { projectId: ProjectId.make(row.project_id), threadId: ThreadId.make(row.work_thread_id) },
        ["runs"],
        { runIds: [runId] },
      )
      .pipe(
        Effect.catchTags({ ThreadManagementThreadNotFoundError: () => Effect.succeed(null) }),
        Effect.mapError(botError("Failed to read the Bot task's run.")),
      );
    const completedAt = records?.runs.find((run) => run.id === runId)?.completedAt;
    return completedAt == null ? null : DateTime.formatIso(completedAt);
  });

  const earlyCheckEnabled = (home: string) =>
    sql`SELECT 1 FROM bot_home_checks WHERE home_thread_id = ${home} AND early_since IS NOT NULL`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(storageError),
    );

  const recordHomeCheckOutcome = (row: BotTaskRow, endedAt: string) =>
    sql`
      INSERT OR IGNORE INTO bot_home_check_outcomes (task_id, home_thread_id)
      SELECT ${row.task_id}, h.home_thread_id FROM bot_home_checks h
      JOIN bot_project_contexts c ON c.home_thread_id = h.home_thread_id
      JOIN bots b ON b.bot_id = c.bot_id
      WHERE h.home_thread_id = ${row.home_thread_id} AND h.enabled = 1
        AND h.early_since <= ${endedAt} AND c.detached_at IS NULL
        AND b.archived_at IS NULL
    `.pipe(Effect.mapError(storageError));

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
    // A result that is not done waits for the user, so Home does not continue on it.
    if (
      row.status !== "completed" ||
      needsYou(row) ||
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
    const returnId = `bot-task-return:${row.task_id}:${row.result_run_id}`;
    yield* threads
      .withBotResultDelivery(
        {
          type: "bot-task.result.deliver",
          commandId: CommandId.make(returnId),
          threadId: ThreadId.make(row.home_thread_id),
          projectId: row.project_id as ProjectId,
          botId: row.bot_id as BotId,
          taskId: BotTaskId.make(row.task_id),
          sourceThreadId: ThreadId.make(row.work_thread_id),
          resultRunId: RunId.make(row.result_run_id),
          homeRunId: RunId.make(row.return_home_run_id),
          homeMessageId: MessageId.make(row.return_home_message_id),
          messageId: MessageId.make(returnId),
          text: `Bot work run completed. Task fulfillment is unverified; existing user instructions and permissions still apply.\nTask: ${row.task_id}\nWork thread: ${row.work_thread_id}\nSaved run: ${row.result_run_id}\n${row.branch === null ? "" : `Branch: ${row.branch}\n`}\n${text.slice(0, 16000)}${text.length > 16000 ? "\n[Result truncated; the full saved result remains available on the task.]" : ""}`,
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
                if (delivery.deferred === true) return;
                if (
                  delivery.storedEvents.length === 0 &&
                  current.cancel_requested_at === null &&
                  (yield* earlyCheckEnabled(current.home_thread_id))
                ) {
                  // A dropped return commits no events. A delivered return's events may be pruned before replay.
                  const delivered =
                    delivery.replayed === true &&
                    (yield* main`SELECT 1 FROM orchestration_v2_projection_messages
                      WHERE thread_id = ${current.home_thread_id} AND message_id = ${returnId}`.pipe(
                      Effect.mapError(storageError),
                    )).length > 0;
                  if (!delivered) {
                    const endedAt = yield* resultEndedAt(current);
                    if (endedAt !== null) yield* recordHomeCheckOutcome(current, endedAt);
                  }
                }
                yield* finish;
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

  /**
   * Admits the one diagnosis a failed routine run may get when its Home's rule is on. The unique
   * index on diagnoses_task_id, not these reads, keeps repeats and restarts to one task.
   */
  const admitDiagnosis = Effect.fn("BotTaskService.admitDiagnosis")(function* (failed: BotTaskRow) {
    // A diagnosis is never a routine, so it cannot start another.
    if (
      failed.origin !== "routine" ||
      failed.status !== "failed" ||
      failed.cancel_requested_at !== null ||
      failed.result_run_id === null ||
      failed.work_thread_id === null
    )
      return;
    const admitted = sql<{ readonly task_id: string }>`
      SELECT task_id FROM bot_tasks WHERE diagnoses_task_id = ${failed.task_id}
    `.pipe(Effect.map((rows) => rows.length > 0));
    if (yield* admitted.pipe(Effect.mapError(storageError))) return;
    const workThreadId = failed.work_thread_id;
    const runId = failed.result_run_id;
    // The failed run's own record: a later follow-up in the thread does not move it, a rollback does.
    const records = yield* threads
      .getProjectThreadRecords(
        { projectId: ProjectId.make(failed.project_id), threadId: ThreadId.make(workThreadId) },
        ["runs", "turnItems"],
        { runIds: [RunId.make(runId)], turnItemRunIds: [RunId.make(runId)] },
      )
      .pipe(
        Effect.catchTags({ ThreadManagementThreadNotFoundError: () => Effect.succeed(null) }),
        Effect.mapError(botError("Failed to read the failed Bot task's run.")),
      );
    const run = records?.runs.find((candidate) => candidate.id === runId);
    if (run?.status !== "failed" || run.completedAt === null) return;
    const failedAt = DateTime.formatIso(run.completedAt);
    const ruleOn = (rule: FailureDiagnosis.FailureDiagnosisRule | undefined) =>
      rule?.enabled === 1 && rule.enabled_at !== null && rule.enabled_at <= failedAt;
    const rule = yield* FailureDiagnosis.readRule(sql, failed.home_thread_id).pipe(
      Effect.mapError(storageError),
    );
    if (!ruleOn(rule)) return;
    const row = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (yield* admitted) return undefined;
          const current = yield* FailureDiagnosis.readRule(sql, failed.home_thread_id);
          if (current === undefined || !ruleOn(current)) return undefined;
          const context = yield* activeContext(
            failed.bot_id as BotId,
            failed.project_id as ProjectId,
          );
          if (
            context._tag === "inactive" ||
            context.context.home_thread_id !== failed.home_thread_id
          )
            return undefined;
          const row: BotTaskRow = {
            ...newRow({
              taskId: `${failed.task_id}:diagnosis`,
              botId: failed.bot_id,
              projectId: failed.project_id,
              homeThreadId: failed.home_thread_id,
              origin: "diagnostic",
              title: `Diagnose: ${failed.title}`,
              prompt: FailureDiagnosis.diagnosisPrompt({
                brief: current.brief,
                failedTaskId: failed.task_id,
                failedTitle: failed.title,
                workThreadId,
                runId,
                record: (records?.turnItems ?? []).filter((item) => item.runId === runId),
              }),
              runtimeMode: failed.runtime_mode as RuntimeMode,
              now: yield* nowIso,
            }),
            model_selection_json: failed.model_selection_json,
            diagnoses_task_id: failed.task_id,
            diagnoses_run_id: runId,
          };
          yield* insertTask(row);
          return row;
        }),
      )
      .pipe(Effect.mapError((cause) => (isBotError(cause) ? cause : storageError(cause))));
    if (row !== undefined) yield* dispatch(row);
  });

  /**
   * Whether a finished task asks for an early Home check: a completed or failed run of a routine,
   * a diagnosis, or a direct task whose result does not go back to Home. A failed routine run that
   * got a diagnosis is left to it. A Home check's own run is no task, so it never asks for another.
   */
  const requestsHomeCheck = Effect.fnUntraced(function* (row: BotTaskRow) {
    if (
      (row.status !== "completed" && row.status !== "failed") ||
      row.result_run_id === null ||
      row.cancel_requested_at !== null
    )
      return false;
    if (row.origin === "direct") return row.status === "failed" || row.return_home_run_id === null;
    if (row.origin === "diagnostic" || row.status === "completed") return true;
    const diagnosed =
      yield* sql`SELECT task_id FROM bot_tasks WHERE diagnoses_task_id = ${row.task_id}`;
    return diagnosed.length === 0;
  });

  /** Whether a finished watch run posts, from its saved result and its routine's earlier posts. */
  const decideWatch = Effect.fn("BotTaskService.decideWatch")(function* (
    row: BotTaskRow,
    runId: RunId,
  ) {
    if (row.work_thread_id === null || row.scheduled_task_id === null) return null;
    const result = yield* readSavedResult(
      {
        projectId: ProjectId.make(row.project_id),
        workThreadId: ThreadId.make(row.work_thread_id),
      },
      runId,
    );
    const posts = yield* sql<{ readonly occasion_key: string }>`
      SELECT occasion_key FROM bot_watch_posts WHERE scheduled_task_id = ${row.scheduled_task_id}
    `.pipe(Effect.mapError(storageError));
    return BotWatch.decideWatch(
      result.state === "available" ? BotWatch.readWatchReport(result.text).report : null,
      posts.map((post) => post.occasion_key),
    );
  });

  /** The report a finished direct task's result ends with, and whether its evidence exists. */
  const checkResult = Effect.fn("BotTaskService.checkResult")(function* (
    row: BotTaskRow,
    runId: RunId,
    worktreePath: string | null,
  ) {
    if (row.work_thread_id === null) return null;
    const projectId = ProjectId.make(row.project_id);
    const saved = yield* readSavedResult(
      { projectId, workThreadId: ThreadId.make(row.work_thread_id) },
      runId,
    );
    const { report } =
      saved.state === "available" ? Acceptance.readResultReport(saved.text) : { report: null };
    const checks =
      report === null
        ? []
        : yield* evidence.check({
            projectId,
            worktreePath,
            items: report.evidence.map(Acceptance.classifyEvidence),
          });
    return Acceptance.decideAcceptance(report, checks);
  });

  /** A result that is not done, or that asks the user something, goes under Waiting on you. */
  // A failed write fails the pass, which retries; a note without room keeps the card's line only.
  const fileWaiting = Effect.fn("BotTaskService.fileWaiting")(function* (row: BotTaskRow) {
    const acceptance = acceptanceNeedingYou(row);
    if (acceptance === undefined || row.work_thread_id === null || row.result_run_id === null)
      return;
    // In the note of the Home that started it, the Bot's own Home for its tasks.
    const home = yield* store
      .getContextByThread(ThreadId.make(row.home_thread_id))
      .pipe(Effect.mapError(storageError));
    yield* continuation.addTaskWaiting({
      scope: {
        botId: row.bot_id as BotId,
        projectId: ProjectId.make(home?.project_id ?? row.project_id),
      },
      taskId: BotTaskId.make(row.task_id),
      text: Acceptance.waitingText(row.title, acceptance),
      writer: {
        threadId: ThreadId.make(row.work_thread_id),
        runId: RunId.make(row.result_run_id),
      },
    });
  });

  /** One step of the reconcile loop for one task; failures stay with that task. */
  const reconcileTask = Effect.fn("BotTaskService.reconcileTask")(function* (row: BotTaskRow) {
    if (row.completed_at === null) {
      const context = yield* activeContext(row.bot_id as BotId, row.project_id as ProjectId);
      if (context._tag === "inactive" && row.cancel_requested_at === null) {
        // An archive or detach that crashed before stopping its work finishes here.
        return yield* requestCancel(row, `Stopped because ${context.reason}`);
      }
      // So does a removal of the Bot's own Home, or a start from it that the removal missed.
      if (
        context._tag === "active" &&
        row.cancel_requested_at === null &&
        row.home_thread_id !== context.context.home_thread_id &&
        (yield* store
          .getContextByThread(ThreadId.make(row.home_thread_id))
          .pipe(Effect.mapError(storageError)))?.detached_at != null
      ) {
        return yield* requestCancel(row, HOME_REMOVED);
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
      const watch =
        status === "completed" && row.watch === 1 && shell?.latestRunId != null
          ? yield* decideWatch(row, shell.latestRunId)
          : null;
      const acceptance =
        status === "completed" && row.origin === "direct" && shell?.latestRunId != null
          ? yield* checkResult(row, shell.latestRunId, shell.worktreePath ?? null)
          : null;
      // Saved with the completion, so no reader sees a finished watch run before its decision.
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const ended = yield* sql`
              UPDATE bot_tasks
              SET status = ${status},
                  result_run_id = ${terminal ? (shell?.latestRunId ?? null) : row.result_run_id},
                  completed_at = ${terminal ? now : null},
                  quiet = ${watch?._tag === "quiet" && row.by_hand === 0 ? 1 : 0},
                  acceptance_json = ${acceptance === null ? null : encodeAcceptance(acceptance)},
                  updated_at = ${now}
              WHERE task_id = ${row.task_id} AND completed_at IS NULL
              RETURNING task_id
            `;
            if (ended.length === 0 || watch?._tag !== "post" || row.scheduled_task_id === null)
              return;
            yield* sql`
              INSERT OR IGNORE INTO bot_watch_posts
                (task_id, scheduled_task_id, occasion_key, occasion, items_json, posted_at)
              VALUES (${row.task_id}, ${row.scheduled_task_id}, ${watch.occasionKey},
                ${watch.occasion}, ${BotWatch.encodeItems(watch.items)}, ${now})
            `;
            yield* sql`
              DELETE FROM bot_watch_posts WHERE scheduled_task_id = ${row.scheduled_task_id}
                AND task_id NOT IN (
                  SELECT task_id FROM bot_watch_posts WHERE scheduled_task_id = ${row.scheduled_task_id}
                  ORDER BY posted_at DESC, task_id DESC LIMIT ${WATCH_POSTS_KEPT})
            `;
          }),
        )
        .pipe(Effect.mapError(storageError));
      // Before the status goes out, so a client reading the pool for it sees the worktree free.
      if (terminal && row.worktree_state === "held") yield* releaseWorktreeLogged(row);
      yield* publish(row);
      if (!terminal) return;
    }
    const current = yield* readRow(row.task_id);
    if (current === undefined || current.completed_at === null || current.notified_at !== null) {
      return;
    }
    // Before the notification, which is retried until it lands, so a crash cannot skip it.
    yield* admitDiagnosis(current);
    yield* fileWaiting(current);
    if (current.quiet === 1) {
      // Nothing new means nothing to notice: the run's thread leaves the thread list too. Not
      // one the user has since written in: archiving would end their follow-up.
      const work =
        current.work_thread_id === null
          ? null
          : yield* threads
              .getThreadShell(ThreadId.make(current.work_thread_id))
              .pipe(Effect.mapError(botError("Failed to read the Bot task's work thread.")));
      if (
        work != null &&
        work.archivedAt === null &&
        current.result_run_id !== null &&
        work.latestRunId === current.result_run_id
      )
        yield* threads
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make(`bot-watch-quiet:${current.task_id}`),
            threadId: work.id,
            ifLatestRunId: RunId.make(current.result_run_id),
          })
          .pipe(
            // Any other failure leaves the task unsettled: the next pass archives, or finds above
            // that the thread moved on. Only a refusal stored on the command id is final.
            Effect.catchTags({
              OrchestratorCommandPreviouslyRejectedError: (error) =>
                Effect.logWarning("Quiet watch run's thread was not archived", {
                  taskId: current.task_id,
                  detail: error.detail,
                }),
            }),
          );
    } else if (current.status !== "cancelled") {
      // The result stays in the work thread; the home conversation shows its card and turns unread.
      const home = yield* threads
        .getThreadShell(ThreadId.make(current.home_thread_id))
        .pipe(Effect.mapError(botError("Failed to read the Bot task's Home thread.")));
      // Mark unread refuses a Home whose latest run has not ended; a later pass marks it.
      if (home?.latestRunId != null && home.latestRunCompletedAt == null) return;
      yield* threads
        .dispatch({
          type: "thread.mark-unread",
          commandId: CommandId.make(`${BOT_TASK_NOTIFY_COMMAND_PREFIX}${current.task_id}`),
          threadId: ThreadId.make(current.home_thread_id),
        })
        .pipe(
          // A refusal is stored on the command id and replays on every retry.
          Effect.catchTags({
            OrchestratorCommandPreviouslyRejectedError: (error) =>
              Effect.logWarning("Bot task Home notification was refused", {
                taskId: current.task_id,
                detail: error.detail,
              }),
          }),
        );
    }
    // When the result run ended: work that ended before early checks were on is not owed one.
    const asks =
      current.quiet !== 1 &&
      (yield* earlyCheckEnabled(current.home_thread_id)) &&
      (yield* requestsHomeCheck(current).pipe(Effect.mapError(storageError)));
    const endedAt = asks ? yield* resultEndedAt(current) : null;
    const now = yield* nowIso;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const notified = yield* sql`
            UPDATE bot_tasks SET notified_at = ${now}
            WHERE task_id = ${current.task_id} AND notified_at IS NULL RETURNING task_id
          `;
          if (notified.length > 0 && endedAt !== null)
            yield* recordHomeCheckOutcome(current, endedAt);
        }),
      )
      .pipe(Effect.mapError(storageError));
  });

  /** A finished task's work thread with no run and no background work left. */
  const workThreadIdle = (shell: OrchestrationV2ThreadShell | null) =>
    shell === null ||
    shell.deletedAt !== null ||
    (shell.status !== "idle" &&
      (shell.pendingBackgroundTasks?.length ?? 0) === 0 &&
      isTerminal(deriveTaskStatus({ cancelRequested: false, shell })));

  /**
   * Gives a finished task's worktree back to the pool once its work thread is idle: after the task
   * ended, and again after each follow-up. Under the workspace lease, as turn start, so a follow-up
   * that starts meanwhile either finds the worktree in place or restores it after.
   */
  const releaseWorktree = Effect.fn("BotTaskService.releaseWorktree")(function* (row: BotTaskRow) {
    // A dispatch still under way owns the claim it is launching into.
    if (row.work_thread_id === null || (yield* Ref.get(dispatching)).has(row.task_id)) return;
    const workThreadId = ThreadId.make(row.work_thread_id);
    const readShell = threads
      .getThreadShell(workThreadId)
      .pipe(Effect.mapError(botError("Failed to read the Bot task's work thread.")));
    const shell = yield* readShell;
    if (!workThreadIdle(shell)) return;
    const released = sql`
      UPDATE bot_tasks SET worktree_state = 'released' WHERE task_id = ${row.task_id}
    `.pipe(Effect.mapError(storageError));
    // A task that failed before its launch recorded the worktree still holds its claim.
    const worktreePath =
      shell?.worktreePath ??
      (yield* worktrees
        .claimedPath(workThreadId)
        .pipe(Effect.mapError((cause) => botError(cause.message)(cause))));
    if (worktreePath === null) return yield* released;
    const branch = row.branch ?? taskBranchName(row);
    const savedWork = yield* withWorkspaceLease(
      path.resolve(worktreePath),
      Effect.gen(function* () {
        // Setup finishes before the agent starts, so a run that never started may have left the
        // install unfinished; the next task in this worktree runs it again.
        const current = yield* readShell;
        if (!workThreadIdle(current)) return null;
        if (current?.latestRunStartedAt == null)
          yield* sql`UPDATE bot_tasks SET setup_signature = NULL WHERE task_id = ${row.task_id}`.pipe(
            Effect.mapError(storageError),
          );
        const parked = yield* worktrees
          .park({
            projectId: ProjectId.make(row.project_id),
            workThreadId,
            worktreePath,
            commitMessage: `WIP: ${row.title}\n\nSaved by T3 Code when the Bot task's work stopped.`,
            wipBranch: `${branch}-wip-${DateTime.toEpochMillis(yield* DateTime.now)}`,
          })
          .pipe(Effect.mapError((cause) => botError(cause.message)(cause)));
        yield* sql`
          UPDATE bot_tasks SET worktree_state = 'released',
            unfinished_work = MAX(unfinished_work, ${parked.savedWork ? 1 : 0}),
            branch = COALESCE(${parked.savedOn}, branch)
          WHERE task_id = ${row.task_id}
        `.pipe(Effect.mapError(storageError));
        // Work saved from a detached HEAD is on its own branch; the card and a follow-up use it.
        if (parked.savedOn !== null)
          yield* threads
            .dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`bot-task-wip-branch:${row.task_id}:${parked.savedOn}`),
              threadId: workThreadId,
              branch: parked.savedOn,
            })
            .pipe(Effect.mapError(botError("Failed to record the Bot task's WIP branch.")));
        return parked.savedWork;
      }),
    );
    if (savedWork === true) yield* publish(row);
  });

  // A failed release leaves the worktree held; the next pass tries again.
  const releaseWorktreeLogged = (row: BotTaskRow) =>
    releaseWorktree(row).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Bot task worktree release failed", { taskId: row.task_id, cause }),
      ),
    );

  const releaseWorktrees = Effect.gen(function* () {
    const held = yield* sql<BotTaskRow>`
      SELECT * FROM bot_tasks WHERE worktree_state = 'held' AND completed_at IS NOT NULL
    `.pipe(Effect.mapError(storageError));
    yield* Effect.forEach(held, releaseWorktreeLogged, { discard: true });
    yield* worktrees.expire.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Bot worktree expiry failed", { cause })),
    );
  }).pipe(Effect.withSpan("BotTaskService.releaseWorktrees"));

  const worktreePool: BotTaskService["Service"]["worktreePool"] = Effect.fn(
    "BotTaskService.worktreePool",
  )(function* (projectId) {
    const parked = yield* worktrees
      .parkedPaths(projectId)
      .pipe(Effect.mapError((cause) => botError(cause.message)(cause)));
    const held = yield* sql<{ readonly work_thread_id: string }>`
      SELECT work_thread_id FROM bot_tasks
      WHERE project_id = ${projectId} AND worktree_state = 'held' AND work_thread_id IS NOT NULL
    `.pipe(Effect.mapError(storageError));
    const inUse = yield* Effect.forEach(held, (row) =>
      threads.getThreadShell(ThreadId.make(row.work_thread_id)).pipe(
        Effect.map((shell) => shell?.worktreePath ?? null),
        Effect.orElseSucceed(() => null),
      ),
    );
    return {
      projectId,
      parked: parked.length,
      inUse: held.length,
      bytes: yield* worktrees.measure([
        ...parked,
        ...inUse.filter((worktreePath) => worktreePath !== null),
      ]),
    };
  });

  const clearWorktreePool: BotTaskService["Service"]["clearWorktreePool"] = Effect.fn(
    "BotTaskService.clearWorktreePool",
  )(function* (projectId) {
    const removed = yield* worktrees
      .clear(projectId)
      .pipe(Effect.mapError((cause) => botError(cause.message)(cause)));
    return { removed, pool: yield* worktreePool(projectId) };
  });

  const reconcile: BotTaskService["Service"]["reconcile"] = Effect.gen(function* () {
    const open = yield* sql<BotTaskRow>`
      SELECT * FROM bot_tasks WHERE completed_at IS NULL OR notified_at IS NULL
        OR (return_home_run_id IS NOT NULL AND return_finished_at IS NULL)
      ORDER BY rowid
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
    // After the tasks: one that ended in this pass gives its worktree back in the same pass.
    yield* releaseWorktrees;
  }).pipe(Effect.withSpan("BotTaskService.reconcile"));

  yield* scheduler.register("bot-tasks", reconcile);

  return BotTaskService.of({
    start,
    admitRoutine,
    requireRunnable,
    requireSupportedModel,
    get,
    getResult,
    getAwarenessTasks,
    list,
    subscribeList,
    cancel,
    cancelForContext,
    reconcile,
    worktreePool,
    clearWorktreePool,
    changes: PubSub.subscribe(changes).pipe(
      Effect.map((subscription) =>
        Stream.fromSubscription(subscription).pipe(Stream.map((change) => change.taskId)),
      ),
    ),
  });
});

export const layer = Layer.effect(BotTaskService, make).pipe(
  Layer.provide(Layer.merge(BotStore.layer, BotContinuation.layer)),
);

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
