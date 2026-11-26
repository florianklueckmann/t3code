import { useAtomValue } from "@effect/atom-react";

import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useWorkspaceEnvironments } from "../../state/workspace";

/** Bots of every connected environment whose server supports them, archived ones included. */
export function useConnectedBots() {
  const environments = useWorkspaceEnvironments();
  const serverConfigs = useServerConfigs();
  return useAtomValue(
    serverEnvironment.botsAcrossEnvironments(
      environments
        .filter(
          (environment) =>
            environment.connectionState === "connected" &&
            serverConfigs.get(environment.environmentId)?.environment.capabilities.bots === true,
        )
        .map((environment) => environment.environmentId),
    ),
  );
}
