import { useAtomValue } from "@effect/atom-react";
import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import {
  botContinuationDraft,
  botContinuationWriterLabel,
  parseBotContinuationDraft,
  type BotContinuationDraft,
} from "@t3tools/client-runtime/bots";
import {
  BOT_CONTINUATION_SECTIONS,
  type BotContinuationRevision,
  type BotContinuationView,
  type BotId,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { reportBotFailure } from "../bots/reportBotFailure";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { BotNoteSections } from "./BotContinuationSection";
import {
  BOT_NOTE_SECTION_LABELS,
  BOT_NOTE_SECTION_PLACEHOLDERS,
  botNoteConflictMessage,
  botNoteInput,
  botNoteLimitHint,
  isEmptyBotNote,
  sameBotNote,
  useSaveBotNotes,
  type BotNoteConflict,
} from "./botContinuationNotes";
import { formatBotInstant } from "./botRoutineDraft";
import { FormField } from "./components/SettingsFormRows";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsBotNotesRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly projectId: ProjectId;
  /** Opens with the history loaded, for viewers who can't edit. */
  readonly history?: boolean;
}>) {
  const { environmentId, botId, projectId } = route.params;
  const config = useEnvironmentServerConfig(environmentId);
  const query = useEnvironmentQuery(
    serverEnvironment.botContinuation({ environmentId, input: { botId, projectId } }),
  );
  const unsupported = config !== null && config.environment.capabilities.botContinuation !== true;

  if (!unsupported && query.data !== null) {
    return (
      <BotNotesEditor
        environmentId={environmentId}
        view={query.data}
        initialHistoryOpen={route.params.history === true}
        onSaved={query.refresh}
        error={query.error}
      />
    );
  }
  return (
    <BotNotesScreen>
      <Text className="px-2 text-base text-foreground-muted">
        {unsupported
          ? "Update T3 Code on this environment to use working notes."
          : (query.error ?? "Loading working notes…")}
      </Text>
    </BotNotesScreen>
  );
}

