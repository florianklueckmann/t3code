import type { HomeCheckCase } from "./cases.ts";

export interface ObservedRef {
  readonly kind: string;
  readonly taskId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly quote?: string | undefined;
}
export interface ObservedItem {
  readonly text: string;
  readonly refs: readonly ObservedRef[];
}
export type ObservedNote = Readonly<
  Record<"requests" | "waiting" | "decided" | "context", readonly ObservedItem[]>
>;

export interface Observation {
  /** The check's stored outcome, or null when it never finished. */
  readonly outcome: { readonly kind: string; readonly added?: number | undefined } | null;
  readonly before: ObservedNote;
  readonly after: ObservedNote;
  /** The check run's own reply. */
  readonly reply: string;
  readonly taskId: string | null;
  /** The user's own Home messages the eval sent. */
  readonly userMessageIds: readonly string[];
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
const matches = (pattern: string, text: string) => new RegExp(pattern, "i").test(text);

export function gradeSample(testCase: HomeCheckCase, run: Observation): readonly Check[] {
  const checks: Check[] = [
    { name: "setup held", pass: run.setup.length === 0, detail: run.setup.join("; ") },
    {
      name: "check finished",
      pass: run.outcome?.kind === "proposed" || run.outcome?.kind === "noop",
      detail: run.outcome?.kind ?? "no outcome",
    },
    { name: "no task started", pass: run.tasksAfter === run.tasksBefore },
    { name: "project files unchanged", pass: run.unchangedFiles },
    {
      name: "one-line reply",
      pass: run.reply.trim().length > 0 && !run.reply.trim().includes("\n"),
      detail: run.reply,
    },
    {
      name: "only Waiting grew",
      pass:
        (["requests", "decided", "context"] as const).every(
          (section) => encode(run.after[section]) === encode(run.before[section]),
        ) &&
        encode(run.after.waiting.slice(0, run.before.waiting.length)) ===
          encode(run.before.waiting),
    },
  ];
  const added = run.after.waiting.slice(run.before.waiting.length);
  const expected = testCase.expect;
  if (expected === null) {
    checks.push({
      name: "nothing saved",
      pass: added.length === 0 && run.outcome?.kind === "noop",
      detail: encode(added.map((item) => item.text)),
    });
    return checks;
  }
  const [item] = added;
  checks.push(
    {
      name: "one item added",
      pass: added.length === 1 && run.outcome?.kind === "proposed" && run.outcome.added === 1,
      detail: encode(added.map((entry) => entry.text)),
    },
    {
      name: "names what needs the user",
      pass: item !== undefined && matches(expected.pattern, item.text),
      detail: item?.text ?? "",
    },
    {
      name: expected.source === "task" ? "names the task" : "quotes the user",
      pass:
        item !== undefined &&
        item.refs.some((ref) =>
          expected.source === "task"
            ? ref.kind === "task" && ref.taskId === run.taskId
            : ref.kind === "message" &&
              ref.quote !== undefined &&
              run.userMessageIds.includes(ref.messageId ?? ""),
        ),
      detail: encode(item?.refs ?? []),
    },
  );
  return checks;
}
