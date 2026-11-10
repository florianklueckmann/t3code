import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { MCP_CONNECTIONS_MAX, McpConnectionId } from "./mcpConnection.ts";
import { ModelSelection, ModelSelectionInput } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/** No colons: the server derives home thread ids from the Bot and project ids. */
export const BotId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
).pipe(Schema.brand("BotId"));
export type BotId = typeof BotId.Type;

export const BOT_HOME_THREAD_ID_PREFIX = "bot-home:";

/**
 * A cheap check before loading Bot data for a thread. It is not membership:
 * only a matching Bot project context proves the thread is a home conversation.
 */
export function mayBeBotHomeThreadId(threadId: string): boolean {
  return threadId.startsWith(BOT_HOME_THREAD_ID_PREFIX);
}

export const BOT_WORK_THREAD_ID_PREFIX = "bot-work:";

/** Like `mayBeBotHomeThreadId`: only the Bot's task list proves which Bot it belongs to. */
export function mayBeBotWorkThreadId(threadId: string): boolean {
  return threadId.startsWith(BOT_WORK_THREAD_ID_PREFIX);
}

const BOT_NAME_MAX_CHARS = 80;
const BOT_INSTRUCTIONS_MAX_CHARS = 16_000;
const BOT_SOURCE_PREFERENCES_MAX = 50;

/** How learning becomes active: on its own, or only after the user adopts it. */
export const BotLearningPolicy = Schema.Literals(["automatic", "after_adoption"]);
export type BotLearningPolicy = typeof BotLearningPolicy.Type;

const BotName = TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_NAME_MAX_CHARS));
const BotInstructions = TrimmedString.check(Schema.isMaxLength(BOT_INSTRUCTIONS_MAX_CHARS));

/**
 * A source the Bot prefers for a project. It is guidance for research and
 * answers, not an allowlist: the Bot may use other sources when these do not
 * answer the question.
 */
export const BotSourcePreference = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  /** A path, URL or tool name, as the user wrote it. */
  location: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type BotSourcePreference = typeof BotSourcePreference.Type;

const BotSourcePreferences = Schema.Array(BotSourcePreference).check(
  Schema.isMaxLength(BOT_SOURCE_PREFERENCES_MAX),
);

export const BOT_APPEARANCE_COLORS = [
  "teal",
  "sky",
  "violet",
  "pink",
  "orange",
  "amber",
  "lime",
  "gray",
] as const;
export const BOT_APPEARANCE_FACES = [
  "happy",
  "sleepy",
  "wink",
  "curious",
  "joy",
  "focused",
] as const;
export const BOT_APPEARANCE_TOPPERS = ["none", "antenna", "ears", "sprout", "bow"] as const;

/** How a Bot looks in clients. Presentation only: it never reaches the model. */
export const BotAppearance = Schema.Struct({
  color: Schema.Literals(BOT_APPEARANCE_COLORS),
  face: Schema.Literals(BOT_APPEARANCE_FACES),
  topper: Schema.Literals(BOT_APPEARANCE_TOPPERS),
});
export type BotAppearance = typeof BotAppearance.Type;

const BotAppearanceValue = Schema.String.check(Schema.isMaxLength(32));

/**
 * A stored look as read back. Values stay plain strings so a client older than a
 * newly added option still decodes the Bot, then falls back per field.
 */
export const ReceivedBotAppearance = Schema.Struct({
  color: BotAppearanceValue,
  face: BotAppearanceValue,
  topper: BotAppearanceValue,
});
export type ReceivedBotAppearance = typeof ReceivedBotAppearance.Type;

export const BotProjectContextSummary = Schema.Struct({
  projectId: ProjectId,
  homeThreadId: ThreadId,
  attachedAt: IsoDateTime,
  detachedAt: Schema.NullOr(IsoDateTime),
});
export type BotProjectContextSummary = typeof BotProjectContextSummary.Type;

export const BotProjectContext = Schema.Struct({
  ...BotProjectContextSummary.fields,
  guidance: BotInstructions,
  sources: BotSourcePreferences,
  updatedAt: IsoDateTime,
});
export type BotProjectContext = typeof BotProjectContext.Type;

export const BotLearningEntryId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
).pipe(Schema.brand("BotLearningEntryId"));
export type BotLearningEntryId = typeof BotLearningEntryId.Type;

