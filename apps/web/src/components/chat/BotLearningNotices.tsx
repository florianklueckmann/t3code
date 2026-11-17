import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  botConversationForThread,
  botLearningNoticeEntryState,
  botLearningNoticeGroupSummary,
  botLearningNoticeScopeLabel,
  botLearningNoticeTitle,
  type BotLearningNoticeGroup,
  HiddenBotTaskCards,
  hideBotHomeCard,
  homeBotLearningNoticeGroups,
  showBotTaskCards,
} from "@t3tools/client-runtime/bots";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  BotId,
  BotLearningNotice,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { BrainIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { lazy, Suspense, useContext, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { HIDDEN_BOT_TASK_CARDS_STORAGE_KEY, useUpcomingInstantFormatter } from "./BotTaskCards";

const BotLearningEntryPanel = lazy(() => import("../settings/BotLearningEntryPanel"));

/** A group shows this many notices until expanded; waiting proposals always show. */
const COLLAPSED_NOTICES = 2;

interface HomeScope {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly projectId: ProjectId;
}

/** What a Bot kept for later from this Home: saved, changed, restored and retired lessons. */
export function BotLearningNotices({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const botsQuery = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const conversation =
    botsQuery.data === null ? null : botConversationForThread(botsQuery.data.bots, threadId);
  if (conversation === null) return null;
  return (
    <HomeLearningNotices
      key={`${conversation.bot.id}:${conversation.context.projectId}`}
      environmentId={environmentId}
      botId={conversation.bot.id}
      projectId={conversation.context.projectId}
    />
  );
}

function HomeLearningNotices(scope: HomeScope) {
  const { environmentId, botId, projectId } = scope;
  const noticesQuery = useEnvironmentQuery(
    serverEnvironment.botLearningNoticesLive({ environmentId, input: { botId, projectId } }),
  );
  const [hidden, setHidden] = useLocalStorage(
    HIDDEN_BOT_TASK_CARDS_STORAGE_KEY,
    [],
    HiddenBotTaskCards,
  );
  const [opened, setOpened] = useState<BotLearningNotice | null>(null);
  const registry = useContext(RegistryContext);
  const formatInstant = useUpcomingInstantFormatter();
  const { visible, hiddenKeys } = homeBotLearningNoticeGroups(
    scope,
    noticesQuery.data?.notices ?? [],
    hidden,
  );
  const open = (notice: BotLearningNotice) => {
    // A cached detail may predate the change this notice reports.
    registry.refresh(serverEnvironment.botDetail({ environmentId, input: { botId } }));
    setOpened(notice);
  };
  if (visible.length === 0 && hiddenKeys.length === 0) return null;
  return (
    <section
      aria-label="Bot memory"
      // Capped so expanded groups never push the conversation off screen.
      className="mb-2 max-h-[40vh] space-y-1.5 overflow-y-auto rounded-lg border border-border bg-background px-3 py-2 text-xs"
    >
      {visible.length === 0 ? null : (
        <ul className="space-y-2">
          {visible.map((group) => (
            <NoticeGroup
              key={group.key}
              scope={scope}
              group={group}
              when={formatInstant(group.notices[0]!.at)}
              onOpen={open}
              onHide={() => setHidden((current) => hideBotHomeCard(current, group.key))}
            />
          ))}
        </ul>
      )}
      {hiddenKeys.length === 0 ? null : (
        <Button
          size="xs"
          variant="ghost-muted"
          aria-label={`Show ${hiddenKeys.length} hidden memory ${hiddenKeys.length === 1 ? "change" : "changes"}`}
          onClick={() => setHidden((current) => showBotTaskCards(current, hiddenKeys))}
        >
          <EyeIcon aria-hidden />
          {`Show ${hiddenKeys.length} hidden`}
        </Button>
      )}
      {opened === null ? null : (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setOpened(null);
          }}
        >
          <DialogPopup className="max-w-xl">
            <DialogHeader>
              <DialogTitle>{botLearningNoticeTitle(opened)}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <Suspense
                fallback={
                  <p className="text-sm text-muted-foreground" role="status">
                    Loading lesson…
                  </p>
                }
              >
                <BotLearningEntryPanel
                  environmentId={environmentId}
                  botId={botId}
                  projectId={projectId}
                  entryId={opened.entryId}
                  revision={opened.revision}
                />
              </Suspense>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      )}
    </section>
  );
}

function NoticeGroup({
  scope,
  group,
  when,
  onOpen,
  onHide,
}: {
  readonly scope: HomeScope;
  readonly group: BotLearningNoticeGroup;
  readonly when: string;
  readonly onOpen: (notice: BotLearningNotice) => void;
  readonly onHide: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded
    ? group.notices
    : group.notices.filter(
        (notice, index) => index < COLLAPSED_NOTICES || notice.status === "pending",
      );
  const more = group.notices.length - shown.length;
  return (
    <li className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <BrainIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="wrap-anywhere">
            {`Memory · ${botLearningNoticeGroupSummary(group)} · ${when}`}
          </span>
        </p>
        {group.waiting > 0 ? null : (
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label="Hide these memory changes from Home"
            onClick={onHide}
          >
            <EyeOffIcon aria-hidden />
            Hide
          </Button>
        )}
      </div>
      <ul className="space-y-2">
        {shown.map((notice) => (
          <NoticeRow
            key={`${notice.entryId}:${notice.revision}:${notice.change}`}
            scope={scope}
            notice={notice}
            onOpen={() => onOpen(notice)}
          />
        ))}
      </ul>
      {more === 0 ? null : (
        <Button size="xs" variant="ghost-muted" onClick={() => setExpanded(true)}>
          {`Show ${more} more`}
        </Button>
      )}
    </li>
  );
}

function NoticeRow({
  scope,
  notice,
  onOpen,
}: {
  readonly scope: HomeScope;
  readonly notice: BotLearningNotice;
  readonly onOpen: () => void;
}) {
  const canDecide = useAtomValue(
    serverEnvironment.decideBotLearning.permissionAtom(scope.environmentId),
  );
  const decide = useAtomCommand(serverEnvironment.decideBotLearning, { label: "bot learning" });
  const [busy, setBusy] = useState(false);
  const waiting = notice.status === "pending" && notice.change !== "retired";
  const state = botLearningNoticeEntryState(notice);
  const previous = notice.previous;
  const settle = async (decision: "adopt" | "reject") => {
    setBusy(true);
    const result = await decide({
      environmentId: scope.environmentId,
      input: {
        botId: scope.botId,
        entryId: notice.entryId,
        revision: notice.revision,
        decision,
      },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title:
            decision === "adopt" ? "Could not adopt the lesson" : "Could not reject the lesson",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  return (
    <li className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1 basis-48 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{botLearningNoticeTitle(notice)}</span>
          <Badge variant="outline">{botLearningNoticeScopeLabel(notice)}</Badge>
          {state === null ? null : <Badge variant={waiting ? "info" : "secondary"}>{state}</Badge>}
        </div>
        <p className="line-clamp-3 wrap-anywhere">{notice.text}</p>
        {previous === undefined ? null : previous.text !== notice.text ? (
          <p className="line-clamp-2 wrap-anywhere text-muted-foreground">
            <span className="sr-only">Was: </span>
            <span className="line-through">{previous.text}</span>
          </p>
        ) : (
          <p className="text-muted-foreground">
            {notice.projectId === null
              ? "Now applies to all projects"
              : "Now applies to this project only"}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {waiting ? (
          <>
            <Button size="xs" disabled={!canDecide || busy} onClick={() => void settle("adopt")}>
              Adopt
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!canDecide || busy}
              onClick={() => void settle("reject")}
            >
              Reject
            </Button>
          </>
        ) : null}
        <Button size="xs" variant="ghost-muted" onClick={onOpen}>
          Open
        </Button>
      </div>
    </li>
  );
}
