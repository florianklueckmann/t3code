/**
 * Tells a Bot's own Home about each task it started: one message when a task completes, fails,
 * is interrupted or waits on a question. The message comes from the task's work thread, so it
 * waits until the Home's running turn ends, and its id folds it into an automation row.
 */
import {
  BOT_TASK_UPDATE_MESSAGE_ID_PREFIX,
  BotError,
  BotTaskId,
  type BotTaskSummary,
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import { evidenceSummary } from "./BotTaskAcceptance.ts";
import * as BotTaskService from "./BotTaskService.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";

const RESULT_CHARS = 2_000;
const DETAIL_CHARS = 1_000;

interface UpdateRow {
  readonly task_id: string;
  readonly status: string;
  readonly result_run_id: string | null;
  readonly work_thread_id: string | null;
  readonly home_thread_id: string;
  readonly home_project_id: string;
  readonly home_detached_at: string | null;
  readonly bot_archived_at: string | null;
  readonly update_key: string | null;
}

export class BotHomeUpdates extends Context.Service<
  BotHomeUpdates,
  {
    /** Tells the task's Home about its current status, unless it was told already. */
    readonly deliver: (taskId: BotTaskId) => Effect.Effect<void, BotError>;
    /** Delivers every update still owed: after a restart, and for a send that failed. */
    readonly deliverOwed: Effect.Effect<void, BotError>;
  }
>()("t3/bots/BotHomeUpdates") {}

const isBotError = Schema.is(BotError);
const storageError = (cause: unknown) =>
  isBotError(cause) ? cause : new BotError({ message: "Bot Home update storage failed.", cause });

const clip = (text: string, chars: number) => {
  const trimmed = text.trim();
  return trimmed.length <= chars ? trimmed : `${trimmed.slice(0, chars - 1)}…`;
};

const ANSWERED: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted"]);

const ANSWERED_CARD = Symbol("answered");

/** The question a waiting work thread asks, from its pending request's card, unless it ended. */
const questionOf = (items: ReadonlyArray<OrchestrationV2TurnItem>, requestId: string) => {
  for (const item of items) {
    if (
      (item.type === "user_input_request" || item.type === "approval_request") &&
      item.requestId === requestId &&
      ANSWERED.has(item.status)
    )
      return ANSWERED_CARD;
    if (item.type === "user_input_request" && item.requestId === requestId)
      return item.questions.map((question) => question.question).join(" ");
    if (item.type === "approval_request" && item.requestId === requestId)
      return `Approval: ${item.prompt ?? item.reason ?? item.requestKind}`;
  }
  return null;
};

/** What the Home reads. Model-facing. */
function updateText(input: {
  readonly task: Pick<
    BotTaskSummary,
    "id" | "title" | "projectId" | "status" | "workThreadId" | "branch" | "acceptance" | "detail"
  >;
  readonly projectTitle: string;
  readonly result: string | null;
  readonly question: string | null;
  readonly runError: string | null;
}) {
  const { task } = input;
  const acceptance = task.acceptance;
  const questions = acceptance?.report?.openQuestions ?? [];
  const failure =
    task.status === "failed" || task.status === "interrupted"
      ? (task.detail ?? input.runError)
      : null;
  return [
    "T3 Code: task update from the server.",
    `Recorded status: ${task.status}${acceptance?.state === "needs_you" ? " · needs you" : ""}`,
    `Task: “${task.title}” (${task.id})`,
    `Project: ${input.projectTitle} (${task.projectId})`,
    task.workThreadId === null ? null : `Work thread: ${task.workThreadId}`,
    task.branch === undefined ? null : `Branch: ${task.branch}`,
    acceptance === undefined
      ? null
      : `Evidence: ${clip(evidenceSummary(acceptance), DETAIL_CHARS)}`,
    acceptance?.missing.length ? `Needs review: ${acceptance.missing.join(" ")}` : null,
    questions.length === 0 ? null : `Open questions: ${questions.join(" ")}`,
    input.result === null ? null : `Worker report: ${clip(input.result, RESULT_CHARS)}`,
    failure == null ? null : `What went wrong: ${clip(failure, DETAIL_CHARS)}`,
    input.question === null ? null : `Question: ${clip(input.question, DETAIL_CHARS)}`,
    "",
    "Report only this task, naming its project and task. If it asks a question, pass that question on now. You cannot answer a task's question for the user: they answer it in the task's work thread, from its card.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

const make = Effect.gen(function* () {
  const sql = yield* BotDatabase.BotDatabase;
  const tasks = yield* BotTaskService.BotTaskService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const scheduler = yield* Scheduler.Scheduler;
  // The change stream and the scheduler pass can both find one update; one sends at a time.
  const sending = yield* Semaphore.make(1);

  const updateRows = (where: Statement.Fragment) =>
    sql<UpdateRow>`
      SELECT t.task_id, t.status, t.result_run_id, t.work_thread_id, t.home_thread_id,
        c.project_id AS home_project_id, c.detached_at AS home_detached_at,
        b.archived_at AS bot_archived_at, u.update_key
      FROM bot_tasks t
      JOIN bot_project_contexts c ON c.home_thread_id = t.home_thread_id AND c.kind = 'bot'
      JOIN bots b ON b.bot_id = t.bot_id
      LEFT JOIN bot_home_updates u ON u.task_id = t.task_id
      WHERE t.quiet = 0 AND t.work_thread_id IS NOT NULL
        AND t.status IN ('completed', 'failed', 'interrupted', 'waiting') AND ${where}
    `.pipe(Effect.mapError(storageError));

  const readShell = (threadId: string) =>
    threads
      .getThreadShell(ThreadId.make(threadId))
      .pipe(
        Effect.mapError(
          (cause) => new BotError({ message: "Failed to read the Bot task's work thread.", cause }),
        ),
      );

  /** Which event the task's status is, stable across retries; null when there is none to tell. */
  const eventKey = (row: UpdateRow, shell: OrchestrationV2ThreadShell | null) => {
    if (row.status !== "waiting") return `${row.status}:${row.result_run_id ?? ""}`;
    // A question is its pending request; the task's status may lag behind its thread.
    if (shell?.pendingRuntimeRequest == null) return null;
    return `waiting:${shell.pendingRuntimeRequest.id}`;
  };

  const record = (taskId: string, key: string) =>
    DateTime.now.pipe(
      Effect.flatMap(
        (now) => sql`
          INSERT INTO bot_home_updates (task_id, update_key, sent_at)
          VALUES (${taskId}, ${key}, ${DateTime.formatIso(now)})
          ON CONFLICT (task_id) DO UPDATE SET update_key = excluded.update_key, sent_at = excluded.sent_at
        `,
      ),
      Effect.mapError(storageError),
    );

  const deliverRow = Effect.fn("BotHomeUpdates.deliverRow")(function* (row: UpdateRow) {
    if (row.work_thread_id === null) return;
    const task = yield* tasks.get(BotTaskId.make(row.task_id));
    // It moved on since the row was read; that status is told on its own.
    if (task.status !== row.status) return;
    const shell =
      row.status === "waiting" || row.status === "failed"
        ? yield* readShell(row.work_thread_id)
        : null;
    const key = eventKey(row, shell);
    if (key === null || key === row.update_key) return;
    // A removed Home or an archived Bot has nobody to tell; a later reopening is not owed it.
    if (row.home_detached_at !== null || row.bot_archived_at !== null)
      return yield* record(row.task_id, key);
    const result =
      task.status === "completed"
        ? (task.acceptance?.report?.result ??
          (yield* tasks
            .getResult({ taskId: task.id })
            .pipe(Effect.map(({ result }) => (result.state === "available" ? result.text : null)))))
        : null;
    const requestId = shell?.pendingRuntimeRequest?.id;
    const question =
      requestId === undefined || shell?.latestRunId == null
        ? null
        : questionOf(
            yield* threads
              .getProjectThreadRecords(
                { projectId: task.projectId, threadId: ThreadId.make(row.work_thread_id) },
                ["turnItems"],
                {
                  turnItemRunIds: [shell.latestRunId],
                  turnItemTypes: ["user_input_request", "approval_request"],
                },
              )
              .pipe(
                Effect.map((records) => records.turnItems),
                Effect.orElseSucceed(() => []),
              ),
            requestId,
          );
    // Answered since the shell was read: nothing waits on the user any more.
    if (question === ANSWERED_CARD) return;
    // The thread's last error is the saved run's only while that run is still its latest.
    const runError =
      shell !== null && shell.latestRunId === row.result_run_id ? (shell.lastError ?? null) : null;
    const project = yield* projects
      .getById(task.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const id = `${BOT_TASK_UPDATE_MESSAGE_ID_PREFIX}${row.task_id}:${key}`;
    const sent = yield* threads
      .sendToThread({
        projectId: ProjectId.make(row.home_project_id),
        commandId: CommandId.make(id),
        threadId: ThreadId.make(row.home_thread_id),
        messageId: MessageId.make(id),
        // From another thread, so a Bot Home queues it behind the turn that is running.
        senderThreadId: ThreadId.make(row.work_thread_id),
        text: updateText({
          task,
          projectTitle: Option.isSome(project) ? project.value.title : task.projectId,
          result,
          question,
          runError,
        }),
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.as(true),
        Effect.catchTags({ ThreadManagementThreadArchivedError: () => Effect.succeed(false) }),
        Effect.mapError(
          (cause) =>
            new BotError({ message: "Failed to tell the Bot's Home about a task.", cause }),
        ),
      );
    if (!sent) yield* Effect.logInfo("Bot Home update skipped: the Home is archived", { id });
    yield* record(row.task_id, key);
  });

  // Read under the permit, so a second caller sees what the first recorded.
  const deliver: BotHomeUpdates["Service"]["deliver"] = Effect.fn("BotHomeUpdates.deliver")(
    function* (taskId) {
      const [row] = yield* updateRows(sql`t.task_id = ${taskId}`);
      if (row !== undefined) yield* deliverRow(row);
    },
    sending.withPermits(1),
  );

  const deliverOwed: BotHomeUpdates["Service"]["deliverOwed"] = Effect.gen(function* () {
    // A waiting task is read each pass: its question is known only from its thread.
    const owed = yield* updateRows(
      sql`(u.update_key IS NULL OR u.update_key <> t.status || ':' || COALESCE(t.result_run_id, ''))`,
    );
    yield* Effect.forEach(
      owed,
      (row) =>
        deliver(BotTaskId.make(row.task_id)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Bot Home update failed", { taskId: row.task_id, cause }),
          ),
        ),
      { discard: true },
    );
  }).pipe(Effect.withSpan("BotHomeUpdates.deliverOwed"));

  const changes = yield* tasks.changes;
  yield* forkParked(
    Stream.runForEach(changes, (taskId) =>
      deliver(taskId).pipe(
        // The scheduler pass retries it.
        Effect.catchCause((cause) =>
          Effect.logWarning("Bot Home update failed", { taskId, cause }),
        ),
      ),
    ),
  );
  yield* scheduler.register("bot-home-updates", deliverOwed);

  return BotHomeUpdates.of({ deliver, deliverOwed });
});

export const layer = Layer.effect(BotHomeUpdates, make);
