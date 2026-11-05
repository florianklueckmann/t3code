import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useWorkspaceEnvironments } from "../../state/workspace";

/** Bot summaries of the environments in the JSON key; one subscription per environment. */
const botsAcrossEnvironmentsAtom = Atom.family((environmentIdsJson: string) =>
  Atom.make((get) =>
    (JSON.parse(environmentIdsJson) as EnvironmentId[]).flatMap((environmentId) =>
      (
        AsyncResult.getOrElse(
          get(serverEnvironment.botsLive({ environmentId, input: {} })),
          () => null,
        )?.bots ?? []
      ).map((bot) => ({ environmentId, bot })),
    ),
  ),
);

/** Bots of every connected environment whose server supports them, archived ones included. */
export function useConnectedBots() {
  const environments = useWorkspaceEnvironments();
  const serverConfigs = useServerConfigs();
  return useAtomValue(
    botsAcrossEnvironmentsAtom(
      JSON.stringify(
        environments
          .filter(
            (environment) =>
              environment.connectionState === "connected" &&
              serverConfigs.get(environment.environmentId)?.environment.capabilities.bots === true,
          )
          .map((environment) => environment.environmentId),
      ),
    ),
  );
}
