import {
  BOT_CONTINUATION_SECTIONS,
  BOT_TURN_LEARNING_LIMITS,
  BotContinuationNoteInput,
  type BotContinuationNote,
  type BotContinuationRef,
  type BotContinuationRevision,
  type BotMaintenanceView,
  type BotHomeCheckView,
  type BotRecordLearningInput,
  selectBotTurnLearning,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type {
  BotId,
  BotLearningEntry,
  BotLearningKind,
  BotLearningRevision,
  BotLearningStatus,
  BotProjectContext,
  BotProjectContextSummary,
  BotSourcePreference,
  BotSummary,
  BotTaskResult,
  BotTaskStatus,
  BotTaskSummary,
  CommandId,
  ModelSelection,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** One editable preferred-source row. */
export interface BotSourceDraft {
  /** Stable row identity for the form; never sent to the server. */
  readonly id: string;
  readonly label: string;
  readonly location: string;
}

let lastBotSourceDraftId = 0;

export function emptyBotSourceDraft(): BotSourceDraft {
  return { id: `new-${++lastBotSourceDraftId}`, label: "", location: "" };
}

/** Ids follow position, so rows derived again from the same sources keep their identity. */
export function botSourceDrafts(
  sources: ReadonlyArray<BotSourcePreference>,
): ReadonlyArray<BotSourceDraft> {
  return sources.map((source, index) => ({ id: `saved-${index}`, ...source }));
}

/** Blank rows are dropped; a row with only a label or only a location blocks saving. */
export function parseBotSourceDrafts(
  drafts: ReadonlyArray<BotSourceDraft>,
): { readonly sources: ReadonlyArray<BotSourcePreference> } | { readonly error: string } {
  const sources: BotSourcePreference[] = [];
  for (const draft of drafts) {
    const label = draft.label.trim();
    const location = draft.location.trim();
    if (label === "" && location === "") continue;
    if (label === "" || location === "") {
      return { error: "Give every preferred source both a label and a location." };
    }
    sources.push({ label, location });
  }
  return { sources };
}

export interface BotProjectContextDraft {
  readonly guidance: string;
  readonly sources: ReadonlyArray<BotSourceDraft>;
}

export function botProjectContextDraft(
  saved: Pick<BotProjectContext, "guidance" | "sources">,
): BotProjectContextDraft {
  return { guidance: saved.guidance, sources: botSourceDrafts(saved.sources) };
}

/** The fields a draft changes against the saved context; null when nothing changed. */
export function botProjectContextChanges(
  draft: BotProjectContextDraft,
  saved: Pick<BotProjectContext, "guidance" | "sources">,
):
  | {
      readonly guidance?: string;
      readonly sources?: ReadonlyArray<BotSourcePreference>;
    }
  | { readonly error: string }
  | null {
  const parsed = parseBotSourceDrafts(draft.sources);
  if ("error" in parsed) return parsed;
  const guidance = draft.guidance.trim();
  const guidanceChanged = guidance !== saved.guidance;
  const sourcesChanged = JSON.stringify(parsed.sources) !== JSON.stringify(saved.sources);
  if (!guidanceChanged && !sourcesChanged) return null;
  return {
    ...(guidanceChanged ? { guidance } : {}),
    ...(sourcesChanged ? { sources: parsed.sources } : {}),
  };
}

export const BOT_LEARNING_KIND_LABELS: Record<BotLearningKind, string> = {
  fact: "Fact",
  preference: "Preference",
  procedure: "Procedure",
};

export const BOT_LEARNING_STATUS_LABELS: Record<BotLearningStatus, string> = {
  pending: "Waiting for you",
  active: "Active",
  rejected: "Rejected",
  retired: "Retired",
  superseded: "Replaced",
  stale: "Outdated",
  diagnostic: "Task didn't finish",
};

export function botLearningOriginLabel(revision: BotLearningRevision): string {
  if (revision.source.kind === "task") return "Proposed by a task";
  return revision.origin === "instruction" ? "Your instruction" : "Learned from a correction";
}

export interface BotLearningView {
  readonly entry: BotLearningEntry;
  /** The revision in use, if any. */
  readonly current: BotLearningRevision | undefined;
  /** Proposals waiting for the user to adopt or reject them, newest first. */
  readonly pending: ReadonlyArray<BotLearningRevision>;
  /** The newest revision, which names the entry when nothing is active. */
  readonly latest: BotLearningRevision;
  /** Earlier revisions the user can make current again, newest first. */
  readonly restorable: ReadonlyArray<BotLearningRevision>;
}

/**
 * The entries of one scope (a project, or null for those shared across projects): those
 * waiting for the user first, then active ones, then the rest.
 */
export function botLearningViews(
  entries: ReadonlyArray<BotLearningEntry>,
  projectId: ProjectId | null,
): ReadonlyArray<BotLearningView> {
  const views = entries.flatMap((entry): ReadonlyArray<BotLearningView> => {
    const latest = entry.revisions.at(-1);
    if (entry.projectId !== projectId || latest === undefined) return [];
    const newestFirst = [...entry.revisions].reverse();
    return [
      {
        entry,
        current: entry.revisions.find((revision) => revision.status === "active"),
        pending: newestFirst.filter((revision) => revision.status === "pending"),
        latest,
        restorable: newestFirst.filter(
          (revision) =>
            revision.status !== "active" &&
            revision.status !== "pending" &&
            revision.status !== "diagnostic",
        ),
      },
    ];
  });
  const rank = (view: BotLearningView) =>
    view.pending.length > 0 ? 0 : view.current !== undefined ? 1 : 2;
  return [...views].sort((a, b) => rank(a) - rank(b));
}

/** How a revision changes the projects its entry applies to, against the revision it replaces. */
export function botLearningScopeChange(
  entry: BotLearningEntry,
  revision: BotLearningRevision,
): "moves to all projects" | "moves to one project" | null {
  const base = entry.revisions.find((each) => each.revision === revision.baseRevision);
  if (base === undefined || base.projectId === revision.projectId) return null;
  return revision.projectId === null ? "moves to all projects" : "moves to one project";
}

export const BOT_LEARNING_LEFT_OUT_EXPLANATION = `Each turn includes at most ${
  BOT_TURN_LEARNING_LIMITS.entries
} lessons or ${BOT_TURN_LEARNING_LIMITS.chars.toLocaleString(
  "en-US",
)} characters: your instructions first, then the newest. Retire or merge lessons to make room.`;

/** Active entries that a Bot's turns in this project leave out, by the server's own rule. */
export function botLearningLeftOut(
  entries: ReadonlyArray<BotLearningEntry>,
  projectId: ProjectId,
): ReadonlyArray<{ readonly entry: BotLearningEntry; readonly current: BotLearningRevision }> {
  const active = entries.flatMap((entry) =>
    entry.revisions
      .filter((revision) => revision.status === "active")
      .map((current) => ({
        entry,
        current,
        entryId: entry.id,
        revision: current.revision,
        // An entry's scope is that of its active revision.
        projectId: entry.projectId,
        kind: entry.kind,
        origin: current.origin,
        status: current.status,
        text: current.text,
        createdAt: current.createdAt,
      })),
  );
  return selectBotTurnLearning(active, projectId).omitted;
}

/**
 * A new revision of an entry's active text: reworded, or moved to all projects with its
 * rationale and evidence. It is recorded from the entry's project, or for a shared entry from
 * an attached project; null when there is no active text or no such project.
 */
export function botLearningRevisionInput(
  bot: {
    readonly id: BotId;
    readonly projects: ReadonlyArray<Pick<BotProjectContextSummary, "projectId" | "detachedAt">>;
  },
  entry: BotLearningEntry,
  change: { readonly text: string } | { readonly scope: "bot" },
): BotRecordLearningInput | null {
  const current = entry.revisions.find((revision) => revision.status === "active");
  const attached = bot.projects.flatMap((project) =>
    project.detachedAt === null ? [project.projectId] : [],
  );
  const projectId =
    entry.projectId ??
    (current !== undefined && attached.includes(current.learnedInProjectId)
      ? current.learnedInProjectId
      : attached[0]);
  if (current === undefined || projectId === undefined) return null;
  const base = {
    botId: bot.id,
    projectId,
    kind: entry.kind,
    replaces: { entryId: entry.id, revision: current.revision },
  };
  return "scope" in change
    ? {
        ...base,
        text: current.text,
        rationale: current.rationale,
        evidence: current.evidence,
        scope: change.scope,
      }
    : { ...base, text: change.text.trim() };
}

export interface BotConversation {
  readonly bot: BotSummary;
  readonly context: BotProjectContextSummary;
}

/** Home conversations of Bots that are neither archived nor detached from the project. */
export function activeBotConversations(
  bots: ReadonlyArray<BotSummary>,
): ReadonlyArray<BotConversation> {
  return bots.flatMap((bot) =>
    bot.archivedAt !== null
      ? []
      : bot.projects.flatMap((context) => (context.detachedAt === null ? [{ bot, context }] : [])),
  );
}

/** The active Bot whose home conversation in `projectId` is `threadId`, if any. */
export function botOfHomeThread(
  bots: ReadonlyArray<BotSummary>,
  thread: { readonly id: string; readonly projectId: string },
): BotSummary | null {
  return (
    activeBotConversations(bots).find(
      ({ context }) => context.homeThreadId === thread.id && context.projectId === thread.projectId,
    )?.bot ?? null
  );
}

export interface RankedBotConversation<T> {
  readonly context: BotProjectContextSummary;
  /** Null until the environment's thread shells include the home conversation. */
  readonly thread: T | null;
}

/**
 * A Bot's attached home conversations, the one that needs the user most first, then the most
 * recently updated. Opening the Bot goes to the first; a Bot without projects has none.
 */
export function rankBotConversations<T extends { readonly updatedAt: string }>(
  bot: BotSummary,
  threadOf: (threadId: ThreadId) => T | null,
  urgency: (thread: T) => number,
): ReadonlyArray<RankedBotConversation<T>> {
  if (bot.archivedAt !== null) return [];
  const conversations = bot.projects.flatMap((context) =>
    context.detachedAt === null ? [{ context, thread: threadOf(context.homeThreadId) }] : [],
  );
  const urgencyOf = ({ thread }: RankedBotConversation<T>) =>
    thread === null ? -1 : urgency(thread);
  const updatedAtOf = ({ thread }: RankedBotConversation<T>) =>
    thread === null ? 0 : Date.parse(thread.updatedAt) || 0;
  return [...conversations].sort(
    (a, b) => urgencyOf(b) - urgencyOf(a) || updatedAtOf(b) - updatedAtOf(a),
  );
}

/** The active Bot that started this work thread, if it is one. */
export function botOfWorkThread(
  bots: ReadonlyArray<BotSummary>,
  tasks: ReadonlyArray<Pick<BotTaskSummary, "botId" | "workThreadId">>,
  threadId: string,
): BotSummary | null {
  const botId = tasks.find((task) => task.workThreadId === threadId)?.botId;
  if (botId === undefined) return null;
  return bots.find((bot) => bot.id === botId && bot.archivedAt === null) ?? null;
}

/** The Bot and project whose home conversation this thread is, attached or not. */
export function botConversationForThread(
  bots: ReadonlyArray<BotSummary>,
  threadId: ThreadId,
): BotConversation | null {
  for (const bot of bots) {
    const context = bot.projects.find((project) => project.homeThreadId === threadId);
    if (context !== undefined) return { bot, context };
  }
  return null;
}

/** Routines of one Bot in one project, from the environment's scheduled tasks. */
export function botRoutinesFor(
  tasks: ReadonlyArray<ScheduledTask>,
  botId: BotId,
  projectId: ProjectId,
): ReadonlyArray<ScheduledTask> {
  return tasks.filter((task) => task.bot?.botId === botId && task.projectId === projectId);
}

export const BOT_TASK_STATUS_LABELS: Readonly<Record<BotTaskStatus, string>> = {
  accepted: "Queued",
  running: "Working",
  waiting: "Needs input",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

export function botTaskResultNotice(result: BotTaskResult): string | null {
  switch (result.result.state) {
    case "available":
      return null;
    case "empty":
      return "This run completed without a saved final response.";
    case "unavailable":
      return "The saved result is unavailable. Older tasks may have no result reference, or their run may no longer be stored.";
    case "not_completed":
      switch (result.task.status) {
        case "accepted":
          return "This task is queued. There is no final result yet.";
        case "running":
          return "This task is still working. There is no final result yet.";
        case "waiting":
          return "This task needs input. Open the thread to continue.";
        case "failed":
          return "This task failed. Open the thread for details.";
        case "interrupted":
          return "This task was interrupted before it completed.";
        case "cancelled":
          return "This task was cancelled before it completed.";
        case "skipped":
          return "This task was skipped and has no result.";
        case "completed":
          return "The saved final response is unavailable.";
      }
  }
}

export const BOT_TASK_RESULT_UNSUPPORTED =
  "This server does not support saved Bot results. Open the thread to read the conversation.";

export function isBotTaskOpen(task: Pick<BotTaskSummary, "status">): boolean {
  return task.status === "accepted" || task.status === "running" || task.status === "waiting";
}

/**
 * Finished task cards hidden from a Bot's Home on this device. Display state only: the task,
 * its result and its work thread stay untouched, and other devices keep showing the card.
 */
export const HiddenBotTaskCards = Schema.Array(Schema.String);
export type HiddenBotTaskCards = typeof HiddenBotTaskCards.Type;

const HOME_BOT_TASK_CARD_LIMIT = 3;
const HIDDEN_BOT_TASK_CARDS_MAX = 200;

type HideableTask = Pick<BotTaskSummary, "id" | "botId" | "projectId" | "status" | "completedAt">;

const botTaskCardScope = (
  environmentId: string,
  task: Pick<BotTaskSummary, "botId" | "projectId">,
) => JSON.stringify([environmentId, task.botId, task.projectId]);

/**
 * The hidden-card key of a finished task, or null while it is still open. The key carries the
 * completion time, so a task that runs and finishes again shows up again.
 */
export function botTaskCardKey(environmentId: string, task: HideableTask): string | null {
  if (isBotTaskOpen(task) || task.completedAt === null) return null;
  return botTaskCardScope(environmentId, task) + JSON.stringify([task.id, task.completedAt]);
}

/** The newest tasks of one Home conversation, split into the cards shown and those hidden. */
export function homeBotTaskCards<Task extends HideableTask & Pick<BotTaskSummary, "homeThreadId">>(
  environmentId: string,
  tasks: ReadonlyArray<Task>,
  homeThreadId: ThreadId,
  hidden: HiddenBotTaskCards,
): { readonly visible: ReadonlyArray<Task>; readonly hiddenKeys: ReadonlyArray<string> } {
  const hiddenSet = new Set(hidden);
  const visible: Task[] = [];
  const hiddenKeys: string[] = [];
  for (const task of tasks
    .filter((candidate) => candidate.homeThreadId === homeThreadId)
    .slice(0, HOME_BOT_TASK_CARD_LIMIT)) {
    const key = botTaskCardKey(environmentId, task);
    if (key !== null && hiddenSet.has(key)) hiddenKeys.push(key);
    else visible.push(task);
  }
  return { visible, hiddenKeys };
}

export function hideBotTaskCard(
  hidden: HiddenBotTaskCards,
  environmentId: string,
  task: HideableTask,
): HiddenBotTaskCards {
  const key = botTaskCardKey(environmentId, task);
  if (key === null) return hidden;
  return [...hidden.filter((candidate) => candidate !== key), key].slice(
    -HIDDEN_BOT_TASK_CARDS_MAX,
  );
}

export function showBotTaskCards(
  hidden: HiddenBotTaskCards,
  keys: ReadonlyArray<string>,
): HiddenBotTaskCards {
  const shown = new Set(keys);
  return hidden.filter((key) => !shown.has(key));
}

/**
 * How a routine is set up in the Bot settings: before a dated session (a one-time run a lead
 * time ahead of it), or at a fixed time on chosen weekdays.
 */
export type BotRoutineDraft = {
  readonly title: string;
  readonly prompt: string;
  readonly allowChanges: boolean;
} & (
  | {
      readonly timing: "session";
      /** Epoch milliseconds, or null while unset. */
      readonly sessionAtMs: number | null;
      readonly leadMinutes: number;
    }
  | {
      readonly timing: "recurring";
      /** HH:MM in the environment's time zone. */
      readonly timeOfDay: string;
      /** 0 is Sunday. Empty means every day. */
      readonly weekdays: ReadonlyArray<number>;
    }
);

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export function emptyBotRoutineDraft(): BotRoutineDraft {
  return {
    title: "",
    prompt: "",
    allowChanges: false,
    timing: "recurring",
    timeOfDay: "09:00",
    weekdays: [],
  };
}

/** The draft for editing a saved routine; null for a timing the Bot settings cannot edit. */
export function botRoutineDraft(task: ScheduledTask): BotRoutineDraft | null {
  const base = {
    title: task.title,
    prompt: task.prompt,
    allowChanges: task.bot?.allowChanges ?? false,
  };
  if (task.schedule.type === "once" && task.bot?.sessionAt != null) {
    const sessionAtMs = Date.parse(task.bot.sessionAt);
    const leadMinutes = Math.round((sessionAtMs - Date.parse(task.schedule.runAt)) / 60_000);
    return { ...base, timing: "session", sessionAtMs, leadMinutes };
  }
  if (task.schedule.type === "fixed_time") {
    return {
      ...base,
      timing: "recurring",
      timeOfDay: task.schedule.timeOfDay,
      weekdays: task.schedule.weekdays ?? [],
    };
  }
  return null;
}

/**
 * The save request for a routine draft. A session routine becomes a one-time run that many
 * minutes before the session, so a single date never turns into a repeating schedule.
 */
export function botRoutineUpsertInput(
  draft: BotRoutineDraft,
  target: {
    readonly botId: BotId;
    readonly projectId: ProjectId;
    readonly modelSelection: ModelSelection;
    /** Set when editing; a new routine passes a command id instead. */
    readonly id?: ScheduledTaskId;
    readonly commandId?: CommandId;
    readonly enabled?: boolean;
  },
  nowMs: number,
): { readonly input: ScheduledTaskUpsertInput } | { readonly error: string } {
  const title = draft.title.trim();
  const prompt = draft.prompt.trim();
  if (title === "") return { error: "Give the routine a name." };
  if (prompt === "") return { error: "Describe what the Bot should do." };
  const common = {
    ...(target.id === undefined ? {} : { id: target.id, requireExisting: true }),
    ...(target.commandId === undefined ? {} : { commandId: target.commandId }),
    title,
    prompt,
    enabled: target.enabled ?? true,
    projectId: target.projectId,
    workspaceStrategy: { type: "root" } as const,
    modelSelection: target.modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
  };
  if (draft.timing === "recurring") {
    if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(draft.timeOfDay.trim())) {
      return { error: "Enter the time as HH:MM." };
    }
    return {
      input: {
        ...common,
        schedule: {
          type: "fixed_time",
          timeOfDay: draft.timeOfDay.trim(),
          ...(draft.weekdays.length === 0 ? {} : { weekdays: [...draft.weekdays] }),
        },
        bot: { botId: target.botId, sessionAt: null, allowChanges: draft.allowChanges },
      },
    };
  }
  if (draft.sessionAtMs === null || !Number.isFinite(draft.sessionAtMs)) {
    return { error: "Pick when the event starts." };
  }
  if (!Number.isInteger(draft.leadMinutes) || draft.leadMinutes < 0) {
    return { error: "The lead time must be zero or more minutes." };
  }
  const runAtMs = draft.sessionAtMs - draft.leadMinutes * 60_000;
  if (runAtMs <= nowMs) {
    return { error: "That run time has passed. Pick a later event or a shorter lead." };
  }
  return {
    input: {
      ...common,
      schedule: { type: "once", runAt: isoAt(runAtMs) },
      bot: {
        botId: target.botId,
        sessionAt: isoAt(draft.sessionAtMs),
        allowChanges: draft.allowChanges,
      },
    },
  };
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** One line for a routine's timing; instants are formatted by the caller's locale formatter. */
export function describeBotRoutineTiming(
  task: Pick<ScheduledTask, "schedule" | "bot">,
  formatInstant: (iso: string) => string,
  timeZone: string | undefined,
): string {
  const zone = timeZone === undefined ? "" : ` (${timeZone})`;
  const { schedule } = task;
  switch (schedule.type) {
    case "once":
      return task.bot?.sessionAt == null
        ? `Once, ${formatInstant(schedule.runAt)}`
        : `${formatInstant(schedule.runAt)}, before the event on ${formatInstant(task.bot.sessionAt)}`;
    case "fixed_time": {
      const days =
        schedule.weekdays === undefined || schedule.weekdays.length === 0
          ? "Every day"
          : [...schedule.weekdays]
              .sort((a, b) => a - b)
              .map((day) => WEEKDAY_NAMES[day])
              .join(", ");
      return `${days} at ${schedule.timeOfDay}${zone}`;
    }
    case "interval":
      return `Every ${Math.round(schedule.everyMs / 60_000)} min`;
    case "webhook":
      return "On webhook";
  }
}

export type BotContinuationDraft = Readonly<
  Record<(typeof BOT_CONTINUATION_SECTIONS)[number], string>
>;
export function botContinuationDraft(note: BotContinuationNote): BotContinuationDraft {
  return {
    requests: note.requests.map((item) => item.text).join("\n"),
    waiting: note.waiting.map((item) => item.text).join("\n"),
    decided: note.decided.map((item) => item.text).join("\n"),
    context: note.context.map((item) => item.text).join("\n"),
  };
}
const decodeContinuationDraft = Schema.decodeUnknownOption(BotContinuationNoteInput);
export function parseBotContinuationDraft(
  draft: BotContinuationDraft,
): { readonly note: BotContinuationNoteInput } | { readonly error: string } {
  const entries = (section: (typeof BOT_CONTINUATION_SECTIONS)[number]) =>
    draft[section]
      .split("\n")
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({ text }));
  const decoded = decodeContinuationDraft({
    requests: entries("requests"),
    waiting: entries("waiting"),
    decided: entries("decided"),
    context: entries("context"),
  });
  return Option.isSome(decoded)
    ? { note: decoded.value }
    : { error: "Use at most 20 lines, 400 characters per line and 4000 characters in total." };
}
export function botContinuationWriterLabel(writer: BotContinuationRevision["updatedBy"]): string {
  return writer.kind === "user" ? "Updated by you" : "Updated by the Bot";
}
export function botContinuationRefCaption(ref: BotContinuationRef): string {
  if (ref.kind === "user") return `You · revision ${ref.revision}`;
  if (ref.availability === "historical_unverified")
    return "Source unavailable or changed · historical/unverified";
  if (ref.kind === "task")
    return `Task · ${ref.status === null ? "Unavailable" : BOT_TASK_STATUS_LABELS[ref.status]}`;
  return `${ref.directUser ? "Your words" : "Home input"}: “${ref.quote}”`;
}

/** Notification routes cannot open a result belonging to another project or work thread. */
export function botTaskResultMatchesThread(
  task: Pick<BotTaskSummary, "id" | "workThreadId" | "projectId">,
  thread: { readonly taskId: string; readonly threadId: ThreadId; readonly projectId: ProjectId },
): boolean {
  return (
    task.id === thread.taskId &&
    task.workThreadId === thread.threadId &&
    task.projectId === thread.projectId
  );
}

export const BOT_MAINTENANCE_DESCRIPTION =
  "Reviews this project's new messages and finished work to keep lessons and working notes current. It starts with new messages and newly completed work; earlier history is left as is.";
const BOT_MAINTENANCE_UNAVAILABLE_LABELS: ReadonlyMap<string, string> = new Map([
  [
    "no_tool_profile_unavailable",
    "Not available yet. It needs a tool-free model profile, which this server doesn't provide.",
  ],
  [
    "codex_required",
    "Needs a Codex model. Pick a Codex model for this Bot to turn maintenance on.",
  ],
  ["instance_unavailable", "This Bot's Codex provider is off or missing."],
  ["provider_signed_out", "Sign in to Codex to run maintenance."],
  ["codex_version_unsupported", "Update Codex to run maintenance."],
  ["selected_model_unavailable", "This Bot's model isn't available on its Codex account."],
  ["option_unsupported", "One of this Bot's model options isn't supported for maintenance."],
]);
/** Settings caption for a maintenance view; unknown reasons from newer servers stay readable. */
export function botMaintenanceStatusLabel(view: BotMaintenanceView): string {
  if (view.unavailableReason === null) return botMaintenanceState(view, false);
  return `${botMaintenanceState(view, true)} · ${BOT_MAINTENANCE_UNAVAILABLE_LABELS.get(view.unavailableReason) ?? "Not available on this server."}`;
}
function botMaintenanceState(view: BotMaintenanceView, unavailable: boolean): string {
  if (!view.enabled)
    return view.startedAt === null ? "Off" : "Paused · turning it on continues where it stopped";
  if (!view.writable) return "On · stopped while detached or archived";
  return unavailable ? "On · stopped" : "On";
}
/** Turning off is always allowed; turning on needs an editable form, an active Bot and a server that can generate. */
export function canToggleBotMaintenance(view: BotMaintenanceView, formLocked: boolean): boolean {
  return view.enabled || (!formLocked && view.writable && view.unavailableReason === null);
}

export const BOT_HOME_CHECK_DESCRIPTION =
  "Once a day, the Bot looks over this project's Home and adds to Waiting on you what needs your decision or preparation. It never acts on its own.";
const BOT_HOME_CHECK_UNAVAILABLE_LABELS: ReadonlyMap<string, string> = new Map([
  ["provider", "Needs a Codex model. Pick a Codex model for this Bot to turn the check on."],
  ["platform", "Runs only when this server is a Mac."],
]);
/** Settings caption for a Home check; unknown reasons from newer servers stay readable. */
export function botHomeCheckStatusLabel(view: BotHomeCheckView): string {
  const state = !view.enabled
    ? "Off"
    : !view.writable
      ? "On · stopped while detached or archived"
      : view.unavailableReason !== null
        ? "On · stopped"
        : `On · daily at ${view.timeOfDay}`;
  if (view.unavailableReason === null) return state;
  return `${state} · ${BOT_HOME_CHECK_UNAVAILABLE_LABELS.get(view.unavailableReason) ?? "Not available on this server."}`;
}
/** What the latest check did, or null before the first one. */
export function botHomeCheckLastLabel(view: BotHomeCheckView): string | null {
  const last = view.lastCheck;
  if (last === null) return null;
  switch (last.outcome) {
    case "running":
      return "Checking now";
    case "proposed":
      return `Last check: added ${last.added ?? 0} to Waiting on you`;
    case "noop":
      return "Last check: nothing to add";
    case "failed":
    case "interrupted":
    case "stopped":
    case "unsupported":
      return "Last check: couldn't check";
    default:
      return "Last check finished";
  }
}
export function canToggleBotHomeCheck(view: BotHomeCheckView, formLocked: boolean): boolean {
  return view.enabled || (!formLocked && view.writable && view.unavailableReason === null);
}
