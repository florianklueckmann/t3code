# Bot maintenance

Checks what nightly Bot maintenance learns from new evidence. Each case builds a synthetic Bot packet with the engine's own `buildBatch`, sends it through the real `CodexSealedGeneration` or `ClaudeSealedGeneration` with the fixed `MAINTENANCE_POLICY` and `Proposal` schema, and grades the answer. The engine's `verifyProposal` must accept every proposal; a sample it rejects fails, because a real pass would consume nothing.

It starts no T3 server. On Codex it probes the install in the default home (`CODEX_HOME` or `~/.codex`) the way the Codex driver does. On Claude (`--instance claude`) it uses the Claude home from `--claude-home`, or the default one, takes the installed Claude Code version and the bundled model list, and runs no provider probe, so a signed-out account shows as a refusal on the first call. Either way it uses that login, so calls count against that account's usage, and it never logs out or edits provider config.

## Run

From `evals/`, check the setup with one case and one sample first:

```sh
pnpm bot-maintenance --out runs/check --case correction-becomes-lesson --samples 1
```

Then the full set: `pnpm bot-maintenance --out runs/<name>`.

Flags: `--instance` (`codex`, the default, or `claude`), `--model` (default `gpt-6.1-terra`, on Claude `claude-haiku-5-5`), `--effort` (default `high`, on Claude the model's own default), `--claude-home <dir>`, `--samples` (default 3), `--case <id>` (repeatable), `--baseline <results.jsonl>` to show an earlier run's pass counts beside this one.

| Model              | Effort  | Run                   | Passed |
| ------------------ | ------- | --------------------- | ------ |
| `gpt-6.1-terra`    | high    | 2026-11-24, 1 sample  | 7/7    |
| `claude-haiku-5-5` | default | 2026-11-24, 3 samples | 33/33  |

The Codex row predates the four `match` cases; the Claude row includes them.

The run stops before any model call when the sealed generator refuses the selection, for example because the model or effort is missing from the account's catalog or the account is signed out. It never falls back to another model.

## Cases

`cases.ts` holds one synthetic Bot in one project. A case lists its sources (Home input and task results), the learning the Bot already keeps (a `project` puts a lesson in another of the Bot's projects), the suggestions it already stored, and checks. A check says that some operation, or none, matches a text pattern, kind, op, replaced or matched entry or cited source, or that the proposal is empty. A case fails when half or more of its samples fail.

To add a case, name the ticket or design row it comes from and make it fail on the policy text it guards against.

## Output

`results.jsonl` has one row per sample: the raw proposal, the verifier result, the graded operations and what the eval saw of the call. On Codex that is the app-server connection: request counts, raw response items (only each message's first line), notifications the client could not decode, hooks Codex ran and token usage. On Claude it is the stream: the startup frame's model, tools and MCP servers, each message block's type, hooks Claude reported and token usage. To see hooks, the eval asks Claude for hook frames, the one option it adds to the production call. `summary.md` has pass counts per case and the same facts per run.

Each sample runs with its own `TMPDIR` under `<out>/tmp`, which the provider and any hooks it runs inherit. The summary lists what was created there and what was left behind.
