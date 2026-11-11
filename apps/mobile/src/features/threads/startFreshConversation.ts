import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";

export function canStartFreshConversation(thread: EnvironmentThreadShell): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(thread.environmentId)?.environment
      .capabilities.threadConversationRecovery === true
  );
}

/** The next message starts a new provider conversation with a summary of this thread. */
export async function startFreshConversation(thread: EnvironmentThreadShell): Promise<void> {
  const title = "Could not start a fresh conversation";
  if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
    Dialog.alert(title, "This connection cannot change threads.");
    return;
  }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.recoverConversation,
    { environmentId: thread.environmentId, input: { threadId: thread.id, mode: "fresh" } },
    { reportFailure: false },
  );
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(title, error instanceof Error ? error.message : "Try again.");
  }
}
