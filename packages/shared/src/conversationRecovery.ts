import type {
  OrchestrationV2ConversationRecoveryMode,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

type RecoveryRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "providerThreadId">;
type RecoveryItemType = "error" | "system_notice";
/** Only error and notice items are read, so a thread's quiet structure works too. */
type RecoveryItem =
  | Extract<OrchestrationV2TurnItem, { readonly type: RecoveryItemType }>
  | {
      readonly type: Exclude<OrchestrationV2TurnItem["type"], RecoveryItemType>;
      readonly runId: OrchestrationV2TurnItem["runId"];
    };

export interface ConversationRecoveryOffer<Run extends RecoveryRun = RecoveryRun> {
  readonly refusedRun: Run;
  /** The newest completed run on the refused provider thread; a rewind drops it and every later run. */
  readonly lastAcceptedRun: Run | undefined;
  readonly mode: OrchestrationV2ConversationRecoveryMode;
}

/**
 * The recovery a thread offers after the provider's safety systems refused its latest run. The
 * first refusal after the last accepted run offers a rewind; a refusal after a recovery offers a
 * fresh conversation. Null when the latest run was not refused or a recovery awaits the next turn.
 */
export function conversationRecoveryOffer<Run extends RecoveryRun>(
  runs: ReadonlyArray<Run>,
  items: ReadonlyArray<RecoveryItem>,
): ConversationRecoveryOffer<Run> | null {
  let refusedRun: Run | undefined;
  for (const run of runs) {
    if (run.status === "queued" || run.status === "rolled_back") continue;
    if (refusedRun === undefined || run.ordinal > refusedRun.ordinal) refusedRun = run;
  }
  if (refusedRun?.status !== "failed") return null;
  let lastAcceptedRun: Run | undefined;
  for (const run of runs) {
    if (
      run.status === "completed" &&
      run.providerThreadId === refusedRun.providerThreadId &&
      run.ordinal < refusedRun.ordinal &&
      (lastAcceptedRun === undefined || run.ordinal > lastAcceptedRun.ordinal)
    ) {
      lastAcceptedRun = run;
    }
  }
  const ordinals = new Map(runs.map((run) => [run.id, run.ordinal]));
  let refused = false;
  let recovered = false;
  for (const item of items) {
    if (item.runId === null) continue;
    if (item.type === "error" && item.runId === refusedRun.id && item.failure.safetyBlock) {
      refused = true;
    }
    if (item.type === "system_notice" && item.conversationRecovery !== undefined) {
      if (item.runId === refusedRun.id) return null;
      if ((ordinals.get(item.runId) ?? 0) > (lastAcceptedRun?.ordinal ?? 0)) recovered = true;
    }
  }
  return refused ? { refusedRun, lastAcceptedRun, mode: recovered ? "fresh" : "rewind" } : null;
}
