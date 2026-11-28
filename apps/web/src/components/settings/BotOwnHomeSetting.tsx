import { useAtomValue } from "@effect/atom-react";
import {
  BOT_OWN_HOME_ACCESS_OPTIONS,
  BOT_OWN_HOME_DESCRIPTION,
  BOT_OWN_HOME_REMOVE_DESCRIPTION,
  botOwnHomeReadUnavailableLabel,
} from "@t3tools/client-runtime/bots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BotDetail, BotHomeAccess, EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { type ReactNode, type Ref, useState } from "react";

import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { BotContinuationNotes } from "./BotContinuationNotes";

/**
 * The Bot's own Home above its projects: open or remove it, choose its access, and its working
 * notes and learning. Renders nothing on servers without it.
 */
export function BotOwnHomeSetting({
  environmentId,
  bot,
  disabled,
  learning,
  onChanged,
  ref,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: BotDetail;
  readonly disabled: boolean;
  /** The Home's learning list, shown while it is open. */
  readonly learning: ReactNode;
  readonly onChanged: () => void;
  readonly ref?: Ref<HTMLDivElement> | undefined;
}) {
  const navigate = useNavigate();
  const descriptor = useEnvironment(environmentId)?.serverConfig?.environment;
  const openHome = useAtomCommand(serverEnvironment.openBotHome, { label: "bot open home" });
  const removeHome = useAtomCommand(serverEnvironment.removeBotHome, {
    label: "bot remove home",
  });
  const canOpen = useAtomValue(serverEnvironment.openBotHome.permissionAtom(environmentId));
  const canRemove = useAtomValue(serverEnvironment.removeBotHome.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  // The live summary follows a change from another client; the editor's detail does not.
  const liveBot = useEnvironmentQuery(
    serverEnvironment.botsLive({ environmentId, input: {} }),
  ).data?.bots.find((entry) => entry.id === bot.id);
  const home = liveBot === undefined ? bot.home : liveBot.home;
  if (home === undefined) return null;
  const open = home !== null && home.detachedAt === null;
  const readUnavailable = botOwnHomeReadUnavailableLabel({
    capabilities: bot.capabilities,
    platformOs: descriptor?.platform.os,
  });
  const notesSupported = descriptor?.capabilities.botContinuation === true;
  const locked = disabled || busy;

  const run = async (
    title: string,
    command: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setBusy(true);
    const result = await command();
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title,
            description: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return false;
    }
    onChanged();
    return true;
  };
  const openConversation = () => {
    if (home === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, home.homeThreadId)),
    });
  };
  const setAccess = (access: BotHomeAccess) =>
    void run("Could not change the Home's access", () =>
      openHome({ environmentId, input: { botId: bot.id, access } }),
    );

  return (
    <div ref={ref} className="space-y-3 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <span className="flex items-center gap-2">
            <Label>Own Home</Label>
            {home !== null && !open ? <Badge variant="outline">Removed</Badge> : null}
          </span>
          <p className="text-sm text-muted-foreground">{BOT_OWN_HOME_DESCRIPTION}</p>
        </div>
        {open ? (
          <Button size="xs" variant="ghost-muted" disabled={locked} onClick={openConversation}>
            <MessageSquareIcon aria-hidden />
            Open conversation
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={locked || !canOpen}
            onClick={() =>
              void run("Could not open the Home", () =>
                openHome({ environmentId, input: { botId: bot.id } }),
              )
            }
          >
            {home === null ? "Open Home" : "Reopen Home"}
          </Button>
        )}
      </div>
      {home !== null && !open ? (
        <p className="text-sm text-muted-foreground">
          Reopening restores its conversation with its history.
        </p>
      ) : null}
      {open ? (
        <>
          <div className="space-y-2">
            <Label id={`bot-own-home-access-${bot.id}`}>Access</Label>
            <RadioGroup
              aria-labelledby={`bot-own-home-access-${bot.id}`}
              value={home.access}
              disabled={locked || !canOpen}
              onValueChange={(value) => {
                const option = BOT_OWN_HOME_ACCESS_OPTIONS.find((entry) => entry.value === value);
                if (option && option.value !== home.access) setAccess(option.value);
              }}
            >
              {BOT_OWN_HOME_ACCESS_OPTIONS.map((option) => (
                <label key={option.value} className="flex cursor-pointer items-start gap-3 text-sm">
                  <Radio value={option.value} />
                  <span className="min-w-0 space-y-0.5">
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-muted-foreground">{option.description}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
            {readUnavailable === null ? null : (
              <p
                role={home.access === "read" ? "alert" : undefined}
                className={
                  home.access === "read"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
              >
                {home.access === "read"
                  ? `This Home can't take turns with read access here. ${readUnavailable}`
                  : readUnavailable}
              </p>
            )}
          </div>
          {notesSupported ? (
            <BotContinuationNotes
              environmentId={environmentId}
              botId={bot.id}
              projectId={home.projectId}
              disabled={disabled}
            />
          ) : null}
          {learning}
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="ghost-destructive"
              disabled={locked || !canRemove}
              onClick={() => setConfirmingRemoval(true)}
            >
              Remove Home
            </Button>
          </div>
        </>
      ) : null}
      <AlertDialog
        open={confirmingRemoval}
        onOpenChange={(next) => {
          if (!next && !busy) setConfirmingRemoval(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {bot.name}'s own Home?</AlertDialogTitle>
            <AlertDialogDescription>{BOT_OWN_HOME_REMOVE_DESCRIPTION}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy || !canRemove}
              onClick={async () => {
                if (
                  await run("Could not remove the Home", () =>
                    removeHome({ environmentId, input: { botId: bot.id } }),
                  )
                ) {
                  setConfirmingRemoval(false);
                }
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
