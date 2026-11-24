import { useAtomValue } from "@effect/atom-react";
import {
  BOT_ALERTS_DESCRIPTION,
  BOT_REMIT_DESCRIPTION,
  botAlertsStatusLabel,
  parseBotAlertDailyLimit,
} from "@t3tools/client-runtime/bots";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOT_ALERT_DEFAULT_QUIET_HOURS,
  BOT_REMIT_MAX_LENGTH,
  type BotAttentionView,
  type BotId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";

const TIME = /^\d{2}:\d{2}$/;

/** A Bot's alert budget and remit; each control saves apart from the Bot form. */
export function BotAttentionSetting({
  environmentId,
  botId,
  formLocked,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly formLocked: boolean;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.botAttention({ environmentId, input: { botId } }),
  );
  const configure = useAtomCommand(serverEnvironment.configureBotAttention, {
    label: "bot attention configure",
  });
  const canConfigure = useAtomValue(
    serverEnvironment.configureBotAttention.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [remitDraft, setRemitDraft] = useState<string | null>(null);
  const view = query.data;
  if (view === null) return null;
  const disabled = busy || !canConfigure || formLocked || !view.writable;
  const remit = remitDraft ?? view.remit;
  const id = `bot-attention-${botId}`;

  const save = async (
    change: Partial<Pick<BotAttentionView, "dailyLimit" | "quietHours" | "remit">>,
  ) => {
    setBusy(true);
    const result = await configure({
      environmentId,
      input: {
        botId,
        baseRevision: view.revision,
        dailyLimit: change.dailyLimit ?? view.dailyLimit,
        quietHours: change.quietHours === undefined ? view.quietHours : change.quietHours,
        remit: change.remit ?? view.remit,
      },
    });
    setBusy(false);
    query.refresh();
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return false;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not change the Bot's alerts",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    } else if (result.value._tag === "conflict") {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Alerts changed elsewhere",
          description: "Check the current settings, then change them again if you still want to.",
        }),
      );
    } else {
      if (change.remit !== undefined) setRemitDraft(null);
      return true;
    }
    return false;
  };

  const saveLimit = async (input: HTMLInputElement) => {
    const limit = parseBotAlertDailyLimit(input.value);
    if (limit !== null && limit !== view.dailyLimit && (await save({ dailyLimit: limit }))) return;
    input.value = String(view.dailyLimit);
  };

  const saveTime = (edge: "start" | "end", value: string) => {
    const hours = view.quietHours;
    if (hours === null || !TIME.test(value) || value === hours[edge]) return;
    const next = { ...hours, [edge]: value };
    if (next.start === next.end) return;
    void save({ quietHours: next });
  };

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="space-y-1">
        <Label htmlFor={`${id}-limit`}>Alerts</Label>
        <p className="text-xs text-muted-foreground">{BOT_ALERTS_DESCRIPTION}</p>
        <p className="text-xs text-muted-foreground" role="status">
          {botAlertsStatusLabel(view)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Label htmlFor={`${id}-limit`}>Alerts per day</Label>
        <Input
          key={`limit-${view.dailyLimit}`}
          id={`${id}-limit`}
          type="number"
          inputMode="numeric"
          nativeInput
          min={0}
          step={1}
          className="w-24"
          defaultValue={view.dailyLimit}
          disabled={disabled}
          onBlur={(event) => void saveLimit(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Switch
          id={`${id}-quiet`}
          checked={view.quietHours !== null}
          disabled={disabled}
          onCheckedChange={(on) =>
            void save({ quietHours: on ? BOT_ALERT_DEFAULT_QUIET_HOURS : null })
          }
        />
        <Label htmlFor={`${id}-quiet`}>Quiet hours</Label>
        {view.quietHours === null ? null : (
          <>
            {/* Saved on blur: a time input reports each edited segment as its own change. */}
            <Input
              key={`start-${view.quietHours.start}`}
              type="time"
              aria-label="Quiet hours start"
              nativeInput
              className="w-32"
              defaultValue={view.quietHours.start}
              disabled={disabled}
              onBlur={(event) => saveTime("start", event.currentTarget.value)}
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              key={`end-${view.quietHours.end}`}
              type="time"
              aria-label="Quiet hours end"
              nativeInput
              className="w-32"
              defaultValue={view.quietHours.end}
              disabled={disabled}
              onBlur={(event) => saveTime("end", event.currentTarget.value)}
            />
            <span className="text-xs text-muted-foreground">server time</span>
          </>
        )}
      </div>
      <div className="space-y-1.5 border-t pt-3">
        <Label htmlFor={`${id}-remit`}>Remit</Label>
        <p className="text-xs text-muted-foreground">{BOT_REMIT_DESCRIPTION}</p>
        <Textarea
          id={`${id}-remit`}
          placeholder="e.g. Only school deadlines and bills need me. Newsletters never do."
          maxLength={BOT_REMIT_MAX_LENGTH}
          value={remit}
          disabled={disabled}
          onChange={(event) => setRemitDraft(event.target.value)}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {`${remit.length} / ${BOT_REMIT_MAX_LENGTH}`}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || remitDraft === null || remitDraft.trim() === view.remit}
            onClick={() => void save({ remit })}
          >
            Save remit
          </Button>
        </div>
      </div>
    </div>
  );
}
