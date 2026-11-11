# Bot preparation

Runs Bot preparation routines and Bot home-conversation turns end to end through a T3 Code dev server and its configured Codex provider. It checks that routines follow their brief and configured change permission, including carrying out a requested file edit in **Changes allowed** mode and proposing it in **No changes** mode; that session preparation gives a reminder, a recap grounded in the recorded play, open questions and marked proposals; that a missing record of play is said rather than invented; that preparation without changes neither edits project files nor starts a turn in the home conversation; and that a Bot asked in its home conversation to prepare before a dated session sets up a one-time routine with the right session time and lead time.

Like [bot-sources](../bot-sources/), nothing is replayed and it calls no model API directly. Turns count against the dev server's Codex login.

## Run

1. Start an isolated dev server from the repo root: `T3CODE_CODEX_LAUNCH_ARGS="--disable memories" vp run dev --no-seed`. Its state lives in the checkout's `.t3`, and the flag keeps your Codex memories out of the synthetic campaign. Codex still loads your other global config, such as `~/.codex/AGENTS.md`, skills and MCP servers.
2. From `evals/`, run one case first:

   ```sh
   pnpm bot-preparation --base-dir ../.t3 --out runs/check --case recap-from-records --samples 1
   ```

3. Then the full set: `pnpm bot-preparation --base-dir ../.t3 --out runs/<name>`.

Flags: `--model` (default `gpt-6.1-terra`), `--effort` (default `high`), `--samples` (default 3), `--concurrency` (default 2), `--case <id>` (repeatable), `--work <dir>` for the synthetic project folders (default `<out>/work`). The run stops when the server's Codex catalog does not offer the model with that effort; it never falls back to another model.

Routine cases create the routine through `schedule_task` with a `botId` and start it with `run_scheduled_task_now`, so they test the work thread's context, not the timing; the scheduler's timing is covered by the server tests. Each sample creates its own project and Bot.

To compare a change, run the same cases with the same model and effort against a server on the old and new revision of `apps/server/src/bots/BotTurnContext.ts`, `apps/server/src/mcp/toolkits/bot/tools.ts` and the `schedule_task` schema in `packages/contracts/src/orchestratorMcp.ts`.

## Cases

`cases.ts` holds one synthetic campaign, with and without a session log, and the cases. `routine-allows-changes` and `routine-without-changes` come from a Bot refusing a scheduled edit because every routine was restricted to session preparation; they check both change permissions and a brief that requests a single-sentence result. The edit case also compares the exact resulting file content and rejects changes to any other file. The explicit-mode and rename controls come from a text review: a user's chosen mode takes precedence over inference from the brief, and editing a routine keeps its saved mode unless asked otherwise. These controls passed before the clarification as well. Routine cases grade the work thread's final message with case-insensitive regexes, the task's status and the home conversation's run count. Home cases grade the answer, the tools the Bot called and the routines stored for the project. `answers-inline` is the control: a plain question gets an answer, not a task or a routine.

## Output

`results.jsonl` has one row per sample with its checks, the result or answer, the tool activity and the routines. `summary.md` has the pass counts per case. The rows hold full model output; read them before quoting any.

`returns-task-and-continues`, `returns-incomplete-task-honestly`, and
`task-without-home-return` cover T3B-24. They start direct Bot work from Home:
the opted-in result must cause exactly one Home follow-up, perform only the
user's already authorized edit or identify missing input, and keep the default
case from waking Home. Missing delivery retains the task, answer, and file
evidence as failed checks. Compare the same cases and model against a separate
base server with a fresh home; never downgrade the newer Bot database.

`task-with-own-reasoning` covers T3B-28: asked for one task at low reasoning,
the Bot must pass that selection to `start_task`, not `update` itself. It grades
the task's recorded selection against the Bot's model and checks the Bot's
selection afterwards. Run it at the default `high` effort so the two differ.
