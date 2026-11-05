import { resolveBotAppearance } from "@t3tools/client-runtime/bot-appearance";
import { rankBotConversations } from "@t3tools/client-runtime/bots";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { BotSummary, EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { Fragment, type MouseEvent } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { useEnvironment } from "../state/environments";
import { useProjects, useQuietThreadShellsByRefs, useServerConfigs } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { BotAvatar } from "./BotAvatar";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "./Sidebar.logic";
import { useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type BotDot = NonNullable<ReturnType<typeof resolveSidebarFolderDot>>;

const DOT_URGENCY: Readonly<Record<BotDot, number>> = {
  attention: 4,
  failed: 3,
  unread: 2,
  working: 1,
};

const DOT_CLASS_NAME: Readonly<Record<BotDot, string>> = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
};

const DOT_LABEL: Readonly<Record<BotDot, string>> = {
  attention: "needs you",
  failed: "failed",
  unread: "done",
  working: "working",
};

function threadDot(thread: Parameters<typeof resolveSidebarFolderDot>[0][number]): BotDot | null {
  return resolveSidebarFolderDot([thread]);
}

/** On phones the rail sits in the sidebar sheet, which should close once the user picks. */
function useCloseMobileSidebar() {
  const { isMobile, setOpenMobile } = useSidebar();
  return () => {
    if (isMobile) setOpenMobile(false);
  };
}

/** Environments that serve Bots, in the order the client lists them. */
export function useBotEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const serverConfigs = useServerConfigs();
  return [...serverConfigs.entries()].flatMap(([environmentId, config]) =>
    config.environment.capabilities.bots === true ? [environmentId] : [],
  );
}

/**
 * The column of Bots left of the thread sidebar: one entry per Bot, opening the home
 * conversation that needs the user, or else the most recently active one.
 */
export function BotRail({
  environmentIds,
  className,
}: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly className?: string;
}) {
  const navigate = useNavigate();
  const closeMobileSidebar = useCloseMobileSidebar();
  return (
    <nav
      aria-label="Bots"
      className={cn(
        "flex h-full w-13 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar surface-grain text-sidebar-foreground",
        className,
      )}
    >
      <div
        aria-hidden
        className={cn("h-(--workspace-topbar-height) w-full shrink-0", isElectron && "drag-region")}
      />
      <ul className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto pb-2 [scrollbar-width:none]">
        {environmentIds.map((environmentId, index) => (
          <Fragment key={environmentId}>
            {index > 0 ? (
              <li aria-hidden className="my-1 h-px w-6 shrink-0 bg-sidebar-border" />
            ) : null}
            <BotRailEnvironment
              environmentId={environmentId}
              showEnvironment={environmentIds.length > 1}
            />
          </Fragment>
        ))}
        <li className="mt-1 shrink-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Manage Bots"
                  className="flex size-9 cursor-pointer items-center justify-center rounded-xl text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => {
                    closeMobileSidebar();
                    void navigate({ to: "/settings/bots" });
                  }}
                />
              }
            >
              <PlusIcon className="size-4" aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="right">Manage Bots</TooltipPopup>
          </Tooltip>
        </li>
      </ul>
    </nav>
  );
}

function BotRailEnvironment({
  environmentId,
  showEnvironment,
}: {
  readonly environmentId: EnvironmentId;
  readonly showEnvironment: boolean;
}) {
  const botsQuery = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const environmentLabel = useEnvironment(environmentId)?.label ?? null;
  const bots = (botsQuery.data?.bots ?? [])
    .filter((bot) => bot.archivedAt === null)
    .toSorted((left, right) => left.name.localeCompare(right.name));
  return bots.map((bot) => (
    <BotRailItem
      key={bot.id}
      environmentId={environmentId}
      environmentLabel={showEnvironment ? environmentLabel : null}
      bot={bot}
    />
  ));
}

