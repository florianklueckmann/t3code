# Conversation summary

Checks what a fresh conversation receives when the user starts one (T3B-50): a summary of the older messages from the shipped prompt (`buildConversationSummaryPrompt` in `packages/provider-core/src/server/textGenerationPrompts.ts`) plus the newest messages verbatim. Each case is a synthetic thread whose decisions, constraints and open items sit outside the verbatim tail. The grader looks at the whole handoff and at the summary's sections, and requires that no command output reaches the summary.

## Run

From `evals/`, with a signed-in Codex:

```sh
pnpm conversation-summary --out runs/summary --case decision-in-the-middle --samples 1
pnpm conversation-summary --out runs/summary
pnpm conversation-summary --mode selection --out runs/selection
```

- `--mode summary` (default) calls the summary model through the Codex text generation path. `--mode selection` grades the handoff before T3B-50, the newest messages at the default cap without a summary, and calls no model.
- Flags: `--model` (default `gpt-6-luna`, the default text generation model), `--case <id>` (repeatable), `--samples <n>` (default 3), `--codex-home <dir>` to use a copy of a Codex home, `--baseline <results.json>` to put an earlier run beside this one.
- A case fails when half or more of its samples fail. `results.json` holds each sample's summary and failed checks; `summary.md` the pass counts.
- Cost: one short call per case and sample, nine for a full run.

## Cases

`decision-in-the-middle` reproduces the lost decisions of T3B-50, `update-previous-summary` checks that a previous summary is updated rather than dropped, and `german-thread` is the control for the conversation's language. Each must fail in `--mode selection`. Add a case in `cases.ts` with its source and checks; pad it with routine runs until its facts fall outside the verbatim tail. Grader tests: `vp test run evals/conversation-summary/run.test.ts` from the repository root.