/**
 * fact: factual knowledge, refreshed when it changes. preference: how the user
 * wants work done. procedure: reusable steps for later work.
 */
export const BotLearningKind = Schema.Literals(["fact", "preference", "procedure"]);
export type BotLearningKind = typeof BotLearningKind.Type;

/**
 * instruction: the user's own standing instruction, active at once under either policy.
 * correction: a lesson inferred from the user correcting the Bot, governed by its policy.
 */
export const BotLearningOrigin = Schema.Literals(["instruction", "correction"]);
export type BotLearningOrigin = typeof BotLearningOrigin.Type;

/** project: only the project it was learned in. bot: every project the Bot serves. */
export const BotLearningScope = Schema.Literals(["project", "bot"]);
export type BotLearningScope = typeof BotLearningScope.Type;

/**
 * pending waits for the user, or for the task that proposed it to complete; active is in use;
 * superseded was replaced by a later revision; stale was proposed against a revision that has
 * since changed; diagnostic came from a task that did not complete, so it is not eligible.
 */
export const BotLearningStatus = Schema.Literals([
  "pending",
  "active",
  "rejected",
  "retired",
  "superseded",
  "stale",
  "diagnostic",
]);
export type BotLearningStatus = typeof BotLearningStatus.Type;

export const BotTaskId = TrimmedNonEmptyString.pipe(Schema.brand("BotTaskId"));
export type BotTaskId = typeof BotTaskId.Type;

/** Who recorded a revision, resolved by the server rather than claimed by the caller. */
export const BotLearningSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
  Schema.Struct({ kind: Schema.Literal("agent"), label: Schema.String }),
  /** A Bot's work thread; eligible only once that task completed. */
  Schema.Struct({ kind: Schema.Literal("task"), taskId: BotTaskId }),
]);
export type BotLearningSource = typeof BotLearningSource.Type;

const BotLearningText = TrimmedNonEmptyString.check(Schema.isMaxLength(1_000));
const BotLearningNote = TrimmedString.check(Schema.isMaxLength(2_000));

export const BotLearningRevision = Schema.Struct({
  revision: PositiveInt,
  text: BotLearningText,
  rationale: BotLearningNote,
  evidence: BotLearningNote,
  origin: BotLearningOrigin,
  source: BotLearningSource,
  learnedInProjectId: ProjectId,
  status: BotLearningStatus,
  /** The revision this one was proposed to replace; null for an entry's first revision. */
  baseRevision: Schema.NullOr(PositiveInt),
  /** An inferred revision that would override a standing instruction waits for the user. */
  conflictsWithInstruction: Schema.Boolean,
  createdAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
});
export type BotLearningRevision = typeof BotLearningRevision.Type;

export const BotLearningEntry = Schema.Struct({
  id: BotLearningEntryId,
  /** Null when the entry is shared across all of the Bot's projects. */
  projectId: Schema.NullOr(ProjectId),
  kind: BotLearningKind,
  /** Oldest first. */
  revisions: Schema.Array(BotLearningRevision),
});
export type BotLearningEntry = typeof BotLearningEntry.Type;

/**
 * The environment's MCP connections a Bot's threads may use, and nothing else. Only these load,
 * with their credentials resolved at each load; the provider's own MCP servers stay off.
 */
export const BotMcpGrants = Schema.Struct({
  /** Advances on every change to the set. */
  revision: NonNegativeInt,
  connectionIds: Schema.Array(McpConnectionId),
});
export type BotMcpGrants = typeof BotMcpGrants.Type;

export const BotSummary = Schema.Struct({
  id: BotId,
  name: BotName,
  modelSelection: ModelSelection,
  learningPolicy: BotLearningPolicy,
  /** Null uses the default derived from the Bot id; absent on servers without appearance. */
  appearance: Schema.optionalKey(Schema.NullOr(ReceivedBotAppearance)),
  /** Absent on servers without grants: the feature is unavailable, not an empty grant set. */
  mcpGrants: Schema.optionalKey(BotMcpGrants),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  projects: Schema.Array(BotProjectContextSummary),
  /** Learning revisions waiting for the user to adopt or reject them. */
  pendingLearning: NonNegativeInt,
});
export type BotSummary = typeof BotSummary.Type;