function BotNotesScreen(props: { readonly children: ReactNode; readonly guardBack?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Working notes" guardBack={props.guardBack}>
      {/* The edge-to-edge Android window does not resize for the keyboard; iOS insets the scroll view instead. */}
      <KeyboardAvoidingView
        automaticOffset
        behavior="padding"
        enabled={Platform.OS === "android"}
        className="flex-1"
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {props.children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SettingsScreen>
  );
}

function BotNotesEditor(props: {
  readonly environmentId: EnvironmentId;
  /** The latest loaded notes; the draft keeps the view it started from. */
  readonly view: BotContinuationView;
  readonly initialHistoryOpen: boolean;
  readonly onSaved: () => void;
  readonly error: string | null;
}) {
  const { environmentId, view } = props;
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const scope = { botId: view.botId, projectId: view.projectId };
  const [base] = useState(view);
  const [draft, setDraft] = useState<BotContinuationDraft>(() => botContinuationDraft(view.note));
  const [conflict, setConflict] = useState<BotNoteConflict | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(props.initialHistoryOpen);
  const history = useEnvironmentQuery(
    historyOpen ? serverEnvironment.botContinuationHistory({ environmentId, input: scope }) : null,
  );
  const canSave = useAtomValue(serverEnvironment.saveBotContinuation.permissionAtom(environmentId));
  const save = useSaveBotNotes(environmentId);
  // Set once a save lands, so the removal guard lets the screen close.
  const done = useRef(false);
  const canWrite = view.writable && canSave;
  const parsed = parseBotContinuationDraft(draft);
  const hint = botNoteLimitHint(draft);
  const changed = !("note" in parsed) || !sameBotNote(parsed.note, base.note);
  const hasDraft = changed || conflict !== null;
  const preventRemove = hasDraft || saving;

  const leave = () => {
    done.current = true;
    if (navigation.isFocused()) navigation.goBack();
  };

  usePreventRemove(preventRemove, ({ data }) => {
    if (done.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (saving) {
      Dialog.alert("Saving working notes", "Wait for the notes to finish saving before leaving.");
      return;
    }
    Dialog.alert("Discard changes?", "Your unsaved changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard changes",
        style: "destructive",
        onPress: () => navigation.dispatch(data.action),
      },
    ]);
  });

  const submit = async (baseRevision: number | null) => {
    if (!canWrite || saving || !("note" in parsed)) return;
    if (conflict === null && !changed) {
      leave();
      return;
    }
    setSaving(true);
    const result = await save({ ...scope, baseRevision, note: parsed.note });
    setSaving(false);
    if (result._tag === "Failure") {
      reportBotFailure("Could not save working notes", result);
      return;
    }
    props.onSaved();
    const outcome = result.value;
    if (outcome._tag === "saved") {
      leave();
      return;
    }
    setConflict(outcome);
    if (historyOpen) history.refresh();
    Dialog.alert("Notes changed", `${botNoteConflictMessage(outcome)} Your draft is kept.`, [
      { text: "Review", style: "cancel" },
      { text: "Discard mine", style: "destructive", onPress: leave },
      { text: "Save mine", onPress: () => void submit(outcome.current.revision) },
    ]);
  };

  const restore = async (revision: BotContinuationRevision) => {
    if (!canWrite || saving) return;
    setSaving(true);
    const result = await save({
      ...scope,
      baseRevision: view.revision,
      note: botNoteInput(revision.note),
      restoredFrom: revision.revision,
    });
    setSaving(false);
    if (result._tag === "Failure") {
      reportBotFailure("Could not restore the revision", result);
      return;
    }
    props.onSaved();
    if (result.value._tag === "saved") {
      leave();
      return;
    }
    history.refresh();
    Dialog.alert(
      "Notes changed",
      "These notes changed before the restore. Check the current notes, then restore again if you still want to.",
    );
  };

  return (
    <BotNotesScreen guardBack={preventRemove}>
      {props.error === null ? null : (
        <Text className="px-2 text-base text-danger-foreground">{props.error}</Text>
      )}
      {conflict === null ? null : (
        <SettingsSection title="Current notes" footer={botNoteConflictMessage(conflict)}>
          <View className="gap-3 px-4 py-3">
            {isEmptyBotNote(conflict.current.note) ? (
              <Text textRole="body" className="text-foreground-muted">
                Empty.
              </Text>
            ) : (
              <BotNoteSections note={conflict.current.note} captions={false} />
            )}
          </View>
        </SettingsSection>
      )}
      {canWrite ? null : (
        <Text className="px-2 text-sm text-foreground-muted">
          {hasDraft ? "Your unsaved draft is kept. " : ""}
          {view.writable
            ? "You can view these notes but not change them on this environment."
            : "These notes can't be changed while the Bot is archived or the project is detached."}
        </Text>
      )}
      {canWrite || hasDraft ? (
        <View
          className="gap-5"
          pointerEvents={saving ? "none" : "auto"}
          accessibilityElementsHidden={saving}
          importantForAccessibility={saving ? "no-hide-descendants" : "auto"}
        >
          <SettingsSection footer="One item per line. Unchanged lines keep their sources.">
            {BOT_CONTINUATION_SECTIONS.map((section, index) => (
              <FormField
                key={section}
                label={BOT_NOTE_SECTION_LABELS[section]}
                value={draft[section]}
                placeholder={BOT_NOTE_SECTION_PLACEHOLDERS[section]}
                multiline
                borderTop={index > 0}
                disabled={!canWrite || saving}
                onChange={(value) => setDraft((current) => ({ ...current, [section]: value }))}
              />
            ))}
          </SettingsSection>
          {hint !== null ? (
            <Text
              className={
                hint.over
                  ? "px-2 text-sm text-danger-foreground"
                  : "px-2 text-sm text-foreground-muted"
              }
            >
              {hint.text}
            </Text>
          ) : "error" in parsed ? (
            <Text className="px-2 text-sm text-danger-foreground">{parsed.error}</Text>
          ) : null}
          {conflict === null ? (
            <Button
              tone="primary"
              fullWidth
              loading={saving}
              disabled={!canWrite || !changed || "error" in parsed}
              onPress={() => void submit(base.revision)}
              label={saving ? "Saving…" : "Save notes"}
            />
          ) : (
            <View className="gap-3">
              <Button
                tone="primary"
                fullWidth
                loading={saving}
                disabled={!canWrite || "error" in parsed}
                onPress={() => void submit(conflict.current.revision)}
                label={saving ? "Saving…" : "Save mine"}
              />
              <Button tone="secondary" fullWidth onPress={leave} label="Discard mine" />
            </View>
          )}
        </View>
      ) : null}
      {view.sources.length === 0 ? null : (
        <SettingsSection
          title="Sources"
          footer={
            view.moreSources === 0 ? undefined : `${view.moreSources} more in the conversation.`
          }
        >
          {view.sources.map((source, index) => (
            <View
              key={source.messageId}
              className={
                index === 0 ? "gap-1 px-4 py-3" : "gap-1 border-t border-border-subtle px-4 py-3"
              }
            >
              <Text textRole="footnote" className="text-foreground-muted">
                {source.directUser ? "You" : "Home input"}
              </Text>
              <Text textRole="body" className="text-foreground">
                {source.text}
              </Text>
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              selectDetail({
                name: "Thread",
                params: {
                  environmentId: String(environmentId),
                  threadId: String(view.homeThreadId),
                },
              })
            }
            className="min-h-14 flex-row items-center border-t border-border-subtle px-4 py-3 active:opacity-70"
          >
            <Text textRole="body" className="text-primary-text">
              Open conversation
            </Text>
          </Pressable>
        </SettingsSection>
      )}
      <SettingsSection title="History">
        {!historyOpen ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setHistoryOpen(true)}
            className="min-h-14 flex-row items-center px-4 py-3 active:opacity-70"
          >
            <Text textRole="body" className="text-primary-text">
              Show history
            </Text>
          </Pressable>
        ) : history.error ? (
          <Text className="p-4 text-base text-danger-foreground">{history.error}</Text>
        ) : history.data === null ? (
          <Text className="p-4 text-base text-foreground-muted">Loading history…</Text>
        ) : history.data.revisions.length === 0 ? (
          <Text className="p-4 text-base text-foreground-muted">No saved revisions yet.</Text>
        ) : (
          history.data.revisions.map((revision, index) => (
            <RevisionRow
              key={revision.revision}
              revision={revision}
              current={revision.revision === view.revision}
              borderTop={index > 0}
              restoreDisabled={!canWrite || saving || changed || conflict !== null}
              onRestore={() => void restore(revision)}
            />
          ))
        )}
      </SettingsSection>
    </BotNotesScreen>
  );
}

