import type { ContinuationCase } from "./cases.ts";

export interface ObservedRef {
  readonly kind: string;
  readonly messageId?: string | undefined;
  readonly quote?: string | undefined;
  readonly digest?: string | undefined;
}
export interface ObservedNote {
  readonly botId: string;
  readonly projectId: string;
  readonly homeThreadId: string;
  readonly revision: number | null;
  readonly note: Readonly<
    Record<
      "requests" | "waiting" | "decided" | "context",
      readonly { readonly text: string; readonly refs: readonly ObservedRef[] }[]
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
  readonly seed: ObservedNote | null;
  readonly captureRunId: string;
  readonly seedRunId: string | null;
  readonly directInputs: readonly {
    readonly messageId: string;
    readonly threadId: string;
    readonly text: string;
    readonly digest: string;
    readonly direct: boolean;
  }[];
  readonly unchangedFiles: boolean;
  readonly resumed: ObservedNote | null;
  readonly answer: string;
  readonly calls: readonly {
    readonly runId: string | null;
    readonly action: string;
    readonly botId?: string | undefined;
    readonly projectId?: string | undefined;
    readonly noteBudget?:
      | {
          readonly items: number;
          readonly totalTextUnits: number;
          readonly maxTextUnits: number;
          readonly maxQuoteUnits: number;
        }
      | undefined;
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
  if (!control) add("continuation capability/capture available", run.supported);
  add("project files unchanged", run.unchangedFiles);
  add("turns settled within bounded waits", run.settled);
  add("no invented tasks or routines", run.tasks === 0 && run.routines === 0);
  add("sources, instructions and learning unchanged", run.unchangedSettings);
  const saves = run.calls.filter((call) => call.action === "save_continuation");
  if (testCase.preflightBudget)
    add(
      "every submitted draft fits the unchanged UTF-16 budget",
      saves.length > 0 &&
        saves.every(
          (call) =>
            call.noteBudget !== undefined &&
            call.noteBudget.items <= 20 &&
            call.noteBudget.totalTextUnits <= 4000 &&
            call.noteBudget.maxTextUnits <= 400 &&
            call.noteBudget.maxQuoteUnits <= 400,
        ),
    );
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
      (run.capture === null || run.capture.revision === null) &&
        (run.resumed === null || run.resumed.revision === null),
    );
  } else {
    add(
      "persisted Home writer provenance",
      run.capture?.updatedBy?.kind === "bot" &&
        run.capture.updatedBy.threadId === run.homeThreadId &&
        run.capture.updatedBy.runId === run.captureRunId,
    );
    const validSources = (view: ObservedNote | null) =>
      view !== null &&
      view.botId === run.botId &&
      view.projectId === run.projectId &&
      view.homeThreadId === run.homeThreadId &&
      Object.values(view.note)
        .flat()
        .every(
          (item) =>
            item.refs.length > 0 &&
            item.refs.every(
              (ref) =>
                ref.kind === "message" &&
                run.directInputs.some(
                  (input) =>
                    input.direct &&
                    input.threadId === run.homeThreadId &&
                    input.messageId === ref.messageId &&
                    ref.digest === input.digest &&
                    typeof ref.quote === "string" &&
                    ref.quote.length > 0 &&
                    input.text.includes(ref.quote),
                ),
            ),
        );
    add(
      "persisted references match direct Home inputs",
      validSources(run.capture) && validSources(run.resumed),
    );
    add(
      "capture run performed scoped save",
      saves.some((call) => call.runId === run.captureRunId),
    );
    if (testCase.id === "correction-wins") {
      add(
        "seed really persisted Lantern and unapproved blue proposal",
        run.seed !== null &&
          run.seed.note.requests.some((item) => /Lantern/i.test(item.text)) &&
          run.seed.note.waiting.some(
            (item) =>
              /blue/i.test(item.text) &&
              /(propos|unapproved|not approved|pending|undecided)/i.test(item.text),
          ) &&
          run.seed.note.decided.length === 0,
      );
      add(
        "seed provenance and sources",
        validSources(run.seed) &&
          run.seed?.updatedBy?.kind === "bot" &&
          run.seed.updatedBy.threadId === run.homeThreadId &&
          run.seed.updatedBy.runId === run.seedRunId,
      );
      add(
        "seed run performed scoped save",
        run.seedRunId !== null && saves.some((call) => call.runId === run.seedRunId),
      );
    }
    add(
      "captured request survives resume",
      [run.capture, run.resumed].every(
        (view) =>
          view !== null &&
          view.note.requests.some((item) => new RegExp(testCase.request!, "i").test(item.text)),
      ),
    );
    for (const waiting of testCase.waiting)
      add(
        `waiting retains /${waiting}/i`,
        [run.capture, run.resumed].every(
          (view) =>
            view !== null &&
            view.note.waiting.some((item) => new RegExp(waiting, "i").test(item.text)),
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

const baselineActions = [
  "list",
  "read",
  "create",
  "update",
  "archive",
  "restore",
  "attach",
  "detach",
  "start_task",
  "list_tasks",
  "cancel_task",
  "learn",
  "adopt",
  "reject",
  "retire",
  "reinstate",
];
export const isMissingContinuationApi = (message: string) => {
  const normalized = message.replaceAll('\\"', '"').replaceAll("\\n", "\n");
  return (
    normalized.includes('"code":-32602') &&
    normalized.includes("Invalid parameters for tool 't3_bot': Expected ") &&
    normalized.includes(baselineActions.map((action) => JSON.stringify(action)).join(" | ")) &&
    /at\s*\["action"\]/.test(normalized)
  );
};
