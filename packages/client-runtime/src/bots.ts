import {
  BOT_CONTINUATION_SECTIONS,
  BOT_LEARNING_RETIRE_SUGGESTIONS,
  BOT_TURN_LEARNING_LIMITS,
  BotContinuationNoteInput,
  type BotContinuationNote,
  type BotContinuationRef,
  type BotContinuationRevision,
  type BotMaintenanceRunResult,
  type BotMaintenanceRunStep,
  type BotMaintenanceView,
  type BotHomeCheckView,
  BotAlertDailyLimit,
  BotTaskLimit,
  type BotAttentionView,
  type BotFailureDiagnosisView,
  type BotRecordLearningInput,
  type BotWorktreePool,
  BOT_HOME_THREAD_ID_PREFIX,
  isBotHomeProjectId,
  mayBeBotHomeThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type {
  BotId,
  BotLearningEntry,
  BotLearningKind,
  BotLearningNotice,
  BotLearningRevision,
  BotLearningRevisionRef,
  BotLearningStatus,
  BotLearningSuggestion,
  BotProjectContext,
  BotProjectContextSummary,
  BotSourcePreference,
  BotCapabilities,
  BotHome,
  BotHomeAccess,
  BotSummary,
  BotTaskListInput,
  BotTaskResult,
  BotTaskStatus,
  BotTaskSummary,
  CommandId,
  ModelCapabilities,
  ModelSelection,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** The provider drivers a Bot's model picker offers. Servers that don't say run Bots on Codex only. */
export function botProviderDrivers(
  capabilities: { readonly botProviders?: ReadonlyArray<string> } | undefined,
): ReadonlyArray<string> {
  return capabilities?.botProviders ?? ["codex"];
}

const BOT_DRIVER_NAMES: ReadonlyMap<string, string> = new Map([
  ["codex", "Codex"],
  ["claudeAgent", "Claude"],
  ["pi", "Pi"],
]);
/** Shown in place of the model picker when no provider a Bot can run on is set up. */
export function botNoProviderLabel(drivers: ReadonlyArray<string>): string {
  const names = drivers.map((driver) => BOT_DRIVER_NAMES.get(driver) ?? driver);
  const list =
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return `Bots run on ${list}. Add a ${list} provider in Providers to pick a model.`;
}

// Codex Maintenance runs through sealed generation, which refuses every other option.
const CODEX_BOT_MODEL_OPTIONS: ReadonlySet<string> = new Set(["reasoningEffort", "serviceTier"]);

/**
 * The model's capabilities with only the options every Bot run honors. Ultracode needs Claude's
 * Workflow tool, which sealed Bot runs block.
 */
export function botModelCapabilities(
  driver: string,
  capabilities: ModelCapabilities | null,
): ModelCapabilities | null {
  if (capabilities?.optionDescriptors === undefined) return capabilities;
  return {
    ...capabilities,
    optionDescriptors: capabilities.optionDescriptors.filter((descriptor) =>
      driver === "codex"
        ? CODEX_BOT_MODEL_OPTIONS.has(descriptor.id)
        : descriptor.id !== "ultracode",
    ),
  };
}

/** The Bot editor's sections, which search finds by name and links open at. */
export const BOT_EDITOR_SECTIONS = [
  { id: "mcp", title: "MCP connections", searchTerms: ["tools", "calendars", "grants"] },
  {
    id: "home",
    title: "Own Home",
    searchTerms: ["bot home", "distribute", "read access", "full access"],
  },
  {
    id: "projects",
    title: "Projects",
    searchTerms: ["routines", "working notes", "preferred sources", "attach"],
  },
  { id: "alerts", title: "Alerts", searchTerms: ["quiet hours", "alerts per day", "remit"] },
  {
    id: "maintenance",
    title: "Maintenance",
    searchTerms: ["daily home check", "diagnose failed routines"],
  },
] as const;
export type BotEditorSectionId = (typeof BOT_EDITOR_SECTIONS)[number]["id"];

export function isBotEditorSectionId(value: unknown): value is BotEditorSectionId {
  return BOT_EDITOR_SECTIONS.some((section) => section.id === value);
}

type BotCapabilityFeature = "mcpGrants" | "ownMcpServers" | "noChangesRoutines" | "home";
const BOT_CAPABILITY_LABELS: Record<BotCapabilityFeature, ReadonlyMap<string, string>> = {
  mcpGrants: new Map([
    [
      "claude_unsupported",
      "MCP connections aren't available on Claude yet. A Claude Bot loads only T3 Code's own tools; switch it to a Codex model to grant connections.",
    ],
    ["provider", "MCP connections need a Codex model for this Bot."],
  ]),
  ownMcpServers: new Map([
    [
      "claude_unsupported",
      "Not available on Claude yet. A Claude Bot loads none of your own MCP servers.",
    ],
    ["pi_unsupported", "Not available on Pi yet. A Pi Bot loads none of your own MCP servers."],
    ["provider", "Needs a Codex model for this Bot."],
  ]),
  noChangesRoutines: new Map([
    [
      "claude_unsupported",
      "No changes isn't available on Claude yet, because Claude can't enforce it. Switch the Bot to a Codex model for No changes routines.",
    ],
    [
      "pi_unsupported",
      "No changes isn't available on Pi yet, because Pi can't enforce it. Switch the Bot to a Codex or Claude model for No changes routines.",
    ],
    ["provider", "No changes needs a Codex or Claude model for this Bot."],
  ]),
  home: new Map([
    [
      "pi_unsupported",
      "Read access isn't available on Pi, because Pi can't enforce it. Use full access, or switch the Bot to a Codex or Claude model.",
    ],
    [
      "provider",
      "Read access needs a Codex or Claude model for this Bot. Use full access instead.",
    ],
  ]),
};

/**
 * Why the Bot's own Home can't run with read access on this Bot's model or server, or null when it
 * can. Read access is enforced like No changes, so it needs a Mac server too.
 */
export function botOwnHomeReadUnavailableLabel(input: {
  readonly capabilities: BotCapabilities | undefined;
  readonly platformOs: string | undefined;
}): string | null {
  return (
    botCapabilityUnavailableLabel(input.capabilities, "home") ??
    (input.platformOs === undefined || input.platformOs === "darwin"
      ? null
      : "Read access runs only when this server is a Mac. Use full access on this server.")
  );
}

export const BOT_OWN_HOME_DESCRIPTION =
  "A Home above the Bot's projects. Bring it work without choosing a project: it asks when something is unclear, then starts a task in each project the work belongs to and reports the results here one by one. It does not do the work itself.";

export const BOT_OWN_HOME_ACCESS_OPTIONS = [
  {
    value: "read",
    label: "Read",
    description:
      "It can read the attached projects and changes things only by starting tasks. On Codex it can read the whole disk.",
  },
  {
    value: "full",
    label: "Full",
    description: "It works like a project Home and can also change things itself.",
  },
] as const satisfies ReadonlyArray<{
  readonly value: BotHomeAccess;
  readonly label: string;
  readonly description: string;
}>;

export const BOT_OWN_HOME_REMOVE_DESCRIPTION =
  "Removing it archives its conversation and cancels the tasks it started. Opening it again restores the conversation.";
/**
 * Why a Bot's model can't use a feature, or null when it can. Servers without `capabilities` run
 * Bots on Codex, where everything is available; unknown reasons from newer servers stay readable.
 */
export function botCapabilityUnavailableLabel(
  capabilities: BotCapabilities | undefined,
  feature: BotCapabilityFeature,
): string | null {
  const reason = capabilities?.[feature] ?? null;
  if (reason === null) return null;
  return BOT_CAPABILITY_LABELS[feature].get(reason) ?? "Not available on this Bot's model.";
}

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

/** Marks a lesson the Bot offers for all projects, on its settings row and its Home notice. */
export const BOT_LEARNING_SUGGESTION_LABEL = "Suggested for all projects";

/** Shown on a lesson the Bot suggests retiring, above Keep and Retire. */
export const BOT_LEARNING_RETIRE_SUGGESTION_TEXT = `Suggested to retire · hasn't changed or come up in ${BOT_LEARNING_RETIRE_SUGGESTIONS.idleDays} days. Keep it if the Bot still needs it.`;

export function botLearningOriginLabel(revision: BotLearningRevision): string {
  if (revision.origin === "instruction") return "Your instruction";
  if (revision.source.kind === "task") return "Proposed by a task";
  return "Learned from a correction";
}

/** "Confirmed Nov 27, 2026" for a lesson the user brought up again, else null. */
export function botLearningConfirmedLabel(revision: BotLearningRevision): string | null {
  if (revision.reinforcedAt == null) return null;
  return `Confirmed ${DateTime.formatLocal(DateTime.makeUnsafe(revision.reinforcedAt), {
    dateStyle: "medium",
    locale: "en-US",
  })}`;
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
  /** The other project's lesson this one repeats, while the Bot suggests it for all projects. */
  readonly suggestion:
    | {
        /** The two revisions shown, sent back so a decision is about this pair. */
        readonly pair: Pick<
          BotLearningSuggestion,
          "entryId" | "revision" | "matchedEntryId" | "matchedRevision"
        >;
        readonly projectId: ProjectId;
        /** The other lesson's wording when it differs from this one's. */
        readonly text: string | null;
        readonly dismissed: boolean;
      }
    | undefined;
  /** The Bot suggests retiring the revision in use; the user keeps or retires it. */
  readonly retireSuggested: boolean;
}

/**
 * The entries of one scope (a project, or null for those shared across projects): those
 * waiting for the user first, then those suggested to retire, then active ones, then the rest.
 */
export function botLearningViews(
  entries: ReadonlyArray<BotLearningEntry>,
  projectId: ProjectId | null,
  suggestions: ReadonlyArray<BotLearningSuggestion> = [],
  retireSuggestions: ReadonlyArray<BotLearningRevisionRef> = [],
): ReadonlyArray<BotLearningView> {
  const active = (entry: BotLearningEntry | undefined) =>
    entry?.revisions.find((revision) => revision.status === "active");
  const views = entries.flatMap((entry): ReadonlyArray<BotLearningView> => {
    const latest = entry.revisions.at(-1);
    if (entry.projectId !== projectId || latest === undefined) return [];
    const newestFirst = [...entry.revisions].reverse();
    const current = active(entry);
    const suggestion = suggestions.find((each) => each.entryId === entry.id);
    const matched = entries.find((each) => each.id === suggestion?.matchedEntryId);
    const matchedText = active(matched)?.text;
    return [
      {
        entry,
        current,
        suggestion:
          suggestion === undefined ||
          current === undefined ||
          matched?.projectId == null ||
          matchedText === undefined
            ? undefined
            : {
                pair: {
                  entryId: suggestion.entryId,
                  revision: suggestion.revision,
                  matchedEntryId: suggestion.matchedEntryId,
                  matchedRevision: suggestion.matchedRevision,
                },
                projectId: matched.projectId,
                text: matchedText === current.text ? null : matchedText,
                dismissed: suggestion.dismissedAt !== null,
              },
        retireSuggested: retireSuggestions.some(
          (each) => each.entryId === entry.id && each.revision === current?.revision,
        ),
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
    view.pending.length > 0 ? 0 : view.retireSuggested ? 1 : view.current !== undefined ? 2 : 3;
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

export const BOT_TURN_LEARNING_EXPLANATION = `A preview from the saved learning, not a record of what an earlier turn received. Each turn includes at most ${
  BOT_TURN_LEARNING_LIMITS.entries
} entries or ${BOT_TURN_LEARNING_LIMITS.chars.toLocaleString(
  "en-US",
)} characters, counting those for all projects: your instructions first, then the newest and those you confirmed most recently. The Bot reads the rest on demand. Retire or merge entries to make room.`;

export interface BotTurnLearningView {
  /** Counts and characters of the next turn here, as the server selected them. */
  readonly summary: string;
  /** "In context" or "On demand" for an entry with an active revision, else null. */
  readonly markerOf: (entry: BotLearningEntry) => "In context" | "On demand" | null;
  /** Active entries for all projects, in context or on demand here. */
  readonly shared: ReadonlyArray<{
    readonly text: string;
    readonly entry: BotLearningEntry;
    readonly marker: "In context" | "On demand";
  }>;
}

/**
 * The server's selection for the next turn in a project; null when it reports none or nothing
 * is active there.
 */
export function botTurnLearningView(
  bot: {
    readonly projects: ReadonlyArray<BotProjectContext>;
    readonly learning: ReadonlyArray<BotLearningEntry>;
  },
  projectId: ProjectId,
): BotTurnLearningView | null {
  const turn = bot.projects.find((project) => project.projectId === projectId)?.turnLearning;
  if (turn === undefined || turn.eligible === 0) return null;
  const selected = new Set<string>(turn.selected);
  const active = (entry: BotLearningEntry) =>
    entry.revisions.some((revision) => revision.status === "active");
  return {
    summary: `Next turn here: ${turn.selected.length} of ${turn.eligible} entries in context · ${turn.chars.toLocaleString(
      "en-US",
    )} of ${BOT_TURN_LEARNING_LIMITS.chars.toLocaleString("en-US")} characters`,
    markerOf: (entry) =>
      !active(entry) || (entry.projectId !== null && entry.projectId !== projectId)
        ? null
        : selected.has(entry.id)
          ? "In context"
          : "On demand",
    shared: bot.learning.flatMap((entry) => {
      const current = entry.revisions.find((revision) => revision.status === "active");
      if (entry.projectId !== null || current === undefined) return [];
      const marker = selected.has(entry.id) ? ("In context" as const) : ("On demand" as const);
      return [{ text: current.text, entry, marker }];
    }),
  };
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

/** How clients name the Bot's own Home, above its projects. */
export const BOT_OWN_HOME_LABEL = "Own Home";

/** Whether this Home is the Bot's own one, in its hidden project, rather than a project Home. */
export function isBotOwnHome(context: { readonly projectId: string }): boolean {
  return isBotHomeProjectId(context.projectId);
}

/**
 * Whether a thread id is a Bot's own Home (`bot-home:<botId>:bot-home-<botId>`), decided from the
 * id alone, so it holds before the thread's shell or the Bot list has loaded.
 */
export function isBotOwnHomeThreadId(threadId: string): boolean {
  if (!mayBeBotHomeThreadId(threadId)) return false;
  const rest = threadId.slice(BOT_HOME_THREAD_ID_PREFIX.length);
  const separator = rest.indexOf(":");
  return separator > 0 && isBotHomeProjectId(rest.slice(separator + 1));
}

/** A Bot's Homes, attached or not: its project Homes, then its own Home once it was opened. */
function botHomeContexts(
  bot: Pick<BotSummary, "projects" | "home">,
): ReadonlyArray<BotProjectContextSummary> {
  return bot.home == null ? bot.projects : [...bot.projects, bot.home];
}

/** The Bot's own Home while it is open and the Bot active, else null. */
export function botOwnHome(bot: Pick<BotSummary, "archivedAt" | "home">): BotHome | null {
  return bot.archivedAt === null && bot.home != null && bot.home.detachedAt === null
    ? bot.home
    : null;
}

/** Whether `projectId` is one of the Bot's Homes that takes turns: an attached project or its open own Home. */
export function isBotHomeActive(
  bot: Pick<BotSummary, "archivedAt" | "projects" | "home">,
  projectId: string,
): boolean {
  return (
    bot.archivedAt === null &&
    botHomeContexts(bot).some(
      (context) => context.projectId === projectId && context.detachedAt === null,
    )
  );
}

/** Home conversations of active Bots: attached project Homes, then each Bot's open own Home. */
export function activeBotConversations(
  bots: ReadonlyArray<BotSummary>,
): ReadonlyArray<BotConversation> {
  return bots.flatMap((bot) =>
    bot.archivedAt !== null
      ? []
      : botHomeContexts(bot).flatMap((context) =>
          context.detachedAt === null ? [{ bot, context }] : [],
        ),
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

export interface BotRailConversations<T> {
  /** The Bot's own Home while it is open. */
  readonly ownHome: RankedBotConversation<T> | null;
  /** Its attached project Homes, ranked as `rankBotConversations` does. */
  readonly projects: ReadonlyArray<RankedBotConversation<T>>;
  /** What a click on the Bot opens: its own Home once open, else the first project Home. */
  readonly target: RankedBotConversation<T> | null;
  /** The Home whose state the Bot's dot shows: the most urgent of all its Homes. */
  readonly mostUrgent: T | null;
}

/** A Bot's entry on the rail: what a click opens, what its menu lists and what its dot shows. */
export function botRailConversations<T extends { readonly updatedAt: string }>(
  bot: BotSummary,
  threadOf: (threadId: ThreadId) => T | null,
  urgency: (thread: T) => number,
): BotRailConversations<T> {
  const projects = rankBotConversations(bot, threadOf, urgency);
  const home = botOwnHome(bot);
  const ownHome = home === null ? null : { context: home, thread: threadOf(home.homeThreadId) };
  const candidates = [ownHome?.thread ?? null, projects[0]?.thread ?? null].filter(
    (thread): thread is T => thread !== null,
  );
  const mostUrgent = candidates.reduce<T | null>(
    (best, thread) => (best === null || urgency(thread) > urgency(best) ? thread : best),
    null,
  );
  return { ownHome, projects, target: ownHome ?? projects[0] ?? null, mostUrgent };
}

/**
 * The task list a Home's cards come from: a project Home's tasks in its project, or every task the
 * Bot's own Home started, across projects.
 */
export function botHomeTaskListInput({ bot, context }: BotConversation): BotTaskListInput {
  return isBotOwnHome(context)
    ? { botId: bot.id, homeThreadId: context.homeThreadId }
    : { botId: bot.id, projectId: context.projectId };
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
    const context = botHomeContexts(bot).find((project) => project.homeThreadId === threadId);
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

/** Shown instead of Completed when the result check found the result not done, or it asks something. */
export const BOT_TASK_NEEDS_YOU_LABEL = "Needs you";

export function isBotTaskWaitingOnYou(task: Pick<BotTaskSummary, "acceptance">): boolean {
  return task.acceptance?.state === "needs_you";
}

/** What the result check says on a finished task's card: what is missing, questions, unchecked evidence. */
export function botTaskAcceptanceLines(task: Pick<BotTaskSummary, "acceptance">): string[] {
  const acceptance = task.acceptance;
  if (acceptance === undefined) return [];
  const report = acceptance.report;
  const unchecked = (report?.evidence ?? [])
    .filter((item) => item.check === "unchecked")
    .map((item) => item.text);
  return [
    ...(acceptance.missing.length === 0 ? [] : [`Not done: ${acceptance.missing.join(" ")}`]),
    ...(report === null || report.openQuestions.length === 0
      ? []
      : [`Open questions: ${report.openQuestions.join(" ")}`]),
    ...(unchecked.length === 0 ? [] : [`Not checked: ${unchecked.join(", ")}`]),
  ];
}

export const BOT_TASK_LIMIT_DESCRIPTION =
  "How many tasks you or the Bot start may run at the same time, across its projects. More wait and start oldest first. Routines and watches do not count.";
const isBotTaskLimit = Schema.is(BotTaskLimit);
/** A whole number of tasks within the limit's bounds, or null. */
export function parseBotTaskLimit(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const limit = Number(trimmed);
  return isBotTaskLimit(limit) ? limit : null;
}

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

/** Changes this close together read as one, such as everything one maintenance pass kept. */
const LEARNING_NOTICE_GROUP_GAP_MS = 60_000;
const HOME_LEARNING_NOTICE_GROUP_LIMIT = 3;
/** More notices than this fold into one summary row, so they never crowd out the conversation. */
const HOME_LEARNING_NOTICES_UNFOLDED = 2;

export interface BotLearningNoticeGroup {
  /** Changes when a newer notice joins, so a hidden group shows again. */
  readonly key: string;
  /** Newest first. */
  readonly notices: ReadonlyArray<BotLearningNotice>;
  /** Proposals in the group still waiting for the user. */
  readonly waiting: number;
}

/**
 * A Home's learning notices in groups, newest first: the three newest groups plus any that still
 * holds a waiting proposal, which stays until it is decided. Hiding shares the task cards' list.
 * `folded` is the one-row summary that stands for the groups until expanded, null when they are
 * few enough to show as they are.
 */
export function homeBotLearningNoticeGroups(
  scope: { readonly environmentId: string; readonly botId: BotId; readonly projectId: ProjectId },
  notices: ReadonlyArray<BotLearningNotice>,
  hidden: HiddenBotTaskCards,
): {
  readonly visible: ReadonlyArray<BotLearningNoticeGroup>;
  readonly hiddenKeys: ReadonlyArray<string>;
  readonly folded: string | null;
  readonly showGroupSummaries: boolean;
} {
  const runs: Array<Array<BotLearningNotice>> = [];
  for (const notice of notices) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (
      run !== undefined &&
      previous !== undefined &&
      Date.parse(previous.at) - Date.parse(notice.at) <= LEARNING_NOTICE_GROUP_GAP_MS
    ) {
      run.push(notice);
    } else runs.push([notice]);
  }
  const hiddenSet = new Set(hidden);
  const visible: BotLearningNoticeGroup[] = [];
  const hiddenKeys: string[] = [];
  runs.forEach((run, index) => {
    const newest = run[0]!;
    const group = {
      key: JSON.stringify([
        scope.environmentId,
        scope.botId,
        scope.projectId,
        "learning",
        newest.entryId,
        newest.revision,
        newest.change,
      ]),
      notices: run,
      waiting: run.filter((notice) => notice.status === "pending" && notice.change !== "retired")
        .length,
    };
    if (group.waiting > 0) visible.push(group);
    else if (index >= HOME_LEARNING_NOTICE_GROUP_LIMIT) return;
    else if (hiddenSet.has(group.key)) hiddenKeys.push(group.key);
    else visible.push(group);
  });
  const shown = visible.flatMap((group) => group.notices);
  const folded =
    shown.length <= HOME_LEARNING_NOTICES_UNFOLDED
      ? null
      : botLearningNoticeGroupSummary({
          key: "",
          notices: shown,
          waiting: visible.reduce((sum, group) => sum + group.waiting, 0),
        });
  return { visible, hiddenKeys, folded, showGroupSummaries: folded === null || visible.length > 1 };
}

export function hideBotHomeCard(hidden: HiddenBotTaskCards, key: string): HiddenBotTaskCards {
  return [...hidden.filter((candidate) => candidate !== key), key].slice(
    -HIDDEN_BOT_TASK_CARDS_MAX,
  );
}

const LEARNING_NOTICE_CHANGE_LABELS = {
  added: "new",
  changed: "changed",
  restored: "restored",
  adopted: "adopted",
  retired: "retired",
} as const;

/** One line for a group, such as "2 new, 1 changed · 1 waiting for you". */
export function botLearningNoticeGroupSummary(group: BotLearningNoticeGroup): string {
  const counts = new Map<string, number>();
  for (const notice of group.notices) {
    const label = LEARNING_NOTICE_CHANGE_LABELS[notice.change];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const changes = [...counts].map(([label, count]) => `${count} ${label}`).join(", ");
  return group.waiting === 0 ? changes : `${changes} · ${group.waiting} waiting for you`;
}

export function botLearningNoticeTitle(notice: BotLearningNotice): string {
  const kind = BOT_LEARNING_KIND_LABELS[notice.kind].toLowerCase();
  switch (notice.change) {
    case "added":
      return notice.proposed ? `Proposed ${kind}` : `New ${kind}`;
    case "changed":
      return notice.proposed ? `Proposed change to a ${kind}` : `Changed ${kind}`;
    case "restored":
      return `Restored ${kind} from revision ${notice.restoredFrom ?? notice.revision}`;
    case "adopted":
      return `Adopted ${kind}`;
    case "retired":
      return `Retired ${kind}`;
  }
}

export function botLearningNoticeScopeLabel(notice: BotLearningNotice): string {
  return notice.projectId === null ? "All projects" : "This project";
}

/**
 * Where the entry stands now when that differs from what the notice says, so a notice about an
 * entry that was later replaced, rejected or retired never reads as current.
 */
export function botLearningNoticeEntryState(notice: BotLearningNotice): string | null {
  if (notice.change === "retired") return notice.currentRevision === null ? null : "Restored since";
  if (notice.status === "pending") return BOT_LEARNING_STATUS_LABELS.pending;
  if (notice.status === "rejected") return BOT_LEARNING_STATUS_LABELS.rejected;
  if (notice.currentRevision === notice.revision) {
    return notice.suggestedForAllProjects === true
      ? BOT_LEARNING_SUGGESTION_LABEL
      : BOT_LEARNING_STATUS_LABELS.active;
  }
  return notice.currentRevision === null ? "Not in use now" : "No longer current";
}

/**
 * How a routine is set up in the Bot settings: before a dated session (a one-time run a lead
 * time ahead of it), or at a fixed time on chosen weekdays.
 */
export type BotRoutineDraft = {
  readonly title: string;
  readonly prompt: string;
  readonly allowChanges: boolean;
  /** Saved only while the draft can be a watch; see `botRoutineWatchUnavailableLabel`. */
  readonly watch: boolean;
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

/** A new routine starts as No changes, or as Changes allowed where the Bot's model can't enforce it. */
export function emptyBotRoutineDraft(capabilities: BotCapabilities | undefined): BotRoutineDraft {
  return {
    title: "",
    prompt: "",
    allowChanges: (capabilities?.noChangesRoutines ?? null) !== null,
    watch: false,
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
    watch: isBotRoutineWatch(task),
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
 * Whether the routine form offers No changes, and why not. A routine already saved as No changes
 * keeps the choice, so editing it never flips its access silently; the server keeps it paused.
 */
export function botRoutineNoChanges(
  capabilities: BotCapabilities | undefined,
  saved: ScheduledTask | null,
): { readonly offered: boolean; readonly unavailableLabel: string | null } {
  const unavailableLabel = botCapabilityUnavailableLabel(capabilities, "noChangesRoutines");
  return {
    offered: unavailableLabel === null || (saved !== null && saved.bot?.allowChanges !== true),
    unavailableLabel,
  };
}

export const BOT_ROUTINE_WATCH_DESCRIPTION =
  "Speaks up only when something is new. A run with nothing new shows nothing.";

/** Why the draft cannot be a watch, or null when it can: a watch only reads, and it repeats. */
export function botRoutineWatchUnavailableLabel(
  draft: Pick<BotRoutineDraft, "allowChanges" | "timing">,
): string | null {
  if (draft.allowChanges) return "A watch only reads, so it needs No changes.";
  if (draft.timing !== "recurring") return "A watch needs a recurring routine.";
  return null;
}

/** Whether a saved routine runs as a watch; the server ignores the flag with changes allowed. */
export function isBotRoutineWatch(task: Pick<ScheduledTask, "bot">): boolean {
  return task.bot?.watch === true && task.bot.allowChanges !== true;
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
        bot: {
          botId: target.botId,
          sessionAt: null,
          allowChanges: draft.allowChanges,
          watch: draft.watch && botRoutineWatchUnavailableLabel(draft) === null,
        },
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
        watch: false,
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
    "Needs a Codex or Claude model. Pick one for this Bot to turn maintenance on.",
  ],
  // Servers from before Claude maintenance still send this.
  ["claude_unsupported", "Not available on Claude on this server yet. Update T3 Code."],
  ["pi_unsupported", "Not available on Pi yet. It runs on Codex and Claude models."],
  ["instance_unavailable", "This Bot's provider is off or missing."],
  ["provider_signed_out", "Sign in to this Bot's provider to run maintenance."],
  ["codex_version_unsupported", "Update Codex to run maintenance."],
  ["claude_version_unsupported", "Update Claude Code to run maintenance."],
  ["platform_unsupported", "On Claude, maintenance runs only when this server is a Mac."],
  [
    "claude_settings_unsupported",
    "Maintenance can't use this Bot's Claude settings: they choose their own API backend, key helper or managed MCP servers, can't be read, or sit at a relative path.",
  ],
  ["selected_model_unavailable", "This Bot's model isn't available on its account."],
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
/**
 * Moves when the Home gets new input or a run there starts or ends, from any device or the
 * nightly pass: the moments its working notes, or the count of messages newer than them, can
 * change. The active run covers notes refreshes, which stay out of the shell's latest run.
 */
export function botHomeNotesActivity(
  shell: {
    readonly latestUserMessageAt: string | null;
    readonly source: { readonly activeRunId: string | null };
  } | null,
): string {
  return `${shell?.latestUserMessageAt ?? ""}|${shell?.source.activeRunId ?? ""}`;
}

/** The server refuses the same cases; this only keeps the action from offering a sure refusal. */
export function canRunBotMaintenance(view: BotMaintenanceView): boolean {
  return view.enabled && view.writable && view.unavailableReason === null;
}

const BOT_MAINTENANCE_REASON_LABELS: ReadonlyMap<string, string> = new Map([
  ["home_active", "the conversation was busy"],
  ["learning_pending", "lessons come first"],
  ["note_behind", "the working notes are behind"],
  ["settings_changed", "maintenance settings changed"],
  ["basis_changed", "the Bot or project changed"],
  ["source_changed", "a message changed during the pass"],
  ["oversized_evidence", "too much to review at once"],
  ["instructions_exceed_packet", "the Bot's instructions are too long"],
  ["note_too_large", "the working notes are too large"],
  ["unsupported", "not supported for this conversation"],
  ["retry_exhausted", "earlier attempts failed"],
  ["generation_failed", "the model call failed"],
  ["user_stopped", "you stopped it"],
  ["new_message", "a new message came first"],
]);
function maintenanceReason(step: BotMaintenanceRunStep): string {
  if (step.status === "error" || step.reason === null) return step.reason ?? "";
  return BOT_MAINTENANCE_REASON_LABELS.get(step.reason) ?? step.reason.replaceAll("_", " ");
}
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
/** One line per manual run: what learning, the working notes and compaction each did. */
export function botMaintenanceRunLabel(result: BotMaintenanceRunResult): string {
  const { learning, note, compaction } = result;
  const learned = [
    learning.active > 0 ? `Learned ${plural(learning.active, "lesson")}` : null,
    learning.pending > 0 ? `${plural(learning.pending, "proposal")} waiting for you` : null,
  ].filter((part) => part !== null);
  const learningLabel =
    learning.status === "idle"
      ? "Nothing new to learn"
      : learning.status === "applied" || learning.status === "noop" || learning.status === "partial"
        ? `${learned.length > 0 ? learned.join(", ") : "Reviewed new messages, no new lessons"}${learning.status === "partial" ? ", more next run" : ""}`
        : maintenanceStepLabel("Learning", learning);
  const noteLabel =
    note.status === "current"
      ? "Notes up to date"
      : note.status === "refreshed"
        ? "Notes refreshed"
        : // A save from a read that missed the newest messages; the next run covers them.
          note.status === "not_refreshed" && note.reason === "not_shown"
          ? "Notes saved, newest messages next run"
          : maintenanceStepLabel("Notes", note);
  const compactionLabel =
    compaction.status === "not_needed"
      ? "No compaction needed"
      : compaction.status === "compacted"
        ? "Context compacted"
        : maintenanceStepLabel("Compaction", compaction);
  return [learningLabel, noteLabel, compactionLabel].join(" · ");
}
function maintenanceStepLabel(name: string, step: BotMaintenanceRunStep): string {
  const verb =
    step.status === "deferred"
      ? "waited"
      : step.status === "error"
        ? "didn't run"
        : step.status === "failed" || step.status === "not_refreshed"
          ? "failed"
          : step.status.replaceAll("_", " ");
  const reason = maintenanceReason(step);
  return reason === "" ? `${name} ${verb}` : `${name} ${verb}: ${reason}`;
}

export const BOT_HOME_CHECK_DESCRIPTION =
  "Once a day, the Bot looks over this project's Home and adds to Waiting on you what needs your decision or preparation. It never acts on its own.";
const BOT_HOME_CHECK_UNAVAILABLE_LABELS: ReadonlyMap<string, string> = new Map([
  ["provider", "Needs a Codex model. Pick a Codex model for this Bot to turn the check on."],
  ["claude_unsupported", "Not available on Claude yet. It runs on Codex models."],
  ["pi_unsupported", "Not available on Pi yet. It runs on Codex or Claude models."],
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
  const name = last.early === true ? "Last early check" : "Last check";
  switch (last.outcome) {
    case "running":
      return last.early === true ? "Checking early now" : "Checking now";
    case "proposed":
      return `${name}: added ${last.added ?? 0} to Waiting on you`;
    case "noop":
      return `${name}: nothing to add`;
    case "failed":
    case "interrupted":
    case "stopped":
    case "unsupported":
      return `${name}: couldn't check`;
    default:
      return `${name} finished`;
  }
}
export function canToggleBotHomeCheck(view: BotHomeCheckView, formLocked: boolean): boolean {
  return view.enabled || (!formLocked && view.writable && view.unavailableReason === null);
}

export const BOT_HOME_CHECK_EARLY_DESCRIPTION =
  "When a routine or task here finishes or fails, check then instead of waiting for the daily check. At most twice a day per Bot, an hour apart.";
/** Whether the early check switch shows; servers without early checks omit the setting. */
export const hasBotHomeCheckEarly = (view: BotHomeCheckView): boolean => view.early !== undefined;
/**
 * Early checks ride on the daily check: they change only while it is on and can run. Turning the
 * daily check off is the way out otherwise.
 */
export function canToggleBotHomeCheckEarly(view: BotHomeCheckView, formLocked: boolean): boolean {
  return (
    view.enabled &&
    view.writable &&
    view.unavailableReason === null &&
    (view.early === true || !formLocked)
  );
}

export const BOT_ALERTS_DESCRIPTION =
  "Phone alerts for work you didn't start yourself, such as routines and diagnoses. Results of work you start always alert at once. Held alerts arrive as one alert when quiet hours end, or when the next day starts.";
export const BOT_REMIT_DESCRIPTION =
  "In your words, what deserves a Waiting item from the Home check and what doesn't. It guides the check and gives the Bot no other permissions.";
const isBotAlertDailyLimit = Schema.is(BotAlertDailyLimit);
/** A typed alerts-per-day value: digits only, and a number the server stores; null otherwise. */
export function parseBotAlertDailyLimit(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const limit = Number(trimmed);
  return isBotAlertDailyLimit(limit) ? limit : null;
}
/** Today's alerts and what waits for the digest, with the digest time in the viewer's clock. */
export function botAlertsStatusLabel(view: BotAttentionView): string {
  const sent = `${view.sentToday} of ${view.dailyLimit} sent today`;
  if (view.held === 0 || view.digestAt === null) return sent;
  const at = DateTime.formatLocal(DateTime.makeUnsafe(view.digestAt), {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${sent} · ${view.held} held, sent together at ${at}`;
}

export const BOT_FAILURE_DIAGNOSIS_DESCRIPTION =
  "When a routine run in this project fails, the Bot starts one task that looks into why, following your brief. It changes nothing, and its result shows in Home with a link to the failed run.";
const BOT_FAILURE_DIAGNOSIS_UNAVAILABLE_LABELS: ReadonlyMap<string, string> = new Map([
  ["provider", "Needs a Codex or Claude model for this Bot."],
  ["claude_unsupported", "Not available on Claude yet. It runs on Codex models."],
  ["pi_unsupported", "Not available on Pi yet. It runs on Codex or Claude models."],
  ["platform", "Runs only when this server is a Mac."],
]);
/** Settings caption; unknown reasons from newer servers stay readable. */
export function botFailureDiagnosisStatusLabel(view: BotFailureDiagnosisView): string {
  const state = !view.enabled
    ? "Off"
    : view.writable
      ? "On"
      : "On · stopped while detached or archived";
  if (view.unavailableReason === null) return state;
  return `${state} · ${BOT_FAILURE_DIAGNOSIS_UNAVAILABLE_LABELS.get(view.unavailableReason) ?? "Not available on this server."}`;
}
/** Turning it off always works; turning it on needs an active context where No changes holds. */
export function canToggleBotFailureDiagnosis(
  view: BotFailureDiagnosisView,
  formLocked: boolean,
): boolean {
  return view.enabled || (!formLocked && view.writable && view.unavailableReason === null);
}
/** Where a task that may change files did its work, for its card; null for one in the project folder. */
export function botTaskBranchLabel(task: BotTaskSummary): string | null {
  if (task.branch === undefined) return null;
  return task.unfinishedWork === true
    ? `Branch ${task.branch} holds unfinished work, saved as a WIP commit.`
    : `Works on branch ${task.branch}.`;
}

export const BOT_WORKTREE_POOL_DESCRIPTION =
  "Tasks that may change files work in worktrees of their own. A finished task's worktree stays for the next one, with its installed dependencies; one unused for 7 days is removed.";
/** Settings caption for a project's task worktrees. */
export function botWorktreePoolLabel(pool: BotWorktreePool): string {
  if (pool.parked + pool.inUse === 0) return "No worktrees yet";
  const size =
    pool.bytes === null
      ? "size unknown"
      : pool.bytes >= 1024 ** 3
        ? `${(pool.bytes / 1024 ** 3).toFixed(1)} GB`
        : `${Math.max(1, Math.round(pool.bytes / 1024 ** 2))} MB`;
  return `${pool.parked} free · ${pool.inUse} in use · ${size}`;
}

/** Why a diagnostic task started, for its Home card; null for other tasks. */
export function botTaskDiagnosisLabel(task: BotTaskSummary): string | null {
  return task.diagnosis === undefined
    ? null
    : `Started because the routine run “${task.diagnosis.title}” failed.`;
}
