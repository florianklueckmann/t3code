import { useAtomValue } from "@effect/atom-react";
import type { BotSummary, EnvironmentId } from "@t3tools/contracts";

import { serverEnvironment } from "../state/server";

/** The Bot that started this work thread; ordinary threads never load Bot data. */
export function useWorkThreadBot(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
}): BotSummary | null {
  return useAtomValue(serverEnvironment.workThreadBot(thread));
}
