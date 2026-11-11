import { useAtomValue } from "@effect/atom-react";
import { botMcpGrantsChange, botMcpGrantsSection } from "@t3tools/client-runtime/mcp-connections";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BotId, McpConnectionId } from "@t3tools/contracts";
import { useState } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { stackedThreadToast, toastManager } from "../ui/toast";

const STATUS_BADGE = {
  ok: "success",
  warning: "warning",
  error: "error",
  muted: "outline",
} as const;

/** The MCP connections a Bot may use; each change saves the whole set apart from the Bot form. */
export function BotMcpGrantsSetting({
  environment,
  botId,
  formLocked,
}: {
  readonly environment: EnvironmentPresentation;
  readonly botId: BotId;
  readonly formLocked: boolean;
}) {
  const environmentId = environment.environmentId;
  const descriptor = environment.serverConfig?.environment;
  const bots = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const catalog = useEnvironmentQuery(serverEnvironment.mcpConnections(environmentId));
  const routines = useEnvironmentQuery(
    descriptor?.capabilities.botRoutines === true
      ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} })
      : null,
  );
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canChange = useAtomValue(serverEnvironment.setBotMcpGrants.permissionAtom(environmentId));
  const setGrants = useAtomCommand(serverEnvironment.setBotMcpGrants, {
    label: "bot set mcp grants",
  });
  const [busy, setBusy] = useState(false);
  const bot = bots.data?.bots.find((entry) => entry.id === botId);
  const grants = bot?.mcpGrants;
  if (bot === undefined || grants === undefined || descriptor === undefined) return null;
  if (catalog.data === null) {
    return catalog.error === null ? null : (
      <p className="text-xs text-destructive">{catalog.error}</p>
    );
  }
  const connections = catalog.data.connections;
  const view = botMcpGrantsSection({
    botId,
    grants,
    catalog: connections,
    providerDriver: providers.find(
      (provider) => provider.instanceId === bot.modelSelection.instanceId,
    )?.driver,
    platformOs: descriptor.platform.os,
    environmentLabel: environment.label,
    routines: routines.data?.tasks ?? null,
    canChange,
    archived: bot.archivedAt !== null,
  });

  const change = async (connectionId: McpConnectionId, granted: boolean) => {
    setBusy(true);
    const result = await setGrants({
      environmentId,
      input: botMcpGrantsChange(botId, grants, connections, { connectionId, granted }),
    });
    setBusy(false);
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    // A stale revision is refused; the live Bot list already shows the newer set.
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not change MCP connections",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  return (
    <div className="space-y-2">
      <Label>MCP connections</Label>
      {view.rows.length > 0 ? (
        <ul className="space-y-2">
          {view.rows.map((row) => (
            <li key={row.id}>
              <label className="flex items-start gap-3 text-sm">
                <Checkbox
                  checked={row.granted}
                  disabled={busy || formLocked || !view.editable}
                  onCheckedChange={(checked) => void change(row.id, checked === true)}
                />
                <span className="min-w-0 space-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 font-medium wrap-anywhere">{row.label}</span>
                    {row.transport === null ? null : (
                      <Badge variant="outline">{row.transport === "http" ? "HTTP" : "stdio"}</Badge>
                    )}
                  </span>
                  <Badge variant={STATUS_BADGE[row.status.tone]}>{row.status.text}</Badge>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {view.notes.map((note) => (
        <p
          key={note.text}
          className={
            note.tone === "warning" ? "text-sm text-warning" : "text-sm text-muted-foreground"
          }
        >
          {note.text}
        </p>
      ))}
    </div>
  );
}
