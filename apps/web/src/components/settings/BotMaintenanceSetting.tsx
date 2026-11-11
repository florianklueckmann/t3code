import { useAtomValue } from "@effect/atom-react";
import {
  BOT_MAINTENANCE_DESCRIPTION,
  botMaintenanceStatusLabel,
  canToggleBotMaintenance,
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
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Maintenance for one project context; it saves apart from the Bot form. */
export function BotMaintenanceSetting({
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
    serverEnvironment.botMaintenance({ environmentId, input: scope }),
  );
  const configure = useAtomCommand(serverEnvironment.configureBotMaintenance, {
    label: "bot maintenance configure",
  });
  const canConfigure = useAtomValue(
    serverEnvironment.configureBotMaintenance.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const view = query.data;
  if (view === null) return null;
  const switchId = `bot-maintenance-${projectId}`;

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    const result = await configure({
      environmentId,
      input: { ...scope, baseRevision: view.revision, enabled },
    });
    setBusy(false);
    query.refresh();
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not change maintenance",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    } else if (result.value._tag === "conflict") {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Maintenance changed elsewhere",
          description: "Check the current setting, then change it again if you still want to.",
        }),
      );
    }
  };

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={switchId}>{`${title} · Maintenance`}</Label>
        <p className="text-xs text-muted-foreground">{BOT_MAINTENANCE_DESCRIPTION}</p>
        <p className="text-xs text-muted-foreground" id={`${switchId}-status`}>
          {botMaintenanceStatusLabel(view)}
        </p>
      </div>
      <Switch
        id={switchId}
        aria-describedby={`${switchId}-status`}
        checked={view.enabled}
        disabled={busy || !canConfigure || !canToggleBotMaintenance(view, formLocked)}
        onCheckedChange={(enabled) => void toggle(enabled)}
      />
    </div>
  );
}
