import { activeBotConversations } from "@t3tools/client-runtime/bots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotMessageSquareIcon } from "lucide-react";

import { useProjects } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "./CommandPalette.logic";

/**
 * One item per attached, active Bot conversation of `environmentId`. Pass null when that
 * environment has no Bots; the palette mounts only while open, so the list subscribes only then.
 */
export function useCommandPaletteBotItems(
  environmentId: EnvironmentId | null,
): ReadonlyArray<CommandPaletteActionItem> {
  const navigate = useNavigate();
  const projects = useProjects();
  const botsQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.botsLive({ environmentId, input: {} }),
  );
  if (environmentId === null || botsQuery.data === null) return [];
  return activeBotConversations(botsQuery.data.bots).map(({ bot, context }) => {
    const projectTitle =
      projects.find(
        (project) => project.environmentId === environmentId && project.id === context.projectId,
      )?.title ?? "Unknown project";
    return {
      kind: "action",
      value: `action:bot-conversation:${environmentId}:${context.homeThreadId}`,
      searchTerms: ["bot", bot.name, projectTitle],
      title: `Open ${bot.name} in ${projectTitle}`,
      icon: <BotMessageSquareIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(environmentId, context.homeThreadId)),
        });
      },
    };
  });
}
