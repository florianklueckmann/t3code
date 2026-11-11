import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, RunId } from "@t3tools/contracts";
import { conversationRecoveryOffer } from "@t3tools/shared/conversationRecovery";
import { useState } from "react";

import { useServerConfigs } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { ConversationRecoveryAction } from "./timelineRowContext";

/** The Rewind or Start fresh action a refused run's error row offers. */
export function useConversationRecovery(
  environmentId: EnvironmentId,
  projection: Pick<ThreadStructure, "thread" | "runs" | "turnItems"> | null,
): ConversationRecoveryAction | null {
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.threadConversationRecovery ===
    true;
  const recoverConversation = useOrchestrationCommand(threadEnvironment.recoverConversation);
  const [pendingRunId, setPendingRunId] = useState<RunId | null>(null);
  const offer =
    supported && projection !== null
      ? conversationRecoveryOffer(projection.runs, projection.turnItems)
      : null;
  if (offer === null || projection === null) return null;
  const runId = offer.refusedRun.id;
  const { mode } = offer;
  const threadId = projection.thread.id;
  return {
    runId,
    mode,
    pending: pendingRunId === runId,
    recover: () => {
      setPendingRunId(runId);
      void recoverConversation({ environmentId, input: { threadId, mode } }).finally(() =>
        setPendingRunId(null),
      );
    },
  };
}
