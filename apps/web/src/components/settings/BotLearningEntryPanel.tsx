import type { BotId, EnvironmentId, ProjectId } from "@t3tools/contracts";

import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { BotLearningList } from "./BotsSettings";

/**
 * One learning entry with the Bot settings' own actions, opened from a Home notice. Loaded on
 * demand, so the chat view does not carry the settings code.
 */
export default function BotLearningEntryPanel({
  environmentId,
  botId,
  projectId,
  entryId,
  revision,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  /** The Home's project, used when the entry no longer exists. */
  readonly projectId: ProjectId;
  readonly entryId: string;
  readonly revision: number;
}) {
  const detail = useEnvironmentQuery(
    serverEnvironment.botDetail({ environmentId, input: { botId } }),
  );
  const projects = useProjects();
  if (detail.data === null) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {detail.error ?? "Loading lesson…"}
      </p>
    );
  }
  const bot = detail.data;
  const titleOf = (id: ProjectId) =>
    projects.find((project) => project.environmentId === environmentId && project.id === id)
      ?.title ?? "Unknown project";
  // The entry's scope now, which a later change may have moved to all projects.
  const scope = bot.learning.find((entry) => entry.id === entryId)?.projectId;
  return (
    <BotLearningList
      environmentId={environmentId}
      bot={bot}
      projectId={scope === undefined ? projectId : scope}
      titleOf={titleOf}
      disabled={bot.archivedAt !== null}
      onChanged={detail.refresh}
      focus={{ entryId, revision }}
    />
  );
}
