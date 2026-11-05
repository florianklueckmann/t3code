import { botOfWorkThread } from "@t3tools/client-runtime/bots";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

/** The Bot that started a work thread. Call it only for `bot-work:` threads. */
export function useWorkThreadBot(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
}) {
  const { environmentId } = thread;
  const supported = useEnvironmentServerConfig(environmentId)?.environment.capabilities.bots;
  const bots = useEnvironmentQuery(
    supported === true ? serverEnvironment.botsLive({ environmentId, input: {} }) : null,
  );
  const tasks = useEnvironmentQuery(
    supported === true ? serverEnvironment.botTasksLive({ environmentId, input: {} }) : null,
  );
  return bots.data === null || tasks.data === null
    ? null
    : botOfWorkThread(bots.data.bots, tasks.data.tasks, thread.id);
}
