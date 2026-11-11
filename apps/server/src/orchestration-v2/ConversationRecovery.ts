import {
  isCompactionCommandMessage,
  type OrchestrationV2ContextHandoff,
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
  const unsummarized = older.filter(
    (message) => previous === undefined || (message.runOrdinal ?? 0) > previous.throughRunOrdinal,
  );
  if (previous !== undefined && unsummarized.length === 0) {
    return { type: "reuse", summary: previous };
  }
  return {
    type: "summarize",
    previousSummary: previous?.text,
    messages: unsummarized,
    throughRunOrdinal: Math.max(
      1,
      previous?.throughRunOrdinal ?? 0,
      ...older.map((message) => message.runOrdinal ?? 0),
    ),
  };
}