function RevisionRow(props: {
  readonly revision: BotContinuationRevision;
  readonly current: boolean;
  readonly borderTop: boolean;
  readonly restoreDisabled: boolean;
  readonly onRestore: () => void;
}) {
  const { revision } = props;
  const [expanded, setExpanded] = useState(false);
  const empty = isEmptyBotNote(revision.note);
  return (
    <View
      className={
        props.borderTop ? "gap-2 border-t border-border-subtle px-4 py-3" : "gap-2 px-4 py-3"
      }
    >
      <View className="flex-row items-start gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded, disabled: empty }}
          disabled={empty}
          onPress={() => setExpanded((open) => !open)}
          className="min-w-0 flex-1 active:opacity-70"
        >
          <Text textRole="footnote" className="text-foreground-muted">
            r{revision.revision} · {botContinuationWriterLabel(revision.updatedBy)} ·{" "}
            {formatBotInstant(revision.updatedAt)}
            {revision.restoredFrom === null ? "" : ` · restored from r${revision.restoredFrom}`}
            {empty ? " · Empty" : ""}
          </Text>
        </Pressable>
        {props.current ? (
          <Text textRole="footnote" className="text-foreground-muted">
            Current
          </Text>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Restore revision ${revision.revision}`}
            disabled={props.restoreDisabled}
            hitSlop={8}
            onPress={props.onRestore}
            className="active:opacity-70 disabled:opacity-50"
          >
            <Text textRole="footnote" className="text-primary-text">
              Restore
            </Text>
          </Pressable>
        )}
      </View>
      {expanded && !empty ? <BotNoteSections note={revision.note} captions={false} /> : null}
    </View>
  );
}
