import { botOfHomeThread } from "@t3tools/client-runtime/bots";
import { type EnvironmentId, mayBeBotHomeThreadId } from "@t3tools/contracts";

import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

/** The current Bot of a home conversation; ordinary threads never load Bot data. */
export function useHomeThreadBot(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly projectId: string;
  } | null,
) {
  const candidate = thread !== null && mayBeBotHomeThreadId(thread.id) ? thread : null;
  const serverConfig = useEnvironmentServerConfig(candidate?.environmentId ?? null);
  const botsQuery = useEnvironmentQuery(
    candidate !== null && serverConfig?.environment.capabilities.bots === true
      ? serverEnvironment.botsLive({ environmentId: candidate.environmentId, input: {} })
      : null,
  );
  return candidate === null || botsQuery.data === null
    ? null
    : botOfHomeThread(botsQuery.data.bots, candidate);
}
