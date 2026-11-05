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
  completed: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

export function isBotTaskOpen(task: Pick<BotTaskSummary, "status">): boolean {
  return task.status === "accepted" || task.status === "running" || task.status === "waiting";
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
