import { useAtomValue } from "@effect/atom-react";
import {
  MAC_CALENDAR_CONNECT_ELSEWHERE_TEXT,
  MAC_CALENDAR_UNSUPPORTED_TEXT,
  macCalendarAuthorizationText,
  macCalendarStatusText,
  mcpConnectionUsedByText,
  type McpConnectionUsage,
} from "@t3tools/client-runtime/mcp-connections";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MacCalendarInspectResult,
  MacCalendarSummary,
} from "@t3tools/contracts";
import { useState } from "react";

import { useRemoteOpenState } from "../../remoteOpen";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

const STATUS_BADGE = {
  ok: "success",
  warning: "warning",
  error: "error",
  muted: "outline",
} as const;

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
}

/** Calendar (this Mac) in the connection list: its state, the Bots using it, and its setup. */
export function MacCalendarRow({
  environmentId,
  calendar,
  usage,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly calendar: MacCalendarSummary;
  readonly usage: McpConnectionUsage;
  readonly canEdit: boolean;
}) {
  const update = useAtomCommand(serverEnvironment.updateMacCalendar, {
    label: "mac calendar set enabled",
  });
  const [busy, setBusy] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  if (calendar.availability === "unsupported") {
    return <SettingsRow title={calendar.label} description={MAC_CALENDAR_UNSUPPORTED_TEXT} />;
  }
  const status = macCalendarStatusText(calendar);
  const usedBy = mcpConnectionUsedByText(usage, calendar.id);
  const toggleEnabled = async () => {
    setBusy(true);
    const result = await update({
      environmentId,
      input: { expectedRevision: calendar.revision, enabled: !calendar.enabled },
    });
    setBusy(false);
    const description = failureMessage(result);
    if (description !== null) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: calendar.enabled ? "Could not disable Calendar" : "Could not enable Calendar",
          description,
        }),
      );
    }
  };
  return (
    <>
      <SettingsRow
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 wrap-anywhere">{calendar.label}</span>
            <Badge variant="outline">Read only</Badge>
            {calendar.enabled ? null : <Badge variant="outline">Disabled</Badge>}
          </span>
        }
        description={
          <>
            <span className="block">
              Built in. Reads the calendars you select in Apple Calendar on this Mac, including
              accounts synced into it.
            </span>
            {usedBy === null ? null : <span className="block">{usedBy}</span>}
          </>
        }
        status={<Badge variant={STATUS_BADGE[status.tone]}>{status.text}</Badge>}
        control={
          <div className="flex flex-wrap items-center justify-end gap-1">
            <Button
              size="xs"
              variant="ghost"
              disabled={!canEdit || calendar.availability !== "available"}
              onClick={() => setSetupOpen(true)}
            >
              Set up
            </Button>
            <Button size="xs" variant="ghost" disabled={!canEdit || busy} onClick={toggleEnabled}>
              {calendar.enabled ? "Disable" : "Enable"}
            </Button>
          </div>
        }
      />
      {setupOpen ? (
        <MacCalendarDialog
          environmentId={environmentId}
          calendar={calendar}
          onClose={() => setSetupOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Connects the helper on the host Mac and chooses the calendars Bots may read. */
function MacCalendarDialog({
  environmentId,
  calendar,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly calendar: MacCalendarSummary;
  readonly onClose: () => void;
}) {
  const onHost = useRemoteOpenState(environmentId).mode === "local-exec";
  const inspect = useAtomCommand(serverEnvironment.inspectMacCalendar, {
    label: "mac calendar inspect",
  });
  const setup = useAtomCommand(serverEnvironment.setupMacCalendar, { label: "mac calendar setup" });
  const update = useAtomCommand(serverEnvironment.updateMacCalendar, {
    label: "mac calendar select",
  });
  const canSetup = useAtomValue(serverEnvironment.setupMacCalendar.permissionAtom(environmentId));
  const [inspected, setInspected] = useState<MacCalendarInspectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"inspect" | "setup" | "save" | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(calendar.calendars.map((entry) => entry.id)),
  );

  const check = async () => {
    setBusy("inspect");
    const result = await inspect({ environmentId, input: {} });
    setBusy(null);
    if (result._tag === "Success") setInspected(result.value);
    setError(failureMessage(result));
  };
  const connect = async () => {
    setBusy("setup");
    const result = await setup({ environmentId, input: {} });
    setBusy(null);
    setError(failureMessage(result));
    if (result._tag === "Success") await check();
  };
  const save = async () => {
    setBusy("save");
    const result = await update({
      environmentId,
      // A selected calendar no longer on this Mac has no checkbox, so it drops out here.
      input: {
        expectedRevision: calendar.revision,
        calendarIds: (inspected?.calendars ?? [])
          .map((entry) => entry.id)
          .filter((id) => selected.has(id)),
      },
    });
    setBusy(null);
    const message = failureMessage(result);
    setError(message);
    if (result._tag === "Success") onClose();
  };

  const authorization =
    inspected === null ? null : macCalendarAuthorizationText(inspected.authorization);
  const fullAccess = inspected?.authorization === "fullAccess";
  const needsPrompt = inspected?.authorization === "notDetermined";
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{calendar.label}</DialogTitle>
          <DialogDescription>
            Bots you grant it read events from the calendars you select here, and nothing else.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3 text-sm">
            {inspected === null ? (
              <p className="text-muted-foreground">
                Check asks the T3 Calendar Helper whether it may read calendars. It never asks macOS
                for permission.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span>Calendar access:</span>
                {authorization === null ? null : (
                  <Badge variant={STATUS_BADGE[authorization.tone]}>{authorization.text}</Badge>
                )}
              </div>
            )}
            {needsPrompt && !onHost ? (
              <p className="text-muted-foreground">{MAC_CALENDAR_CONNECT_ELSEWHERE_TEXT}</p>
            ) : null}
            {needsPrompt && onHost ? (
              <p className="text-muted-foreground">
                Connect Calendar opens the macOS prompt for T3 Calendar Helper. Choose Allow Full
                Access.
              </p>
            ) : null}
            {fullAccess ? (
              inspected.calendars.length === 0 ? (
                <p className="text-muted-foreground">This Mac has no calendars.</p>
              ) : (
                <ul className="grid gap-2">
                  {inspected.calendars.map((entry) => (
                    <li key={entry.id}>
                      <label className="flex items-start gap-3">
                        <Checkbox
                          checked={selected.has(entry.id)}
                          onCheckedChange={(checked) => {
                            const next = new Set(selected);
                            if (checked === true) next.add(entry.id);
                            else next.delete(entry.id);
                            setSelected(next);
                          }}
                        />
                        <span className="min-w-0">
                          <span className="block wrap-anywhere">{entry.title}</span>
                          <span className="block text-xs text-muted-foreground wrap-anywhere">
                            {entry.sourceName}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
            {error === null ? null : <p className="text-destructive">{error}</p>}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="outline" disabled={busy !== null} onClick={() => void check()}>
            {inspected === null ? "Check" : "Check again"}
          </Button>
          {needsPrompt && onHost ? (
            <Button disabled={busy !== null || !canSetup} onClick={() => void connect()}>
              Connect Calendar
            </Button>
          ) : null}
          {fullAccess ? (
            <Button disabled={busy !== null} onClick={() => void save()}>
              Save selection
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
