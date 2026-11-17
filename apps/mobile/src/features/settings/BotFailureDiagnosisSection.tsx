import { useAtomValue } from "@effect/atom-react";
import {
  BOT_FAILURE_DIAGNOSIS_DESCRIPTION,
  botFailureDiagnosisStatusLabel,
  canToggleBotFailureDiagnosis,
} from "@t3tools/client-runtime/bots";
import {
  BOT_FAILURE_DIAGNOSIS_BRIEF_MAX_CHARS,
  type BotId,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportBotFailure } from "../bots/reportBotFailure";
import { SettingsSection } from "./components/SettingsSection";

/** Failure diagnosis for one project context; it saves apart from the Bot form. */
export function BotFailureDiagnosisSection(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly formLocked: boolean;
  /** True while the brief being edited differs from the saved one. */
  readonly onDraftChange: (unsaved: boolean) => void;
}) {
  const { environmentId, botId, projectId } = props;
  const scope = { botId, projectId };
  const query = useEnvironmentQuery(
    serverEnvironment.botFailureDiagnosis({ environmentId, input: scope }),
  );
  // Failures surface in this section's own alert.
  const configure = useAtomCommand(serverEnvironment.configureBotFailureDiagnosis, {
    reportFailure: false,
  });
  const canConfigure = useAtomValue(
    serverEnvironment.configureBotFailureDiagnosis.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  // The brief saves when editing ends, so each keystroke is not a save.
  const [editing, setEditing] = useState<string | null>(null);
  const view = query.data;
  if (view === null) return null;

  const save = async (change: { readonly enabled: boolean; readonly brief?: string }) => {
    setBusy(true);
    const result = await configure({
      environmentId,
      input: { ...scope, baseRevision: view.revision, ...change },
    });
    setBusy(false);
    query.refresh();
    if (result._tag === "Failure") reportBotFailure("Could not change failure diagnosis", result);
    else if (result.value._tag === "conflict")
      Dialog.alert(
        "Failure diagnosis changed elsewhere",
        "Check the current setting, then change it again if you still want to.",
      );
  };
  const edit = (brief: string | null) => {
    setEditing(brief);
    props.onDraftChange(brief !== null && brief.trim() !== view.brief);
  };
  const finishEditing = () => {
    const brief = editing?.trim() ?? "";
    edit(null);
    if (brief !== "" && brief !== view.brief) void save({ enabled: view.enabled, brief });
  };

  return (
    <SettingsSection title={props.title}>
      <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text textRole="body" className="text-foreground">
            Diagnose failed routines
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            {BOT_FAILURE_DIAGNOSIS_DESCRIPTION}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            {botFailureDiagnosisStatusLabel(view)}
          </Text>
        </View>
        <ThemedSwitch
          accessibilityLabel="Diagnose failed routines"
          value={view.enabled}
          disabled={busy || !canConfigure || !canToggleBotFailureDiagnosis(view, props.formLocked)}
          onValueChange={(enabled) => void save({ enabled })}
        />
      </View>
      <View className="gap-2 border-t border-border-subtle px-4 py-3">
        <Text className="text-sm text-foreground-muted">Diagnostic brief</Text>
        <TextInput
          accessibilityLabel="Diagnostic brief"
          value={editing ?? view.brief}
          onFocus={() => edit(view.brief)}
          onChangeText={edit}
          onBlur={finishEditing}
          readOnly={busy || !canConfigure || props.formLocked || !view.writable}
          maxLength={BOT_FAILURE_DIAGNOSIS_BRIEF_MAX_CHARS}
          multiline
          scrollEnabled
          textAlignVertical="top"
          className="max-h-40 min-h-20 font-sans text-base text-foreground"
        />
      </View>
    </SettingsSection>
  );
}
