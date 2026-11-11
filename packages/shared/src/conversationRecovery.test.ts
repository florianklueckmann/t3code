import {
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { conversationRecoveryOffer } from "./conversationRecovery.ts";

const now = DateTime.makeUnsafe("2026-11-11T12:00:00Z");
const codex = ProviderThreadId.make("codex-thread");
const claude = ProviderThreadId.make("claude-thread");

const run = (
  ordinal: number,
  status: OrchestrationV2Run["status"],
  providerThreadId = codex,
): Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "providerThreadId"> => ({
  id: RunId.make(`run-${ordinal}`),
  ordinal,
  status,
  providerThreadId,
});

const base = (ordinal: number, kind: string) => ({
  id: TurnItemId.make(`item-${ordinal}-${kind}`),
  threadId: ThreadId.make("thread"),
  runId: RunId.make(`run-${ordinal}`),
  nodeId: null,
  providerThreadId: codex,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: ordinal * 10,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});

const refusal = (ordinal: number): OrchestrationV2TurnItem => ({
  ...base(ordinal, "error"),
  status: "failed",
  type: "error",
  failure: {
    class: "provider_error",
    message: "This request was blocked by our safety systems.",
    code: "misalignmentPolicyViolation",
    retryable: null,
    safetyBlock: true,
  },
});

const earlierRefusal = (ordinal: number): OrchestrationV2TurnItem => ({
  ...base(ordinal, "error"),
  status: "failed",
  type: "error",
  failure: {
    class: "provider_error",
    message: "This request was blocked by our safety systems.",
    code: "misalignmentPolicyViolation",
    retryable: null,
  },
});

const otherFailure = (ordinal: number): OrchestrationV2TurnItem => ({
  ...base(ordinal, "error"),
  status: "failed",
  type: "error",
  failure: { class: "provider_error", message: "Overloaded", code: null, retryable: null },
});

const recoveryNotice = (ordinal: number, mode: "rewind" | "fresh"): OrchestrationV2TurnItem => ({
  ...base(ordinal, `notice-${mode}`),
  type: "system_notice",
  message: "Recovered",
  conversationRecovery: mode,
});

// Bartin's Home: 150 accepted, 151-153 and 155-156 refused on Codex, 154 failed on Claude.
const refusedHome = [
  run(149, "completed"),
  run(150, "completed"),
  run(151, "failed"),
  run(152, "failed"),
  run(153, "failed"),
  run(154, "failed", claude),
  run(155, "failed"),
  run(156, "failed"),
];
const homeRefusals = [151, 152, 153, 155, 156].map(refusal);

describe("conversationRecoveryOffer", () => {
  it.each([
    ["the first refusal after the last accepted run", refusedHome, homeRefusals, "rewind", 150],
    [
      "a refusal after a rewind",
      [...refusedHome, run(157, "failed")],
      [...homeRefusals, recoveryNotice(156, "rewind"), refusal(157)],
      "fresh",
      150,
    ],
    [
      "a refusal after a fresh start",
      [...refusedHome, run(157, "failed"), run(158, "failed")],
      [...homeRefusals, recoveryNotice(156, "fresh"), refusal(157), refusal(158)],
      "fresh",
      150,
    ],
    ["a refusal before any accepted run", [run(1, "failed")], [refusal(1)], "rewind", undefined],
    [
      "a refusal recorded before safetyBlock existed",
      refusedHome,
      [earlierRefusal(156)],
      "rewind",
      150,
    ],
  ] as const)("offers the next step for %s", (_case, runs, items, mode, lastAccepted) => {
    expect(conversationRecoveryOffer(runs, items)).toMatchObject({
      refusedRun: { ordinal: runs.at(-1)!.ordinal },
      lastAcceptedRun: lastAccepted === undefined ? undefined : { ordinal: lastAccepted },
      mode,
    });
  });

  it.each([
    ["the latest run was accepted", [...refusedHome, run(157, "completed")], homeRefusals],
    ["the latest run failed for another reason", refusedHome, [otherFailure(156)]],
    [
      "a recovery waits for the next message",
      refusedHome,
      [...homeRefusals, recoveryNotice(156, "rewind")],
    ],
    ["a turn is still running", [...refusedHome, run(157, "running")], homeRefusals],
  ] as const)("offers nothing when %s", (_case, runs, items) => {
    expect(conversationRecoveryOffer(runs, items)).toBeNull();
  });
});
