import {
  isCompactionCommandMessage,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2FreshConversationPreparation,
  type OrchestrationV2HistoricalMessage,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  type ProviderThreadId,
} from "@t3tools/contracts";
import {
  FRESH_CONVERSATION_TAIL_TOKENS,
  type HandoffConversationSummary,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";

/**
 * The native turn a rewind keeps: the provider thread's newest turn from a run before the last
 * accepted one. Undefined drops the whole native conversation.
 */
export function rewindKeptProviderTurn(
  records: {
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "status">>;
    readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>;
    readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  },
  providerThreadId: ProviderThreadId,
  lastAcceptedRun: Pick<OrchestrationV2Run, "ordinal"> | undefined,
): OrchestrationV2ProviderTurn | undefined {
  if (lastAcceptedRun === undefined) return undefined;
  const runs = new Map(records.runs.map((run) => [run.id, run]));
  const runByAttempt = new Map(
    records.attempts.map((attempt) => [attempt.id, runs.get(attempt.runId)]),
  );
  let kept: OrchestrationV2ProviderTurn | undefined;
  for (const turn of records.providerTurns) {
    const run = turn.runAttemptId === null ? undefined : runByAttempt.get(turn.runAttemptId);
    if (
      turn.providerThreadId === providerThreadId &&
      run !== undefined &&
      run.status !== "rolled_back" &&
      run.ordinal < lastAcceptedRun.ordinal &&
      (kept === undefined || turn.ordinal > kept.ordinal)
    ) {
      kept = turn;
    }
  }
  return kept;
}

/**
 * What a recovered conversation hands over: each user message and each run's final assistant
 * reply. Tool calls, commands and their output stay behind, since the refused trajectory lives
 * in them.
 */
export function conversationRecoveryHandoffItems(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<OrchestrationV2TurnItem> {
  const finalReplies = new Map<string, OrchestrationV2TurnItem>();
  for (const item of items) {
    if (item.type !== "assistant_message" || item.runId === null) continue;
    if (item.responseKind === "intermediate") continue;
    const current = finalReplies.get(item.runId);
    if (current === undefined || item.ordinal > current.ordinal) finalReplies.set(item.runId, item);
  }
  const finals = new Set(finalReplies.values());
  return items.filter(
    (item) =>
      finals.has(item) ||
      (item.type === "user_message" &&
        item.text.trim() !== "" &&
        !isCompactionCommandMessage({
          role: "user",
          text: item.text,
          attachments: item.attachments,
        })),
  );
}

/**
 * Other handoffs pending next to a requested recovery, cut to the same shape. Their history
 * records no response kind, so a run's last assistant message stands for its final reply.
 */
export function conversationRecoveryPendingHandoffs(
  handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>,
): ReadonlyArray<OrchestrationV2ContextHandoff> {
  return handoffs.map((handoff) => {
    // Only side chat context has no history, and it is never a pending history handoff.
    if (handoff.history === undefined) return handoff;
    const lastReplies = new Map<string, string>();
    for (const message of handoff.history.messages) {
      if (message.kind === "assistant_message" && message.runId !== null) {
        lastReplies.set(message.runId, message.itemId);
      }
    }
    const messages = handoff.history.messages.filter((message) =>
      message.kind === "assistant_message"
        ? message.runId !== null && lastReplies.get(message.runId) === message.itemId
        : message.kind === "user_message" &&
          message.text.trim() !== "" &&
          !isCompactionCommandMessage({ role: "user", text: message.text, attachments: [] }),
    );
    return { ...handoff, history: { ...handoff.history, messages } };
  });
}

/** The fresh-start notice as its preparation stands. Only a failure is a warning. */
export function freshConversationNotice(
  prepared: OrchestrationV2FreshConversationPreparation | undefined,
): { readonly message: string; readonly level: "info" | "warning"; readonly detail?: string } {
  switch (prepared?.type) {
    case undefined:
      return {
        level: "info",
        message:
          "Preparing a summary of this thread for a fresh conversation. A message you send now starts once the summary is ready.",
      };
    case "summary":
      return {
        level: "info",
        message:
          "The summary is ready. Your next message starts a fresh conversation with a summary of this thread.",
        detail: prepared.summary.text,
      };
    case "verbatim":
      return {
        level: "info",
        message:
          "Your next message starts a fresh conversation with this thread's messages, which are short enough to need no summary.",
      };
    case "failed":
      return {
        level: "warning",
        message: `Could not summarize the earlier conversation (${prepared.reason}), so your next message starts a fresh conversation from only the newest messages. Start a fresh conversation again to retry.`,
      };
  }
}

/** The newest summary a fresh conversation wrote, unless a checkpoint restore undid its last run. */
export function previousConversationSummary(
  handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "status">>,
): HandoffConversationSummary | undefined {
  let latest: HandoffConversationSummary | undefined;
  for (const handoff of handoffs) {
    const summary = handoff.history?.summary;
    if (
      summary === undefined ||
      runs.some((run) => run.ordinal === summary.throughRunOrdinal && run.status === "rolled_back")
    )
      continue;
    if (latest === undefined || summary.throughRunOrdinal >= latest.throughRunOrdinal)
      latest = summary;
  }
  return latest;
}

/**
 * A fresh conversation hands over its newest messages verbatim and summarizes the older ones.
 * A previous summary is updated with only the messages after it, never written again from scratch.
 */
export function freshConversationPlan(input: {
  readonly messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
  readonly coverage: string;
  readonly tokenCap: number;
  readonly previousSummary: HandoffConversationSummary | undefined;
}):
  | { readonly type: "verbatim" }
  | { readonly type: "reuse"; readonly summary: HandoffConversationSummary }
  | {
      readonly type: "summarize";
      readonly previousSummary: string | undefined;
      readonly messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
      readonly throughRunOrdinal: number;
    } {
  const tail = selectHistory({
    messages: input.messages,
    coverage: input.coverage,
    budget: Math.max(input.tokenCap, FRESH_CONVERSATION_TAIL_TOKENS),
  });
  const omitted = new Set(tail.omittedItemIds);
  const older = input.messages.filter((message) => omitted.has(message.itemId));
  if (older.length === 0) return { type: "verbatim" };
  const previous = input.previousSummary;
  const throughRunOrdinal = Math.max(
    1,
    previous?.throughRunOrdinal ?? 0,
    ...older.map((message) => message.runOrdinal ?? 0),
  );
  // Whole runs, even what the tail also keeps: a later summary skips every run up to this one.
  const unsummarized = input.messages.filter((message) => {
    const run = message.runOrdinal ?? 0;
    return run <= throughRunOrdinal && (previous === undefined || run > previous.throughRunOrdinal);
  });
  if (previous !== undefined && unsummarized.length === 0) {
    return { type: "reuse", summary: previous };
  }
  return {
    type: "summarize",
    previousSummary: previous?.text,
    messages: unsummarized,
    throughRunOrdinal,
  };
}
