import type { ContinuationCase } from "./cases.ts";

export interface ObservedNote {
  readonly revision: number | null;
  readonly note: Readonly<
    Record<
      "requests" | "waiting" | "decided" | "context",
      readonly { readonly text: string; readonly refs: readonly { readonly kind: string }[] }[]
    >
  >;
  readonly updatedBy: {
    readonly kind: string;
    readonly threadId?: string | undefined;
    readonly runId?: string | undefined;
  } | null;
  readonly newerInputs: { readonly count: number };
}
export interface Observation {
  readonly supported: boolean;
  readonly capture: ObservedNote | null;
  readonly resumed: ObservedNote | null;
  readonly answer: string;
  readonly calls: readonly {
    readonly action: string;
    readonly botId?: string | undefined;
    readonly projectId?: string | undefined;
  }[];
  readonly botId: string;
  readonly projectId: string;
  readonly homeThreadId: string;
  readonly errors: readonly string[];
  readonly settled: boolean;
  readonly unchangedSettings: boolean;
  readonly tasks: number;
  readonly routines: number;
}
export const gradeSample = (testCase: ContinuationCase, run: Observation) => {
  const checks: { check: string; pass: boolean }[] = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  const control = testCase.id === "ordinary-answer-control";
  add("continuation capability/capture available", run.supported);
  add("turns settled within bounded waits", run.settled);
  add("no invented tasks or routines", run.tasks === 0 && run.routines === 0);
  add("sources, instructions and learning unchanged", run.unchangedSettings);
  const saves = run.calls.filter((call) => call.action === "save_continuation");
  add(
    control ? "no unnecessary save" : "real scoped save tool activity",
    control
      ? saves.length === 0
      : saves.length > 0 &&
          saves.every((call) => call.botId === run.botId && call.projectId === run.projectId),
  );
  add(
    "no authority/settings mutation tools",
    run.calls.every(
      (call) =>
        ![
          "create",
          "update",
          "start_task",
          "learn",
          "adopt",
          "reinstate",
          "schedule_task",
        ].includes(call.action),
    ),
  );
  if (control) {
    add(
      "no invented unfinished note",
      run.capture?.revision === null && run.resumed?.revision === null,
    );
  } else {
    add(
      "persisted Home writer provenance",
      run.capture?.updatedBy?.kind === "bot" &&
        run.capture.updatedBy.threadId === run.homeThreadId &&
        typeof run.capture.updatedBy.runId === "string",
    );
    add(
      "persisted source references",
      run.capture !== null &&
        run.capture.note.requests.some((item) => item.refs.some((ref) => ref.kind === "message")),
    );
    add(
      "captured request survives resume",
      [run.capture, run.resumed].every(
        (view) =>
          view !== null &&
          view.note.requests.some((item) => new RegExp(testCase.request!, "i").test(item.text)),
      ),
    );
    if (testCase.waiting !== null)
      add(
        "proposal or unresolved decision stays waiting",
        [run.capture, run.resumed].every(
          (view) =>
            view !== null &&
            view.note.waiting.some((item) => new RegExp(testCase.waiting!, "i").test(item.text)),
        ),
      );
    add(
      "no unapproved Bot decision",
      [run.capture, run.resumed].every((view) => view !== null && view.note.decided.length === 0),
    );
    if (testCase.absent !== null)
      add(
        "resolved request and proposal removed from note",
        [run.capture, run.resumed].every(
          (view) =>
            view !== null &&
            Object.values(view.note)
              .flat()
              .every((item) => !new RegExp(testCase.absent!, "i").test(item.text)),
        ),
      );
  }
  for (const pattern of testCase.answer)
    add(`answer /${pattern}/i`, new RegExp(pattern, "i").test(run.answer));
  return checks;
};