export const BotDetail = Schema.Struct({
  ...BotSummary.fields,
  instructions: BotInstructions,
  projects: Schema.Array(BotProjectContext),
  learning: Schema.Array(BotLearningEntry),
});
export type BotDetail = typeof BotDetail.Type;

export const BotListInput = Schema.Struct({});
export type BotListInput = typeof BotListInput.Type;

export const BotListResult = Schema.Struct({
  bots: Schema.Array(BotSummary),
});
export type BotListResult = typeof BotListResult.Type;

export const BotGetInput = Schema.Struct({ botId: BotId });
export type BotGetInput = typeof BotGetInput.Type;

export const BotCreateInput = Schema.Struct({
  /** Chosen by the client so a retried create is idempotent. */
  botId: BotId,
  name: BotName,
  instructions: BotInstructions,
  modelSelection: ModelSelection,
  learningPolicy: BotLearningPolicy,
  appearance: Schema.optional(Schema.NullOr(BotAppearance)),
});
export type BotCreateInput = typeof BotCreateInput.Type;

export const BotUpdateInput = Schema.Struct({
  botId: BotId,
  name: Schema.optional(BotName),
  instructions: Schema.optional(BotInstructions),
  modelSelection: Schema.optional(ModelSelection),
  learningPolicy: Schema.optional(BotLearningPolicy),
  /** Null returns the Bot to its default look. */
  appearance: Schema.optional(Schema.NullOr(BotAppearance)),
});
export type BotUpdateInput = typeof BotUpdateInput.Type;

/** Replaces the whole grant set. Only connections currently in the catalog can be granted. */
export const BotSetMcpGrantsInput = Schema.Struct({
  botId: BotId,
  expectedRevision: NonNegativeInt,
  connectionIds: Schema.Array(McpConnectionId).check(Schema.isMaxLength(MCP_CONNECTIONS_MAX)),
});
export type BotSetMcpGrantsInput = typeof BotSetMcpGrantsInput.Type;

export const BotSetArchivedInput = Schema.Struct({
  botId: BotId,
  archived: Schema.Boolean,
});
export type BotSetArchivedInput = typeof BotSetArchivedInput.Type;

/** Attaches a project, or reattaches a detached one with its earlier conversation. */
export const BotAttachProjectInput = Schema.Struct({
  botId: BotId,
  projectId: ProjectId,
  guidance: Schema.optional(BotInstructions),
  sources: Schema.optional(BotSourcePreferences),
});
export type BotAttachProjectInput = typeof BotAttachProjectInput.Type;

export const BotUpdateProjectContextInput = Schema.Struct({
  botId: BotId,
  projectId: ProjectId,
  guidance: Schema.optional(BotInstructions),
  sources: Schema.optional(BotSourcePreferences),
});
export type BotUpdateProjectContextInput = typeof BotUpdateProjectContextInput.Type;

export const BotDetachProjectInput = Schema.Struct({
  botId: BotId,
  projectId: ProjectId,
});
export type BotDetachProjectInput = typeof BotDetachProjectInput.Type;

export const BotLearningRevisionRef = Schema.Struct({
  entryId: BotLearningEntryId,
  revision: PositiveInt,
});
export type BotLearningRevisionRef = typeof BotLearningRevisionRef.Type;

/** A standing instruction the user records directly; it is active at once. */
export const BotRecordLearningInput = Schema.Struct({
  botId: BotId,
  /** The project it was learned in; also its scope unless `scope` is "bot". */
  projectId: ProjectId,
  scope: Schema.optional(BotLearningScope),
  kind: BotLearningKind,
  text: BotLearningText,
  rationale: Schema.optional(BotLearningNote),
  evidence: Schema.optional(BotLearningNote),
  /** The current revision of the entry this one revises. */
  replaces: Schema.optional(BotLearningRevisionRef),
});
export type BotRecordLearningInput = typeof BotRecordLearningInput.Type;

export const BotDecideLearningInput = Schema.Struct({
  botId: BotId,
  ...BotLearningRevisionRef.fields,
  decision: Schema.Literals(["adopt", "reject"]),
});
export type BotDecideLearningInput = typeof BotDecideLearningInput.Type;

export const BotRetireLearningInput = Schema.Struct({
  botId: BotId,
  entryId: BotLearningEntryId,
});
export type BotRetireLearningInput = typeof BotRetireLearningInput.Type;