function BotRailItem({
  environmentId,
  environmentLabel,
  bot,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly bot: BotSummary;
}) {
  const navigate = useNavigate();
  const closeMobileSidebar = useCloseMobileSidebar();
  const routeRef = resolveThreadRouteRef(useParams({ strict: false }));
  const projects = useProjects();
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const contexts = bot.projects.filter((context) => context.detachedAt === null);
  const shells = useQuietThreadShellsByRefs(
    contexts.map((context) => scopeThreadRef(environmentId, context.homeThreadId)),
  );
  const shellByThreadId = new Map(
    shells.flatMap((shell) => {
      if (shell === null) return [];
      const key = scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id));
      const lastVisitedAt = resolveThreadLastVisitedAt(
        shell.lastVisitedAt,
        localLastVisitedAtById[key],
      );
      return [[shell.id as string, { ...shell, lastVisitedAt }] as const];
    }),
  );
  const conversations = rankBotConversations(
    bot,
    (threadId) => shellByThreadId.get(threadId) ?? null,
    (thread) => {
      const dot = threadDot(thread);
      return dot === null ? 0 : DOT_URGENCY[dot];
    },
  );
  const target = conversations[0] ?? null;
  const dot = target?.thread ? threadDot(target.thread) : null;
  const selected =
    routeRef !== null &&
    routeRef.environmentId === environmentId &&
    contexts.some((context) => context.homeThreadId === routeRef.threadId);
  const projectTitle = (projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? "Unknown project";

  const openSettings = () => {
    closeMobileSidebar();
    void navigate({ to: "/settings/bots", search: { machine: environmentId } });
  };
  const openConversation = (homeThreadId: (typeof contexts)[number]["homeThreadId"]) => {
    closeMobileSidebar();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, homeThreadId)),
    });
  };

  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const rect = event.currentTarget.getBoundingClientRect();
    // The keyboard context-menu key reports no pointer position.
    const position =
      event.clientX === 0 && event.clientY === 0
        ? { x: rect.right, y: rect.top }
        : { x: event.clientX, y: event.clientY };
    void (async () => {
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            ...conversations.map(({ context, thread }) => {
              const conversationDot = thread ? threadDot(thread) : null;
              return {
                id: `open:${context.homeThreadId}`,
                label:
                  projectTitle(context.projectId) +
                  (conversationDot ? ` · ${DOT_LABEL[conversationDot]}` : ""),
              };
            }),
            {
              id: "settings",
              label: "Bot settings",
              icon: "settings",
              separatorBefore: conversations.length > 0,
            },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value === null) return;
      if (clicked.value === "settings") {
        openSettings();
        return;
      }
      const conversation = conversations.find(
        ({ context }) => `open:${context.homeThreadId}` === clicked.value,
      );
      if (conversation) openConversation(conversation.context.homeThreadId);
    })();
  };

  const description =
    target === null
      ? "No project attached"
      : conversations.length > 1
        ? `${projectTitle(target.context.projectId)} and ${conversations.length - 1} more`
        : projectTitle(target.context.projectId);

  return (
    <li className="relative flex w-full shrink-0 justify-center">
      {selected ? (
        <span
          aria-hidden
          className="absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-sidebar-foreground"
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-current={selected ? "page" : undefined}
              className={cn(
                "relative flex size-9 cursor-pointer items-center justify-center rounded-xl outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selected && "bg-sidebar-row-selected",
              )}
              onClick={() =>
                target === null ? openSettings() : openConversation(target.context.homeThreadId)
              }
              onContextMenu={handleContextMenu}
            />
          }
        >
          <BotAvatar appearance={resolveBotAppearance(bot)} size={26} />
          <span className="sr-only">
            {bot.name}
            {dot ? `, ${DOT_LABEL[dot]}` : ""}
          </span>
          {dot ? (
            <span
              aria-hidden
              className={cn(
                "absolute top-0.5 right-0.5 size-2 rounded-full ring-2 ring-sidebar",
                DOT_CLASS_NAME[dot],
              )}
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="right">
          <span className="font-medium">{bot.name}</span>
          <span className="block text-muted-foreground">
            {description}
            {environmentLabel ? ` · ${environmentLabel}` : ""}
          </span>
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}
