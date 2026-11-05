import { botOfWorkThread } from "@t3tools/client-runtime/bots";
import { type BotSummary, type EnvironmentId, mayBeBotWorkThreadId } from "@t3tools/contracts";

import { useServerConfigs } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";

/** The Bot that started this work thread; ordinary threads never load Bot data. */
export function useWorkThreadBot(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
}): BotSummary | null {
  const supportsBots =
    useServerConfigs().get(thread.environmentId)?.environment.capabilities.bots === true;
  const candidate = supportsBots && mayBeBotWorkThreadId(thread.id);
  const environmentId = thread.environmentId;
  const botsQuery = useEnvironmentQuery(
    candidate ? serverEnvironment.botsLive({ environmentId, input: {} }) : null,
  );
  const tasksQuery = useEnvironmentQuery(
    candidate ? serverEnvironment.botTasksLive({ environmentId, input: {} }) : null,
  );
  if (botsQuery.data === null || tasksQuery.data === null) return null;
  return botOfWorkThread(botsQuery.data.bots, tasksQuery.data.tasks, thread.id);
}
