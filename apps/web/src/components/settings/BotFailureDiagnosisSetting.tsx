import { useAtomValue } from "@effect/atom-react";
import {
  BOT_FAILURE_DIAGNOSIS_DESCRIPTION,
  botFailureDiagnosisStatusLabel,
  canToggleBotFailureDiagnosis,
} from "@t3tools/client-runtime/bots";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOT_FAILURE_DIAGNOSIS_BRIEF_MAX_CHARS,
  type BotId,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Failure diagnosis for one project context; it saves apart from the Bot form. */
export function BotFailureDiagnosisSetting({
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
    serverEnvironment.botFailureDiagnosis({ environmentId, input: scope }),
  );
  const configure = useAtomCommand(serverEnvironment.configureBotFailureDiagnosis, {
    label: "bot failure diagnosis configure",
  });
  const canConfigure = useAtomValue(
    serverEnvironment.configureBotFailureDiagnosis.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const view = query.data;
  if (view === null) return null;
  const switchId = `bot-failure-diagnosis-${projectId}`;

  const save = async (change: { readonly enabled: boolean; readonly brief?: string }) => {
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
          title: "Could not change failure diagnosis",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    } else if (result.value._tag === "conflict") {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Failure diagnosis changed elsewhere",
          description: "Check the current setting, then change it again if you still want to.",
        }),
      );
    }
  };

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor={switchId}>{`${title} · Diagnose failed routines`}</Label>
        <p className="text-xs text-muted-foreground">{BOT_FAILURE_DIAGNOSIS_DESCRIPTION}</p>
        <p className="text-xs text-muted-foreground" id={`${switchId}-status`}>
          {botFailureDiagnosisStatusLabel(view)}
        </p>
        <div className="space-y-1 pt-1">
          <Label htmlFor={`${switchId}-brief`}>Diagnostic brief</Label>
          {/* Saved on blur, so typing does not save every keystroke. */}
          <Textarea
            key={view.brief}
            id={`${switchId}-brief`}
            size="sm"
            maxLength={BOT_FAILURE_DIAGNOSIS_BRIEF_MAX_CHARS}
            defaultValue={view.brief}
            disabled={busy || !canConfigure || formLocked || !view.writable}
            onBlur={(event) => {
              const brief = event.currentTarget.value.trim();
              if (brief !== "" && brief !== view.brief) void save({ enabled: view.enabled, brief });
            }}
          />
        </div>
      </div>
      <Switch
        id={switchId}
        aria-describedby={`${switchId}-status`}
        checked={view.enabled}
        disabled={busy || !canConfigure || !canToggleBotFailureDiagnosis(view, formLocked)}
        onCheckedChange={(enabled) => void save({ enabled })}
      />
    </div>
  );
}
