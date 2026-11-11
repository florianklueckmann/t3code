import { useAtomValue } from "@effect/atom-react";
import {
  BOT_HOME_CHECK_DESCRIPTION,
  botHomeCheckLastLabel,
  botHomeCheckStatusLabel,
  canToggleBotHomeCheck,
} from "@t3tools/client-runtime/bots";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BotId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** The daily Home check for one project context; it saves apart from the Bot form. */
export function BotHomeCheckSetting({
  environmentId,
  botId,
  projectId,
  title,
  formLocked,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly formLocked: boolean;
}) {
  const scope = { botId, projectId };
  const query = useEnvironmentQuery(
    serverEnvironment.botHomeCheck({ environmentId, input: scope }),
  );
  const configure = useAtomCommand(serverEnvironment.configureBotHomeCheck, {
    label: "bot home check configure",
  });
  const canConfigure = useAtomValue(
    serverEnvironment.configureBotHomeCheck.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const view = query.data;
  if (view === null) return null;
  const switchId = `bot-home-check-${projectId}`;
  const last = botHomeCheckLastLabel(view);

  const save = async (change: { readonly enabled: boolean; readonly timeOfDay?: string }) => {
    setBusy(true);
    const result = await configure({
      environmentId,
      input: { ...scope, baseRevision: view.revision, ...change },
    });
    setBusy(false);
    query.refresh();
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not change the Home check",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    } else if (result.value._tag === "conflict") {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Home check changed elsewhere",
          description: "Check the current setting, then change it again if you still want to.",
        }),
      );
    }
  };

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={switchId}>{`${title} · Daily Home check`}</Label>
        <p className="text-xs text-muted-foreground">{BOT_HOME_CHECK_DESCRIPTION}</p>
        <p className="text-xs text-muted-foreground" id={`${switchId}-status`}>
          {botHomeCheckStatusLabel(view)}
          {last === null ? null : ` · ${last}`}
        </p>
        <div className="flex items-center gap-2 pt-1">
          <Label htmlFor={`${switchId}-time`}>Check at</Label>
          {/* Saved on blur: a time input reports each edited segment as its own change. */}
          <Input
            key={view.timeOfDay}
            type="time"
            id={`${switchId}-time`}
            nativeInput
            className="w-32"
            defaultValue={view.timeOfDay}
            disabled={busy || !canConfigure || formLocked || !view.writable}
            onBlur={(event) => {
              const timeOfDay = event.currentTarget.value;
              if (/^\d{2}:\d{2}$/.test(timeOfDay) && timeOfDay !== view.timeOfDay)
                void save({ enabled: view.enabled, timeOfDay });
            }}
          />
        </div>
      </div>
      <Switch
        id={switchId}
        aria-describedby={`${switchId}-status`}
        checked={view.enabled}
        disabled={busy || !canConfigure || !canToggleBotHomeCheck(view, formLocked)}
        onCheckedChange={(enabled) => void save({ enabled })}
      />
    </div>
  );
}
