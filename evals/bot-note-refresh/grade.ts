import { NOTE_SECTIONS, type ObservedNote } from "../shared/botHome.ts";
import type { NoteRefreshCase } from "./cases.ts";

export interface Observation {
  /** Each note refresh attempt of the night, in order: its outcome and reason. */
  readonly attempts: readonly string[];
  /** Whether the saved note's coverage reached the case's last Home input. */
  readonly covered: boolean;
  readonly before: ObservedNote;
  readonly after: ObservedNote;
  /** The first refresh run's own reply. */
  readonly reply: string;
  /** Every tool call the refresh runs made, as `tool action`. */
  readonly tools: readonly string[];
  readonly largeInputId: string | null;
  readonly tasksBefore: number;
  readonly tasksAfter: number;
  readonly unchangedFiles: boolean;
  /** Preconditions the case needs that did not hold; any one fails the sample. */
  readonly setup: readonly string[];
}

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail?: string;
}

const encode = (value: unknown) => JSON.stringify(value);
const texts = (note: ObservedNote) => NOTE_SECTIONS.flatMap((section) => note[section]);
const holds = (note: ObservedNote, pattern: string) =>
  texts(note).some((item) => new RegExp(pattern, "i").test(item.text));
const NOTE_TOOL = /^t3-code\.t3_bot (read|save)_continuation$/;

export function gradeSample(testCase: NoteRefreshCase, run: Observation): readonly Check[] {
  const checks: Check[] = [
    { name: "setup held", pass: run.setup.length === 0, detail: run.setup.join("; ") },
    {
      name: "refreshed",
      pass: run.attempts[0] === "refreshed",
      detail: run.attempts.join(", ") || "no attempt",
    },
    { name: "covered every shown input", pass: run.covered },
    {
      name: "only read and saved the note",
      pass: run.tools.every((tool) => NOTE_TOOL.test(tool)),
      detail: encode(run.tools.filter((tool) => !NOTE_TOOL.test(tool))),
    },
    { name: "no task started", pass: run.tasksAfter === run.tasksBefore },
    { name: "project files unchanged", pass: run.unchangedFiles },
    {
      name: "one-line reply",
      pass: run.reply.trim().length > 0 && !run.reply.trim().includes("\n"),
      detail: run.reply,
    },
    {
      name: "kept existing items",
      pass: NOTE_SECTIONS.every((section) =>
        run.before[section].every((item) =>
          run.after[section].some((kept) => kept.text === item.text),
        ),
      ),
      detail: encode(
        NOTE_SECTIONS.flatMap((section) =>
          run.before[section]
            .filter((item) => !run.after[section].some((kept) => kept.text === item.text))
            .map((item) => `${section}: ${item.text}`),
        ),
      ),
    },
  ];
  if (testCase.unchanged)
    checks.push({
      name: "note unchanged",
      pass: NOTE_SECTIONS.every(
        (section) =>
          encode(run.after[section].map((item) => item.text)) ===
          encode(run.before[section].map((item) => item.text)),
      ),
      detail: encode(texts(run.after).map((item) => item.text)),
    });
  for (const expected of testCase.gains)
    checks.push({
      name: expected.name,
      pass: holds(run.after, expected.pattern),
      detail: encode(texts(run.after).map((item) => item.text)),
    });
  for (const expected of testCase.never)
    checks.push({
      name: expected.name,
      pass: !holds(run.after, expected.pattern),
      detail: encode(texts(run.after).map((item) => item.text)),
    });
  if (testCase.largeInput !== null)
    checks.push({
      name: "keeps the large input in Waiting",
      pass:
        run.largeInputId !== null &&
        run.after.waiting.some((item) =>
          item.refs.some((ref) => ref.kind === "message" && ref.messageId === run.largeInputId),
        ),
      detail: encode(run.after.waiting),
    });
  return checks;
}

/** A case fails when half or more of its samples fail. */
export const casePasses = (passes: readonly boolean[]) =>
  passes.filter(Boolean).length * 2 > passes.length;
