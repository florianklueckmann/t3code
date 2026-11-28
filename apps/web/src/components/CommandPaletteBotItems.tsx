import { resolveBotAppearance } from "@t3tools/client-runtime/bot-appearance";
import {
  activeBotConversations,
  BOT_EDITOR_SECTIONS,
  BOT_OWN_HOME_LABEL,
  isBotOwnHome,
} from "@t3tools/client-runtime/bots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { BotAvatar } from "./BotAvatar";
import { useProjects } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "./CommandPalette.logic";

const NO_ITEMS = { actions: [], settings: [] };

/**
 * For `environmentId`'s Bots: an action per attached, active conversation, and settings entries
 * for each active Bot's editor and its sections. Pass null when that environment has no Bots; the
 * palette mounts only while open, so the list subscribes only then.
 */
export function useCommandPaletteBotItems(environmentId: EnvironmentId | null): {
  readonly actions: ReadonlyArray<CommandPaletteActionItem>;
  readonly settings: ReadonlyArray<CommandPaletteActionItem>;
} {
  const navigate = useNavigate();
  const projects = useProjects();
  const botsQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.botsLive({ environmentId, input: {} }),
  );
  if (environmentId === null || botsQuery.data === null) return NO_ITEMS;
  const bots = botsQuery.data.bots;
  const actions = activeBotConversations(bots).map(({ bot, context }) => {
    const ownHome = isBotOwnHome(context);
    const projectTitle = ownHome
      ? BOT_OWN_HOME_LABEL
      : (projects.find(
          (project) => project.environmentId === environmentId && project.id === context.projectId,
        )?.title ?? "Unknown project");
    return {
      kind: "action" as const,
      value: `action:bot-conversation:${environmentId}:${context.homeThreadId}`,
      searchTerms: ["bot", bot.name, projectTitle],
      title: ownHome ? `Open ${bot.name}` : `Open ${bot.name} in ${projectTitle}`,
      icon: (
        <BotAvatar appearance={resolveBotAppearance(bot)} size={16} className={ITEM_ICON_CLASS} />
      ),
      run: async () => {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(environmentId, context.homeThreadId)),
        });
      },
    };
  });
  const settings = bots
    .filter((bot) => bot.archivedAt === null)
    .flatMap((bot) =>
      [{ id: undefined, title: "Bot settings", searchTerms: [] }, ...BOT_EDITOR_SECTIONS].map(
        (section) => ({
          kind: "action" as const,
          value: `setting:bot:${environmentId}:${bot.id}:${section.id ?? "editor"}`,
          searchTerms: ["bot", "settings", bot.name, section.title, ...section.searchTerms],
          title: `${bot.name} · ${section.title}`,
          description: "Settings · Bots",
          icon: (
            <BotAvatar
              appearance={resolveBotAppearance(bot)}
              size={16}
              className={ITEM_ICON_CLASS}
            />
          ),
          run: async () => {
            await navigate({
              to: "/settings/bots",
              search: {
                machine: environmentId,
                bot: bot.id,
                ...(section.id === undefined ? {} : { section: section.id }),
              },
            });
          },
        }),
      ),
    );
  return { actions, settings };
}
