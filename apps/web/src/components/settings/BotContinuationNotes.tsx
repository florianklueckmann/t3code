import { useAtomValue } from "@effect/atom-react";
import {
  botContinuationDraft,
  botContinuationRefCaption,
  botContinuationWriterLabel,
  parseBotContinuationDraft,
  type BotContinuationDraft,
} from "@t3tools/client-runtime/bots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOT_CONTINUATION_LIMITS,
  BOT_CONTINUATION_SECTIONS,
  type BotContinuationNote,
  type BotContinuationNoteInput,
  type BotContinuationRevision,
  type BotContinuationView,
  type BotId,
  type BotSaveContinuationInput,
  type BotSaveContinuationResult,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon, PencilIcon } from "lucide-react";
import { useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { BotTaskStatusBadge } from "../chat/BotTaskStatusBadge";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ScheduledRelativeLabel } from "./ScheduledTasksSettings";

type Section = (typeof BOT_CONTINUATION_SECTIONS)[number];

const SECTION_LABELS: Record<Section, string> = {
  requests: "Open requests",
  waiting: "Waiting on you",
  decided: "Decided",
  context: "Context",
};

const SECTION_PLACEHOLDERS: Record<Section, string> = {
  requests: "One request per line",
  waiting: "Questions for you, and proposals written as “Proposed: …”",
  decided: "Choices you made",
  context: "Facts and pointers needed to resume",
};

type Conflict = Extract<BotSaveContinuationResult, { _tag: "conflict" }>;

interface Editing {
  /** The view the draft started from; its revision is the save base until a conflict. */
  readonly base: BotContinuationView;
  readonly draft: BotContinuationDraft;
  readonly conflict: Conflict | null;
}

