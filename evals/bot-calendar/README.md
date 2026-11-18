# Bot calendar

Checks that a Bot granted Calendar (this Mac) answers "What's on my calendar today?" with one `list_events` call over today and names today's events with their times. The model sees the tool's description and schema from `apps/server/src/mcp/toolkits/calendar/tools.ts`; the eval copies none of it.

The calendar is a fake: `fakeHelper.ts`, wrapped in an app bundle that the server launches through `open` like the real T3 Calendar Helper, so the whole transport runs. It answers from a fixture written for the run's local day: three events today on two selected calendars, one on an unselected calendar, and one tomorrow. It never reads a real calendar. Turns run in the Bot's Home through a dev server's Codex or Claude login. Nothing is replayed.

## Run

1. Start an isolated dev server on macOS from the repo root, pointing it at the fake helper's path:

   ```sh
   T3CODE_CALENDAR_HELPER_APP="$PWD/.t3/calendar-fixture/T3 Calendar Helper.app" \
     T3CODE_CODEX_LAUNCH_ARGS="--disable memories" vp run dev --no-seed
   ```

   The run writes the app there, so it need not exist when the server starts.

2. From `evals/`, check the setup with one sample:

   ```sh
   pnpm bot-calendar --base-dir ../.t3 --out runs/check --case today --samples 1
   ```

3. Then each model: `pnpm bot-calendar --base-dir ../.t3 --out runs/<name>`, and `--instance claudeAgent --model claude-haiku-5-5` for Claude.

Flags: `--model` (default `gpt-6-luna`), `--effort` (default `medium`), `--samples` (default 3), `--case <id>` (repeatable), `--work <dir>` (default `<out>/work`), `--instance` (default `codex`). Samples run one at a time, because the fake helper's request log cannot tell Bots apart. The run selects the fixture's calendars through `mcpConnections.calendarUpdate` and grants each sample's Bot the calendar through `bots.setMcpGrants`, as Settings does.

## Cases

- `today` passes when the helper received a `list-events` request covering today and at most two days, only for selected calendars, and the reply names today's three events and the dentist's 9:30 start. Grades come from the helper's request log and the reply.
- `no-calendar` is the control: arithmetic that must not read the calendar.

## Output

`results.jsonl` has one row per sample with its checks, the reply, the helper requests and the tool activity. `summary.md` has the pass counts per case. A full run is six turns per model.
