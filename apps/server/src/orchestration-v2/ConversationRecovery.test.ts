import {
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  conversationRecoveryHandoffItems,
  freshConversationPlan,
  previousConversationSummary,
  rewindKeptProviderTurn,
} from "./ConversationRecovery.ts";

const now = DateTime.makeUnsafe("2026-11-11T12:00:00Z");
const codex = ProviderThreadId.make("codex-thread");
const claude = ProviderThreadId.make("claude-thread");

describe("rewindKeptProviderTurn", () => {
  const runs: Array<Pick<OrchestrationV2Run, "id" | "ordinal" | "status">> = [
    { id: RunId.make("run-148"), ordinal: 148, status: "completed" },
    { id: RunId.make("run-149"), ordinal: 149, status: "completed" },
    { id: RunId.make("run-149b"), ordinal: 149, status: "rolled_back" },
    { id: RunId.make("run-150"), ordinal: 150, status: "completed" },
    { id: RunId.make("run-151"), ordinal: 151, status: "failed" },
  ];
  const attempts = runs.map((run) => ({
    id: RunAttemptId.make(`attempt-${run.id}`),
    runId: run.id,
  }));
  const turn = (
    runId: string,
    ordinal: number,
    providerThreadId = codex,
  ): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make(`turn-${runId}-${providerThreadId}`),
    providerThreadId,
    nodeId: NodeId.make("node"),
    runAttemptId: RunAttemptId.make(`attempt-${runId}`),
    nativeTurnRef: {
      driver: ProviderDriverKind.make("codex"),
      nativeId: `native-${ordinal}`,
      strength: "strong",
    },
    ordinal,
    status: "completed",
    startedAt: now,
    completedAt: now,
  });
  const providerTurns = [
    turn("run-148", 183),
    turn("run-149", 184),
    turn("run-149b", 185),
    turn("run-150", 186),
    turn("run-151", 187),
    turn("run-150", 9, claude),
  ];

  it("keeps the newest turn of the provider thread before the last accepted run", () => {
    expect(
      rewindKeptProviderTurn({ runs, attempts, providerTurns }, codex, { ordinal: 150 })?.id,
    ).toBe("turn-run-149-codex-thread");
  });

  it("keeps nothing when no run was accepted", () => {
    expect(
      rewindKeptProviderTurn({ runs, attempts, providerTurns }, codex, undefined),
    ).toBeUndefined();
  });
});

describe("conversationRecoveryHandoffItems", () => {
  let ordinal = 0;
  const item = <Item extends Partial<OrchestrationV2TurnItem>>(runId: string, fields: Item) =>
    ({
      id: TurnItemId.make(`item-${++ordinal}`),
      threadId: ThreadId.make("thread"),
      runId: RunId.make(runId),
      nodeId: null,
      providerThreadId: codex,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      ...fields,
    }) as OrchestrationV2TurnItem;
  const user = (runId: string, text: string) =>
    item(runId, { type: "user_message", text, attachments: [] } as never);
  const assistant = (runId: string, text: string) =>
    item(runId, { type: "assistant_message", text } as never);

  it("hands over user messages and each run's final reply, without tool calls or output", () => {
    const items = [
      user("run-150", "Start the external controller."),
      assistant("run-150", "Checking readiness first."),
      item("run-150", {
        type: "command_execution",
        input: "kill -TERM 4242",
        output: "terminated",
        exitCode: 0,
      } as never),
      item("run-150", {
        type: "file_change",
        changes: [{ operation: "update", path: "binding.json" }],
      } as never),
      assistant("run-150", "The controller stopped before any Quit."),
      user("run-152", "What was blocked?"),
      item("run-152", {
        type: "assistant_message",
        text: "Running the activation check.",
        responseKind: "intermediate",
      } as never),
      item("run-152", {
        type: "error",
        status: "failed",
        failure: { class: "provider_error", message: "Blocked", code: null, retryable: null },
      } as never),
      user("run-156", "/compact"),
    ];

    expect(
      conversationRecoveryHandoffItems(items).map((kept) =>
        kept.type === "user_message" || kept.type === "assistant_message"
          ? `${kept.type}: ${kept.text}`
          : kept.type,
      ),
    ).toEqual([
      "user_message: Start the external controller.",
      "assistant_message: The controller stopped before any Quit.",
      "user_message: What was blocked?",
    ]);
  });
});

describe("freshConversationPlan", () => {
  // Ten runs of a 3 KB request and a short reply. The 20k verbatim tail keeps every reply, the
  // first request and the newest five, so runs 2-5 are split across the cut.
  const messages = Array.from({ length: 10 }, (_, index) =>
    (["user", "assistant"] as const).map((role) => ({
      role,
      text: role === "user" ? `Request ${index + 1}: ${"x".repeat(3_000)}` : `Done ${index + 1}.`,
      runOrdinal: index + 1,
      threadId: ThreadId.make("thread"),
      runId: RunId.make(`run-${index + 1}`),
      itemId: TurnItemId.make(`item-${index + 1}-${role}`),
      providerThreadId: codex,
      status: "completed",
      kind: `${role}_message`,
    })),
  ).flat();
  const plan = (previousSummary?: { text: string; throughRunOrdinal: number }) =>
    freshConversationPlan({
      messages,
      coverage: "Provider context handoff.",
      tokenCap: 16_000,
      previousSummary,
    });
  const runsOf = (result: ReturnType<typeof plan>) => [
    ...new Set(
      result.type === "summarize" ? result.messages.map((message) => message.runOrdinal) : [],
    ),
  ];

  it("summarizes whole runs through the last one the verbatim tail leaves out", () => {
    const fresh = plan();
    expect(fresh).toMatchObject({ type: "summarize", previousSummary: undefined });
    // A reply the tail keeps is summarized with its request, so a later update never skips it.
    expect(fresh.type === "summarize" && fresh.messages).toHaveLength(10);
    expect(runsOf(fresh)).toEqual([1, 2, 3, 4, 5]);
    expect(fresh.type === "summarize" && fresh.throughRunOrdinal).toBe(5);
    expect(
      freshConversationPlan({
        messages: messages.slice(-3),
        coverage: "",
        tokenCap: 16_000,
        previousSummary: undefined,
      }),
    ).toEqual({ type: "verbatim" });
  });

  it("updates a previous summary with the newer omitted messages instead of rewriting it", () => {
    const updated = plan({ text: "PREVIOUS", throughRunOrdinal: 2 });
    expect(updated).toMatchObject({ type: "summarize", previousSummary: "PREVIOUS" });
    expect(runsOf(updated)).toEqual([3, 4, 5]);
    expect(updated.type === "summarize" && updated.throughRunOrdinal).toBe(5);
    expect(plan({ text: "PREVIOUS", throughRunOrdinal: 5 })).toEqual({
      type: "reuse",
      summary: { text: "PREVIOUS", throughRunOrdinal: 5 },
    });
  });

  it("ignores a previous summary whose last run a checkpoint restore rolled back", () => {
    const handoff = (throughRunOrdinal: number) =>
      ({
        history: { summary: { text: `through ${throughRunOrdinal}`, throughRunOrdinal } },
      }) as never;
    expect(
      previousConversationSummary(
        [handoff(4), handoff(9), handoff(6)],
        [
          { ordinal: 6, status: "completed" },
          { ordinal: 9, status: "rolled_back" },
        ],
      ),
    ).toEqual({ text: "through 6", throughRunOrdinal: 6 });
  });
});