function toastError(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

function noteInput(note: BotContinuationNote): BotContinuationNoteInput {
  return {
    requests: note.requests.map(({ text }) => ({ text })),
    waiting: note.waiting.map(({ text }) => ({ text })),
    decided: note.decided.map(({ text }) => ({ text })),
    context: note.context.map(({ text }) => ({ text })),
  };
}

function sameNote(input: BotContinuationNoteInput, note: BotContinuationNote): boolean {
  return BOT_CONTINUATION_SECTIONS.every(
    (section) =>
      input[section].length === note[section].length &&
      input[section].every((item, index) => item.text === note[section][index]?.text),
  );
}

function isEmptyNote(note: BotContinuationNote): boolean {
  return BOT_CONTINUATION_SECTIONS.every((section) => note[section].length === 0);
}

/** Null until the draft nears a limit. */
function limitHint(draft: BotContinuationDraft): { text: string; over: boolean } | null {
  const lines = BOT_CONTINUATION_SECTIONS.flatMap((section) =>
    draft[section]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const chars = lines.reduce((sum, line) => sum + line.length, 0);
  const longLine = lines.some((line) => line.length > BOT_CONTINUATION_LIMITS.itemChars);
  const parts = [
    lines.length > BOT_CONTINUATION_LIMITS.items - 4
      ? `${lines.length} of ${BOT_CONTINUATION_LIMITS.items} lines.`
      : null,
    chars > BOT_CONTINUATION_LIMITS.textChars * 0.9
      ? `${chars} of ${BOT_CONTINUATION_LIMITS.textChars} characters.`
      : null,
    longLine ? `Keep each line to ${BOT_CONTINUATION_LIMITS.itemChars} characters.` : null,
  ].filter((part) => part !== null);
  if (parts.length === 0) return null;
  return {
    text: parts.join(" "),
    over:
      longLine ||
      lines.length > BOT_CONTINUATION_LIMITS.items ||
      chars > BOT_CONTINUATION_LIMITS.textChars,
  };
}

function conflictMessage(conflict: Conflict): string {
  switch (conflict.reason) {
    case "revision":
      return conflict.current.updatedBy?.kind === "bot"
        ? "The Bot changed these notes while you were editing."
        : "These notes were changed elsewhere while you were editing.";
    case "basis":
      return "The conversation moved on before this save.";
    case "update_id":
      return "This save didn't match your earlier attempt.";
  }
}

function messagesSinceLabel(count: number): string {
  return `${count} ${count === 1 ? "message" : "messages"} since these notes were saved.`;
}

/**
 * A transport retry of the same save keeps its update id, so a lost response can't add a
 * second revision. Any different payload, including a new base, gets a new id.
 */
function useSaveContinuation(environmentId: EnvironmentId) {
  const save = useAtomCommand(serverEnvironment.saveBotContinuation, {
    label: "bot working notes save",
  });
  const pending = useRef<{ readonly key: string; readonly updateId: string } | null>(null);
  return async (input: Omit<BotSaveContinuationInput, "updateId">) => {
    const key = JSON.stringify(input);
    const updateId = pending.current?.key === key ? pending.current.updateId : randomUUID();
    pending.current = { key, updateId };
    const result = await save({ environmentId, input: { ...input, updateId } });
    if (result._tag === "Success") pending.current = null;
    return result;
  };
}

function RevisionMeta({
  updatedBy,
  updatedAt,
  restoredFrom,
}: Pick<BotContinuationRevision, "updatedBy" | "updatedAt" | "restoredFrom">) {
  return (
    <>
      {botContinuationWriterLabel(updatedBy)} · <ScheduledRelativeLabel value={updatedAt} />
      {restoredFrom === null ? null : ` · restored from r${restoredFrom}`}
    </>
  );
}

function NoteSections({ note, captions }: { note: BotContinuationNote; captions: boolean }) {
  return (
    <>
      {BOT_CONTINUATION_SECTIONS.map((section) =>
        note[section].length === 0 ? null : (
          <div key={section} className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{SECTION_LABELS[section]}</p>
            <ul className="space-y-1.5">
              {note[section].map((item) => (
                <li key={item.text} className="space-y-0.5">
                  <p className="text-sm wrap-anywhere">{item.text}</p>
                  {captions
                    ? item.refs.map((ref) => (
                        <p
                          key={JSON.stringify(ref)}
                          className="text-xs text-muted-foreground wrap-anywhere"
                        >
                          {botContinuationRefCaption(ref)}
                        </p>
                      ))
                    : null}
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
    </>
  );
}

/** A Bot's working notes in one attached project. They save apart from the Bot form. */
export function BotContinuationNotes({
  environmentId,
  botId,
  projectId,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly projectId: ProjectId;
  readonly disabled: boolean;
}) {
  const navigate = useNavigate();
  const scope = { botId, projectId };
  const query = useEnvironmentQuery(
    serverEnvironment.botContinuation({ environmentId, input: scope }),
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = useEnvironmentQuery(
    historyOpen ? serverEnvironment.botContinuationHistory({ environmentId, input: scope }) : null,
  );
  const canSave = useAtomValue(serverEnvironment.saveBotContinuation.permissionAtom(environmentId));
  const save = useSaveContinuation(environmentId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const view = query.data;
  const canWrite = view !== null && view.writable && canSave && !disabled && !busy;

  const refresh = () => {
    query.refresh();
    if (historyOpen) history.refresh();
  };
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });

  const parsed = editing === null ? null : parseBotContinuationDraft(editing.draft);
  const hint = editing === null ? null : limitHint(editing.draft);
  const unchanged =
    editing !== null &&
    editing.conflict === null &&
    parsed !== null &&
    "note" in parsed &&
    sameNote(parsed.note, editing.base.note);

  const submit = async (baseRevision: number | null) => {
    if (parsed === null || "error" in parsed) return;
    setBusy(true);
    const result = await save({ ...scope, baseRevision, note: parsed.note });
    setBusy(false);
    if (result._tag === "Failure") {
      toastError("Could not save working notes", result);
      return;
    }
    const outcome = result.value;
    if (outcome._tag === "conflict") {
      setEditing((current) => (current === null ? null : { ...current, conflict: outcome }));
    } else {
      setEditing(null);
    }
    refresh();
  };

  const restore = async (revision: BotContinuationRevision) => {
    if (view === null) return;
    setBusy(true);
    const result = await save({
      ...scope,
      baseRevision: view.revision,
      note: noteInput(revision.note),
      restoredFrom: revision.revision,
    });
    setBusy(false);
    if (result._tag === "Failure") {
      toastError("Could not restore the revision", result);
    } else if (result.value._tag === "conflict") {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "These notes changed before the restore",
          description: "Check the current notes, then restore again if you still want to.",
        }),
      );
    }
    refresh();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Label>Working notes</Label>
        {view !== null && editing === null ? (
          <Button
            className="shrink-0"
            size="xs"
            variant="outline"
            disabled={!canWrite}
            onClick={() =>
              setEditing({ base: view, draft: botContinuationDraft(view.note), conflict: null })
            }
          >
            <PencilIcon aria-hidden />
            Edit
          </Button>
        ) : null}
      </div>
      {query.error === null ? null : <p className="text-xs text-destructive">{query.error}</p>}
      {editing !== null ? (
        <div className="space-y-3">
          {editing.conflict === null ? null : (
            <div className="space-y-2 rounded-md border p-2" role="alert">
              <p className="text-sm">
                {conflictMessage(editing.conflict)} Your draft is kept below.
              </p>
              {isEmptyNote(editing.conflict.current.note) ? (
                <p className="text-xs text-muted-foreground">The current notes are empty.</p>
              ) : (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    Show current notes
                  </summary>
                  <div className="mt-2 space-y-2">
                    <NoteSections note={editing.conflict.current.note} captions={false} />
                  </div>
                </details>
              )}
            </div>
          )}
          {BOT_CONTINUATION_SECTIONS.map((section) => {
            const id = `bot-note-${projectId}-${section}`;
            return (
              <div key={section} className="space-y-1.5">
                <Label htmlFor={id}>{SECTION_LABELS[section]}</Label>
                <Textarea
                  id={id}
                  className="max-h-48 overflow-y-auto"
                  placeholder={SECTION_PLACEHOLDERS[section]}
                  value={editing.draft[section]}
                  disabled={busy}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      draft: { ...editing.draft, [section]: event.target.value },
                    })
                  }
                />
              </div>
            );
          })}
          {hint !== null ? (
            <p className={hint.over ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {hint.text}
            </p>
          ) : parsed !== null && "error" in parsed ? (
            <p className="text-xs text-destructive">{parsed.error}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {editing.conflict === null ? (
              <>
                <Button
                  size="xs"
                  disabled={!canWrite || unchanged || parsed === null || "error" in parsed}
                  onClick={() => void submit(editing.base.revision)}
                >
                  Save
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="xs"
                  disabled={!canWrite || parsed === null || "error" in parsed}
                  onClick={() => void submit(editing.conflict?.current.revision ?? null)}
                >
                  Save mine
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setEditing(null);
                    refresh();
                  }}
                >
                  Discard mine
                </Button>
              </>
            )}
          </div>
        </div>
      ) : view === null ? (
        query.error === null ? (
          <p className="text-xs text-muted-foreground" role="status">
            Loading working notes…
          </p>
        ) : null
      ) : (
        <div className="space-y-3">
          {view.updatedBy === null || view.updatedAt === null ? null : (
            <p className="text-xs text-muted-foreground">
              <RevisionMeta
                updatedBy={view.updatedBy}
                updatedAt={view.updatedAt}
                restoredFrom={view.restoredFrom}
              />
            </p>
          )}
          {view.revision !== null && view.newerInputs.count > 0 ? (
            <p className="text-xs text-muted-foreground">
              {messagesSinceLabel(view.newerInputs.count)}
            </p>
          ) : null}
          {isEmptyNote(view.note) ? (
            <p className="text-sm text-muted-foreground">Nothing open.</p>
          ) : (
            <NoteSections note={view.note} captions />
          )}
          {view.sources.length === 0 && view.moreSources === 0 ? null : (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Sources ({view.sources.length + view.moreSources})
              </summary>
              <ul className="mt-1 space-y-1.5">
                {view.sources.map((source) => (
                  <li key={source.messageId} className="wrap-anywhere whitespace-pre-wrap">
                    <span className="text-muted-foreground">
                      {source.directUser ? "You" : "Home input"}:{" "}
                    </span>
                    {source.text}
                  </li>
                ))}
              </ul>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {view.moreSources === 0 ? null : (
                  <span className="text-muted-foreground">
                    {view.moreSources} more in the conversation.
                  </span>
                )}
                <Button
                  size="xs"
                  variant="ghost-muted"
                  onClick={() => openThread(view.homeThreadId)}
                >
                  <MessageSquareIcon aria-hidden />
                  Open conversation
                </Button>
              </div>
            </details>
          )}
        </div>
      )}
      {view === null || view.activeTasks.length === 0 ? null : (
        <div className="space-y-2">
          <Label>Active work</Label>
          <ul className="space-y-2 text-xs">
            {view.activeTasks.map((task) => (
              <li key={task.taskId} className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-2">
                  <span className="font-medium wrap-anywhere">{task.title}</span>
                  <BotTaskStatusBadge status={task.status} />
                </span>
                {task.workThreadId === null ? null : (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    aria-label={`Open thread for ${task.title}`}
                    onClick={() => task.workThreadId !== null && openThread(task.workThreadId)}
                  >
                    <MessageSquareIcon aria-hidden />
                    Open thread
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {view.moreActiveTasks === 0 ? null : (
            <p className="text-xs text-muted-foreground">
              {view.moreActiveTasks} more active {view.moreActiveTasks === 1 ? "task" : "tasks"}.
            </p>
          )}
        </div>
      )}
      {view === null ? null : (
        <details className="text-xs" onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-muted-foreground">History</summary>
          {history.error !== null ? (
            <p className="mt-1 text-destructive">{history.error}</p>
          ) : history.data === null ? (
            <p className="mt-1 text-muted-foreground" role="status">
              Loading history…
            </p>
          ) : history.data.revisions.length === 0 ? (
            <p className="mt-1 text-muted-foreground">No saved revisions yet.</p>
          ) : (
            <ul className="mt-1 space-y-2">
              {history.data.revisions.map((revision) => (
                <li key={revision.revision} className="space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 text-muted-foreground">
                      r{revision.revision} · <RevisionMeta {...revision} />
                    </span>
                    {revision.revision === view.revision ? (
                      <Badge variant="outline">Current</Badge>
                    ) : (
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={!canWrite || editing !== null}
                        onClick={() => void restore(revision)}
                      >
                        Restore
                      </Button>
                    )}
                  </div>
                  {isEmptyNote(revision.note) ? (
                    <p className="text-muted-foreground">Empty.</p>
                  ) : (
                    <details>
                      <summary className="cursor-pointer text-muted-foreground">Show notes</summary>
                      <div className="mt-1 space-y-2">
                        <NoteSections note={revision.note} captions={false} />
                      </div>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </div>
  );
}
