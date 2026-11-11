import {
  isCompactionCommandMessage,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  type ProviderThreadId,
} from "@t3tools/contracts";

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
 * What the rewound runs said: each user message and each run's final assistant reply. Tool calls,
 * commands and their output stay behind, since the refused trajectory lives in them.
 */
export function rewindHandoffItems(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<OrchestrationV2TurnItem> {
  const finalReplies = new Map<string, OrchestrationV2TurnItem>();
  for (const item of items) {
    if (item.type !== "assistant_message" || item.runId === null) continue;
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
