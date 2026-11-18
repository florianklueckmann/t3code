import { useAtomValue } from "@effect/atom-react";
import {
  BOT_MAINTENANCE_DESCRIPTION,
  botMaintenanceRunLabel,
  botMaintenanceStatusLabel,
  canRunBotMaintenance,
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
import { Button } from "../ui/button";
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
  runSupported,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly formLocked: boolean;
  readonly runSupported: boolean;
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
  const runCommand = useAtomCommand(serverEnvironment.runBotMaintenance, {
    label: "bot maintenance run",
  });
  const canRunCommand = useAtomValue(
    serverEnvironment.runBotMaintenance.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const view = query.data;
  if (view === null) return null;
  const switchId = `bot-maintenance-${projectId}`;

  const run = async () => {
    setRunning(true);
    setLastRun(null);
    const result = await runCommand({ environmentId, input: scope });
    setRunning(false);
    query.refresh();
    if (result._tag === "Success") {
      setLastRun(botMaintenanceRunLabel(result.value));
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Maintenance didn't run",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

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
        {runSupported ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="xs"
              variant="outline"
              disabled={running || !canRunCommand || !canRunBotMaintenance(view)}
              onClick={() => void run()}
            >
              {running ? "Running…" : "Run now"}
            </Button>
            {lastRun !== null ? (
              <p className="text-xs text-muted-foreground" role="status">
                {lastRun}
              </p>
            ) : null}
          </div>
        ) : null}
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
