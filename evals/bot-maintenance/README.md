# Bot maintenance

Checks what nightly Bot maintenance learns from new evidence. Each case builds a synthetic Bot packet with the engine's own `buildBatch`, sends it through the real `CodexSealedGeneration` with the fixed `MAINTENANCE_POLICY` and `Proposal` schema, and grades the answer. The engine's `verifyProposal` must accept every proposal; a sample it rejects fails, because a real pass would consume nothing.

It starts no T3 server. It probes the Codex install in the default home (`CODEX_HOME` or `~/.codex`) the way the Codex driver does and uses that login, so calls count against that account's usage. It never logs out or edits Codex config.

## Run

From `evals/`, check the setup with one case and one sample first:

```sh
pnpm bot-maintenance --out runs/check --case correction-becomes-lesson --samples 1
```

Then the full set: `pnpm bot-maintenance --out runs/<name>`.

Flags: `--model` (default `gpt-6.1-terra`), `--effort` (default `high`), `--samples` (default 3), `--case <id>` (repeatable), `--baseline <results.jsonl>` to show an earlier run's pass counts beside this one.

The run stops before any model call when the sealed generator refuses the selection, for example because the model or effort is missing from the account's catalog or the account is signed out. It never falls back to another model.

## Cases

`cases.ts` holds one synthetic Bot in one project. A case lists its sources (Home input and task results), the learning the Bot already keeps, and checks. A check says that some operation, or none, matches a text pattern, kind, op, replaced entry or cited source, or that the proposal is empty. A case fails when half or more of its samples fail.

To add a case, name the ticket or design row it comes from and make it fail on the policy text it guards against.

## Output

`results.jsonl` has one row per sample: the raw proposal, the verifier result, the graded operations and what the eval saw on the app-server connection. That includes request counts, raw response items (only each message's first line), notifications the client could not decode, hooks Codex ran and token usage. `summary.md` has pass counts per case and the same connection facts per run.

Each sample runs with its own `TMPDIR` under `<out>/tmp`, which Codex and any hooks it runs inherit. The summary lists what was created there and what was left behind.
