import { useAtomValue } from "@effect/atom-react";
import {
  BOT_LEARNING_KIND_LABELS,
  BOT_LEARNING_STATUS_LABELS,
  BOT_LEARNING_SUGGESTION_LABEL,
  BOT_TURN_LEARNING_EXPLANATION,
  botLearningConfirmedLabel,
  botLearningOriginLabel,
  botLearningRevisionInput,
  botLearningScopeChange,
  botLearningViews,
  botTurnLearningView,
} from "@t3tools/client-runtime/bots";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { BotId, BotLearningEntry, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { pinBotEditorDraft } from "./bot-editor";
import { FormField } from "./components/SettingsFormRows";
import { SettingsSection } from "./components/SettingsSection";

function ActionText({
  label,
  disabled,
  tone = "primary",
  onPress,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly tone?: "primary" | "muted";
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      className="active:opacity-70 disabled:opacity-50"
    >
      <Text
        textRole="footnote"
        className={tone === "primary" ? "text-primary-text" : "text-foreground-muted"}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A Bot's learning for one project, or for all its projects when `projectId` is null. Changes
 * apply at once, apart from the form's Save.
 */
export function BotLearningSection({
  environmentId,
  botId,
  projectId,
  title,
  disabled,
  focus,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly projectId: ProjectId | null;
  readonly title: string;
  readonly disabled: boolean;
  /** Shows only this entry, with this revision marked, as a Home notice opens it. */
  readonly focus?: { readonly entryId: string; readonly revision: number };
}) {
  const detailAtom = serverEnvironment.botDetail({ environmentId, input: { botId } });
  const detail = useEnvironmentQuery(detailAtom);
  const record = useAtomCommand(serverEnvironment.recordBotLearning, { reportFailure: false });
  const decide = useAtomCommand(serverEnvironment.decideBotLearning, { reportFailure: false });
  const retire = useAtomCommand(serverEnvironment.retireBotLearning, { reportFailure: false });
  const restore = useAtomCommand(serverEnvironment.restoreBotLearning, { reportFailure: false });
  const canChange = useAtomValue(serverEnvironment.recordBotLearning.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ entryId: string; text: string } | null>(null);
  const locked = disabled || busy || !canChange;
  const decideSuggestion = useAtomCommand(serverEnvironment.decideBotLearningSuggestion, {
    reportFailure: false,
  });
  const projects = useProjects();
  const titleOf = (id: ProjectId) =>
    projects.find((project) => project.environmentId === environmentId && project.id === id)
      ?.title ?? "Unknown project";
  const views = detail.data
    ? botLearningViews(detail.data.learning, projectId, detail.data.learningSuggestions).filter(
        (view) => focus === undefined || view.entry.id === focus.entryId,
      )
    : [];
  const turn =
    detail.data && projectId !== null && focus === undefined
      ? botTurnLearningView(detail.data, projectId)
      : null;
  const marked = (revision: number) =>
    focus?.revision === revision ? "rounded-lg bg-subtle px-2 pb-2" : "";

  const run = async (
    failureTitle: string,
    command: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setBusy(true);
    const result = await command();
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(failureTitle, error instanceof Error ? error.message : "The request failed.");
      }
      return false;
    }
    if (detail.data) pinBotEditorDraft(detail.data);
    detail.refresh();
    return true;
  };
  const revise = async (
    failureTitle: string,
    entry: BotLearningEntry,
    change: Parameters<typeof botLearningRevisionInput>[2],
  ) => {
    const input = detail.data ? botLearningRevisionInput(detail.data, entry, change) : null;
    if (input === null) return;
    const revised = await run(failureTitle, () => record({ environmentId, input }));
    if (revised) setEditing(null);
  };
  const settleSuggestion = (
    failureTitle: string,
    { suggestion }: (typeof views)[number],
    decision: "accept" | "dismiss" | "undismiss",
  ) => {
    if (suggestion === undefined) return;
    const { pair } = suggestion;
    void run(failureTitle, () =>
      decideSuggestion({ environmentId, input: { botId, ...pair, decision } }),
    );
  };

  if (projectId === null && views.length === 0 && focus === undefined) return null;
  return (
    <SettingsSection
      title={title}
      footer={
        focus !== undefined
          ? undefined
          : projectId === null
            ? "Applies in every project this Bot serves."
            : "Your instructions apply right away. Lessons from your corrections follow the Learning setting."
      }
    >
      {turn === null ? null : (
        <View className="gap-1 px-4 py-3">
          <Text textRole="footnote" className="text-foreground">
            {turn.summary}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            {BOT_TURN_LEARNING_EXPLANATION}
          </Text>
          {turn.shared.length === 0 ? null : (
            <Text textRole="footnote" className="pt-1 text-foreground">
              For all projects
            </Text>
          )}
          {turn.shared.map(({ text, entry, marker }) => (
            <Text key={entry.id} textRole="body" className="text-foreground-muted">
              {text} · {marker}
            </Text>
          ))}
        </View>
      )}
      {views.length === 0 && turn === null ? (
        <Text className="p-4 text-base text-foreground-muted">
          {focus === undefined
            ? "Nothing learned yet."
            : detail.data
              ? "This lesson no longer exists. It was removed with its project."
              : (detail.error ?? "Loading lesson…")}
        </Text>
      ) : null}
      {views.map((view, index) => {
        const shown = view.current ?? view.latest;
        const entryId = view.entry.id;
        const marker = turn?.markerOf(view.entry) ?? null;
        const confirmed = botLearningConfirmedLabel(shown);
        return (
          <View
            key={entryId}
            className={
              index === 0 && turn === null
                ? "gap-1 px-4 py-3"
                : "gap-1 border-t border-border-subtle px-4 py-3"
            }
          >
            <Text textRole="footnote" className="text-foreground-muted">
              {BOT_LEARNING_KIND_LABELS[view.entry.kind]} ·{" "}
              {BOT_LEARNING_STATUS_LABELS[view.current ? "active" : view.latest.status]} ·{" "}
              {botLearningOriginLabel(shown)}
              {marker === null ? "" : ` · ${marker}`}
              {confirmed === null ? "" : ` · ${confirmed}`}
            </Text>
            <Text
              textRole="body"
              className={view.current ? "text-foreground" : "text-foreground-muted"}
            >
              {shown.text}
            </Text>
            {view.pending.map((revision) => (
              <View key={revision.revision} className={`gap-1 pt-2 ${marked(revision.revision)}`}>
                <Text textRole="footnote" className="text-foreground-muted">
                  {[
                    view.current ? "Proposed change" : "Proposed",
                    botLearningScopeChange(view.entry, revision),
                    revision.conflictsWithInstruction ? "conflicts with your instruction" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
                {revision === shown ? null : (
                  <Text textRole="body" className="text-foreground">
                    {revision.text}
                  </Text>
                )}
                {revision.evidence === "" ? null : (
                  <Text textRole="footnote" className="text-foreground-muted">
                    “{revision.evidence}”
                  </Text>
                )}
                <View className="flex-row gap-5 pt-1">
                  {(["adopt", "reject"] as const).map((decision) => (
                    <ActionText
                      key={decision}
                      label={decision === "adopt" ? "Adopt" : "Reject"}
                      tone={decision === "adopt" ? "primary" : "muted"}
                      disabled={locked}
                      onPress={() =>
                        void run("Could not update the proposal", () =>
                          decide({
                            environmentId,
                            input: { botId, entryId, revision: revision.revision, decision },
                          }),
                        )
                      }
                    />
                  ))}
                </View>
              </View>
            ))}
            {view.current && editing?.entryId === entryId ? (
              <View className="gap-2 pt-1">
                <FormField
                  label="Edit lesson"
                  value={editing.text}
                  multiline
                  maxLength={1_000}
                  disabled={locked}
                  onChange={(next) => setEditing({ entryId, text: next })}
                />
                <View className="flex-row gap-5">
                  <ActionText
                    label="Save"
                    disabled={
                      locked ||
                      editing.text.trim() === "" ||
                      editing.text.trim() === view.current.text
                    }
                    onPress={() =>
                      void revise("Could not save the change", view.entry, { text: editing.text })
                    }
                  />
                  <ActionText
                    label="Cancel"
                    tone="muted"
                    disabled={busy}
                    onPress={() => setEditing(null)}
                  />
                </View>
              </View>
            ) : view.current ? (
              <View className="flex-row flex-wrap gap-5 pt-1">
                <ActionText
                  label="Edit"
                  tone="muted"
                  disabled={locked}
                  onPress={() => setEditing({ entryId, text: view.current?.text ?? "" })}
                />
                {/* An open suggestion offers the same move below, with the other copy. */}
                {view.entry.projectId === null || view.suggestion?.dismissed === false ? null : (
                  <ActionText
                    label="Apply to all projects"
                    tone="muted"
                    disabled={locked}
                    onPress={() =>
                      void revise("Could not apply it to all projects", view.entry, {
                        scope: "bot",
                      })
                    }
                  />
                )}
                <ActionText
                  label="Retire"
                  tone="muted"
                  disabled={locked}
                  onPress={() =>
                    void run("Could not retire the entry", () =>
                      retire({ environmentId, input: { botId, entryId } }),
                    )
                  }
                />
              </View>
            ) : null}
            {view.suggestion === undefined ? null : view.suggestion.dismissed ? (
              <View className="flex-row flex-wrap items-center gap-x-3 pt-2">
                <Text textRole="footnote" className="text-foreground-muted">
                  You dismissed the suggestion to apply this to all projects.
                </Text>
                <ActionText
                  label="Show again"
                  tone="muted"
                  disabled={locked}
                  onPress={() =>
                    settleSuggestion("Could not show the suggestion", view, "undismiss")
                  }
                />
              </View>
            ) : (
              <View className="gap-1 pt-2">
                <Text textRole="footnote" className="text-foreground">
                  {`${BOT_LEARNING_SUGGESTION_LABEL} · also learned in ${titleOf(view.suggestion.projectId)}`}
                </Text>
                {view.suggestion.text === null ? null : (
                  <Text textRole="body" className="text-foreground">
                    {view.suggestion.text}
                  </Text>
                )}
                <Text textRole="footnote" className="text-foreground-muted">
                  {`Applying it retires the copy in ${titleOf(view.suggestion.projectId)}.`}
                </Text>
                <View className="flex-row gap-5 pt-1">
                  <ActionText
                    label="Apply to all projects"
                    disabled={locked}
                    onPress={() =>
                      settleSuggestion("Could not apply it to all projects", view, "accept")
                    }
                  />
                  <ActionText
                    label="Dismiss"
                    tone="muted"
                    disabled={locked}
                    onPress={() =>
                      settleSuggestion("Could not dismiss the suggestion", view, "dismiss")
                    }
                  />
                </View>
              </View>
            )}
            {view.restorable.map((revision) => (
              <View
                key={revision.revision}
                className={`flex-row items-start gap-3 pt-2 ${marked(revision.revision)}`}
              >
                <Text textRole="footnote" className="min-w-0 flex-1 text-foreground-muted">
                  {[
                    `r${revision.revision}`,
                    BOT_LEARNING_STATUS_LABELS[revision.status],
                    botLearningScopeChange(view.entry, revision),
                  ]
                    .filter(Boolean)
                    .join(" · ")}{" "}
                  · {revision.text}
                </Text>
                <ActionText
                  label="Restore"
                  disabled={locked}
                  onPress={() =>
                    void run("Could not restore the revision", () =>
                      restore({
                        environmentId,
                        input: { botId, entryId, revision: revision.revision },
                      }),
                    )
                  }
                />
              </View>
            ))}
          </View>
        );
      })}
      {projectId === null || focus !== undefined ? null : (
        <>
          <FormField
            label="New instruction"
            value={text}
            placeholder="Give dates in Dale Reckoning"
            multiline
            maxLength={1_000}
            borderTop
            disabled={locked}
            onChange={setText}
          />
          <Pressable
            accessibilityRole="button"
            disabled={locked || text.trim() === ""}
            onPress={async () => {
              const added = await run("Could not add the instruction", () =>
                record({
                  environmentId,
                  input: { botId, projectId, kind: "preference", text: text.trim() },
                }),
              );
              if (added) setText("");
            }}
            className="min-h-14 flex-row items-center border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
          >
            <Text textRole="body" className="text-primary-text">
              Add instruction
            </Text>
          </Pressable>
        </>
      )}
    </SettingsSection>
  );
}