/** Makes an earlier revision current again, as a new revision. */
export const BotRestoreLearningInput = Schema.Struct({
  botId: BotId,
  ...BotLearningRevisionRef.fields,
});
export type BotRestoreLearningInput = typeof BotRestoreLearningInput.Type;

export class BotError extends Schema.TaggedError<BotError>()("BotError", {
  message: Schema.String,
  botId: Schema.optional(BotId),
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * Derived from the work thread's persisted runs, not from schedule acknowledgement or the
 * settled flag. `accepted` covers admitted work whose run has not started yet.
 */
export const BotTaskStatus = Schema.Literals([
  "accepted",
  "running",
  "waiting",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "skipped",
]);
export type BotTaskStatus = typeof BotTaskStatus.Type;

export const BOT_TASK_TERMINAL_STATUSES: ReadonlySet<BotTaskStatus> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "skipped",
]);

/** `direct` was asked for; `routine` comes from one of the Bot's scheduled routines. */
export const BotTaskOrigin = Schema.Literals(["direct", "routine"]);
export type BotTaskOrigin = typeof BotTaskOrigin.Type;

export const BotTaskSummary = Schema.Struct({
  id: BotTaskId,
  botId: BotId,
  projectId: ProjectId,
  homeThreadId: ThreadId,
  /** Null when the task never started, such as a skipped occurrence. */
  workThreadId: Schema.NullOr(ThreadId),
  origin: BotTaskOrigin,
  title: TrimmedNonEmptyString,
  scheduledTaskId: Schema.NullOr(ScheduledTaskId),
  occurrenceDueAt: Schema.NullOr(IsoDateTime),
  sessionAt: Schema.NullOr(IsoDateTime),
  runtimeMode: RuntimeMode,
  status: BotTaskStatus,
  /** Why a task was skipped or failed to start. */
  detail: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  returnToHome: Schema.optional(Schema.Boolean),
  /**
   * What a direct task runs on: its own selection, or the Bot's when it was started. Absent for
   * routines, which follow the Bot, and for tasks started before this was recorded.
   */
  modelSelection: Schema.optional(ModelSelection),
  /**
   * "none" when the task was admitted as a No changes routine run, which no thread mode lifts.
   * Absent from servers that predate enforcement, where nothing restricted the task.
   */
  changes: Schema.optional(Schema.NullOr(Schema.Literal("none"))),
});
export type BotTaskSummary = typeof BotTaskSummary.Type;

export const BotTaskListInput = Schema.Struct({
  botId: Schema.optional(BotId),
  projectId: Schema.optional(ProjectId),
  workThreadId: Schema.optional(ThreadId),
});
export type BotTaskListInput = typeof BotTaskListInput.Type;

export const BotTaskListResult = Schema.Struct({
  tasks: Schema.Array(BotTaskSummary),
});
export type BotTaskListResult = typeof BotTaskListResult.Type;

export const BotStartTaskInput = Schema.Struct({
  botId: BotId,
  projectId: ProjectId,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_INSTRUCTIONS_MAX_CHARS)),
  title: Schema.optional(BotName),
  /** Runs only this task on that model and options; omitted follows the Bot. */
  modelSelection: Schema.optional(ModelSelectionInput),
  /** Makes a retried start return the same task. */
  commandId: Schema.optional(CommandId),
});
export type BotStartTaskInput = typeof BotStartTaskInput.Type;

export const BotCancelTaskInput = Schema.Struct({ taskId: BotTaskId });
export type BotCancelTaskInput = typeof BotCancelTaskInput.Type;

export const BotTaskResultInput = Schema.Struct({ taskId: BotTaskId });
export type BotTaskResultInput = typeof BotTaskResultInput.Type;

export const BotTaskResult = Schema.Struct({
  task: BotTaskSummary,
  result: Schema.Union([
    Schema.Struct({ state: Schema.Literal("available"), runId: RunId, text: Schema.String }),
    Schema.Struct({ state: Schema.Literal("empty"), runId: RunId }),
    Schema.Struct({ state: Schema.Literal("unavailable") }),
    Schema.Struct({ state: Schema.Literal("not_completed") }),
  ]),
});
export type BotTaskResult = typeof BotTaskResult.Type;
