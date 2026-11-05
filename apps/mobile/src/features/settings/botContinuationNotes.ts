import type { BotContinuationDraft } from "@t3tools/client-runtime/bots";
import {
  BOT_CONTINUATION_LIMITS,
  BOT_CONTINUATION_SECTIONS,
  type BotContinuationNote,
  type BotContinuationNoteInput,
  type BotSaveContinuationInput,
  type BotSaveContinuationResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useRef } from "react";

import { uuidv4 } from "../../lib/uuid";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export type BotNoteSection = (typeof BOT_CONTINUATION_SECTIONS)[number];
export type BotNoteConflict = Extract<BotSaveContinuationResult, { _tag: "conflict" }>;

export const BOT_NOTE_SECTION_LABELS: Record<BotNoteSection, string> = {
  requests: "Open requests",
  waiting: "Waiting on you",
  decided: "Decided",
  context: "Context",
};

export const BOT_NOTE_SECTION_PLACEHOLDERS: Record<BotNoteSection, string> = {
  requests: "One request per line",
  waiting: "Questions for you, and proposals written as “Proposed: …”",
  decided: "Choices you made",
  context: "Facts and pointers needed to resume",
};

export function botNoteInput(note: BotContinuationNote): BotContinuationNoteInput {
  return {
    requests: note.requests.map(({ text }) => ({ text })),
    waiting: note.waiting.map(({ text }) => ({ text })),
    decided: note.decided.map(({ text }) => ({ text })),
    context: note.context.map(({ text }) => ({ text })),
  };
}

export function sameBotNote(input: BotContinuationNoteInput, note: BotContinuationNote): boolean {
  return BOT_CONTINUATION_SECTIONS.every(
    (section) =>
      input[section].length === note[section].length &&
      input[section].every((item, index) => item.text === note[section][index]?.text),
  );
}

export function isEmptyBotNote(note: BotContinuationNote): boolean {
  return BOT_CONTINUATION_SECTIONS.every((section) => note[section].length === 0);
}

/** Null until the draft nears a limit. */
export function botNoteLimitHint(
  draft: BotContinuationDraft,
): { readonly text: string; readonly over: boolean } | null {
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

export function botNoteConflictMessage(conflict: BotNoteConflict): string {
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

export function botNoteMessagesSince(count: number): string {
  return `${count} ${count === 1 ? "message" : "messages"} since these notes were saved.`;
}

/**
 * A transport retry of the same save keeps its update id, so a lost response can't add a
 * second revision. Any different payload, including a new base, gets a new id.
 */
export function useSaveBotNotes(environmentId: EnvironmentId) {
  const save = useAtomCommand(serverEnvironment.saveBotContinuation, { reportFailure: false });
  const pending = useRef<{ readonly key: string; readonly updateId: string } | null>(null);
  return async (input: Omit<BotSaveContinuationInput, "updateId">) => {
    const key = JSON.stringify(input);
    const updateId = pending.current?.key === key ? pending.current.updateId : uuidv4();
    pending.current = { key, updateId };
    const result = await save({ environmentId, input: { ...input, updateId } });
    if (result._tag === "Success") pending.current = null;
    return result;
  };
}
