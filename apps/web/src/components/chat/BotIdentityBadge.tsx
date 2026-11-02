import { botOfHomeThread } from "@t3tools/client-runtime/bots";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { BotMessageSquareIcon } from "lucide-react";

import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The current name of the Bot whose home conversation this is. Mount it only for
 * threads that may be home conversations, so ordinary threads never load Bot data.
 */
export function BotIdentityBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}) {
  const environment = useEnvironment(props.environmentId);
  const supportsBots =
    environment?.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.bots === true;
  const botsQuery = useEnvironmentQuery(
    supportsBots
      ? serverEnvironment.botsLive({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const bot =
    botsQuery.data === null
      ? null
      : botOfHomeThread(botsQuery.data.bots, { id: props.threadId, projectId: props.projectId });
  if (bot === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="info" size="sm" />}>
        <BotMessageSquareIcon aria-hidden />
        <span className="sr-only">Bot </span>
        {bot.name}
      </TooltipTrigger>
      <TooltipPopup side="top">Home conversation of the Bot {bot.name}</TooltipPopup>
    </Tooltip>
  );
}
