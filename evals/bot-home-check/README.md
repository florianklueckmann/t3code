# Bot Home check

Checks what the daily Bot Home check (T3B-24) adds to Waiting. Each case builds a synthetic Bot Home on a running, parent-owned T3 Code server through its MCP tools, lets the server's own scheduler start the check, and grades the note, the check's reply and the stored outcome.

The check prompt is `HOME_CHECK_PROMPT` in `apps/server/src/bots/BotHomeCheck.ts`. The server under test sends it; the eval imports it only to record whether the server ran the same text (`promptMatchesSource`).

## How a check is started

No client can start a check at once. After seeding, the eval checks that each Home is idle with a completed ordinary turn and its native provider conversation. It waits out the server's ten-minute quiet period and writes each Home's `bot_home_checks` row in that server's `bots.sqlite` so a daily time has just passed. The server's scheduler, quiet check, admission, scoped provider turn, Waiting save rules and outcome reconcile all run as they would for a user. An early case (T3B-79) instead turns daily and early checks on before its task starts, with the daily time just passed, so only the finished task's outcome starts the check after the quiet period. The eval refuses `~/.t3`; point `--base-dir` only at a synthetic home.

## Run

Start a synthetic server on a Mac with a signed-in Codex or Claude (for example `vp run dev --home-dir /synthetic/home --no-seed`). From `evals/`, check the setup with one case and one sample first:

```sh
pnpm bot-home-check --base-dir /synthetic/home --out runs/check --case nothing-useful-noop --samples 1
```

Then the full set: `pnpm bot-home-check --base-dir /synthetic/home --out runs/<name>`. A full run waits about 25 minutes of wall time for quiet periods, plus the turns. It costs about 48 turns on the chosen model: per sample one seed turn and one check, with a separate task for the decision case, and for the removal control a second check and turn.

A case with a `remit` writes it into the Bot's `bot_attention` row as Bot settings would. `--omit-remit` leaves it out, which shows what the remit decides: `remit-rules-out-event` must fail that way, as the same appointment goes to Waiting.

Flags: `--model` (default `gpt-6.1-terra`), `--effort` (default `high`), `--samples` (default 3), `--case <id>` (repeatable), `--work <dir>` for the synthetic project folders, `--baseline <results.jsonl>` to keep an earlier run beside this one. It never falls back to another model. `--instance` (default `codex`) must name a Codex or Claude instance (Claude Code 2.1.327 or later): the check is a sealed run only those two enforce.

## Baseline

The baseline is the same restricted run with a plain prompt. Start a second synthetic server from a scratch worktree of this commit with `HOME_CHECK_PROMPT` set to `Check your Home and add to Waiting anything that needs me.`, run the eval against it, and pass its `results.jsonl` as `--baseline` to the candidate run. Its rows show `promptMatchesSource: false`.

## Cases

`cases.ts` holds eight cases: the ticket's three scenarios (a task waiting on the user's choice, an upcoming event that needs preparation, nothing worth saying), the same decision reached through an early check, the same upcoming event under a remit (T3B-81) that says appointments never need the user, and three controls that catch a prompt which overcorrects into spam (the event is after the next check, Waiting already holds it, the user removed what an earlier check proposed). A case fails when half or more of its samples fail. A sample whose precondition did not hold, such as a first check that proposed nothing for the removal control, fails with `setup held`.

The decision case seeds a neutral ordinary Home turn and starts a task with a generic title. The choice appears only in the task result. The server supplies excerpts from up to ten recent completed tasks of that Home, capped at 2000 characters each, through `BotTaskService.getResult`. The grader requires both options from the result in the new Waiting item, along with its task reference.

To add a case, name its source and make it fail on the baseline prompt.

## Output

`results.jsonl` has one row per sample: checks, the stored outcome, the note before and after, the check's reply and prompt. `summary.md` has pass counts per case. Grader tests: `vp test run evals/bot-home-check/run.test.ts` from the repository root.
