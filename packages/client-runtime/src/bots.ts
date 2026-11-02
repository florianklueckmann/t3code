import type {
  BotProjectContext,
  BotProjectContextSummary,
  BotSourcePreference,
  BotSummary,
} from "@t3tools/contracts";

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
