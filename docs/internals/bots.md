# Bot integration

A Bot is a named identity owned by one T3 environment. It has one persistent
Home thread per attached project. Home and work threads use the same T3
orchestration and provider adapters as other threads. Bot services add project
context, execution rules, and task tracking around that lifecycle.

See the [architecture diagram](./bot-architecture.html) for the component
relationships and the [Bots guide](../user/bots.md) for setup and use.

## Environment and thread ownership

Web, desktop, and mobile read Bot summaries and task status through the shared
[client runtime](../../packages/client-runtime/src/state/server.ts). Clients
use the capabilities of the connected environment to decide which Bot actions
to show. A Home message goes through the thread RPCs. A Bot settings change goes
through the Bot RPCs. Both act on the same server, including over T3 Connect.

[BotService](../../apps/server/src/bots/BotService.ts) stores the project binding.
It creates Home through the ordinary thread launch service before saving the
binding. The launch uses a stable thread ID and command ID. If the server stops
between those writes, a retry can adopt the existing thread. Reattaching a
project reuses its Home. A detached project or archived Bot keeps its thread
history, but the server refuses new Bot turns.

A Bot can also have one Home above its projects. It is an ordinary Home thread
in a hidden project that the server owns, with the fixed id `bot-home-<botId>`,
rooted at `<T3 home>/bots/<botId>`. A real thread without a project would have
changed most of the upstream thread model and broken older clients, so project
lists leave this project out while a lookup by id still finds it. The folder is
its own Git repository. Otherwise a T3 home inside a checkout, such as `.t3` in
every dev worktree, would put the Home's checkpoints on that checkout. Queries
about attached projects skip its binding (`kind = 'bot'`), and no task or
routine runs in it.

## Context and permissions at turn start

[BotTurnContext](../../apps/server/src/bots/BotTurnContext.ts) resolves Home and
work threads from stored bindings and task records. The server reads current
Bot instructions, project guidance, preferred sources, and applicable learning
before each turn. Home also receives its working notes. The adapter receives
these as application instructions, so edits reach the next turn even when the
provider resumes an existing session.

Orchestration resolves [BotRuntimePolicy](../../apps/server/src/bots/BotRuntimePolicy.ts)
before the adapter runs. The policy resolves tool access along thread lineage
as well as for Home and work threads. A thread started by a Bot can inherit MCP
restrictions without inheriting its Home instructions. Codex and Claude turn
off native memory for Bot threads.

The [execution constraint](../../apps/server/src/bots/BotExecutionConstraint.ts)
for a **No changes** routine comes from the admitted task. Editing the routine
or following up in its work thread cannot widen the thread's access. T3 MCP
tools that change state check the same constraint. The Bot-level Home with read
access gets the same read-only load and changes things only through its Bot:
T3 MCP tools let it start and cancel tasks, record learning and save its notes,
and refuse every other change. With full access it runs as a project Home does.
If an adapter cannot enforce a required restriction, the server refuses the turn. See [Adding a provider](./adding-a-provider.md)
for the adapter contract.

## Tasks and results

Direct requests reach [BotTaskService](../../apps/server/src/bots/BotTaskService.ts)
through the app or the `t3_bot` MCP tool. The scheduler submits routine
occurrences through [BotRoutineTarget](../../apps/server/src/scheduledTasks/BotRoutineTarget.ts).
Both paths persist the task before launching its work thread so the thread can
resolve its Bot context on its first turn. A routine occurrence key prevents a
retried occurrence from starting another task.

The task service reconciles status from orchestration and pins the result to
the completed run. Later turns in the work thread leave that result intact.
The task card in the Home that started the task opens the saved result. A task
started from a Bot's own Home runs in one of its attached projects, in the
runtime mode of that project's Home, and its card stays with the Bot's own Home.

For a direct task from a project Home that opts into an automatic follow-up,
[orchestration](../../apps/server/src/orchestration-v2/Orchestrator.ts) admits
the result only while the original Home input is still current. The server
submits the result to Home under the thread's existing permissions. That return
holds one result per Home input and waits for the Home's other tasks, so a Home
that fans out cannot use it. [BotHomeUpdates](../../apps/server/src/bots/BotHomeUpdates.ts)
serves the Bot's own Home instead: one message per completion, failure,
interruption or question of a task it started, sent from the task's work thread.
A message from another thread queues behind a Bot Home's running turn, and the
command id per task, status and run keeps a retried or restarted send to one.
The message folds into an automation row, and a turn it starts is not user
input, so it cannot record a standing instruction. That turn never alerts the
phone: the task's own result already did, under the alert budget below.

The Bot's task limit is checked when a direct task launches, not at admission, so
a waiting task is an ordinary admitted row that a reconcile pass starts later and
that survives a restart. A waiting task counts against younger ones: the order is
fixed by `created_at`, and two launches deciding at once cannot both take the last
slot without a lock. Routines, watches and diagnoses bypass the limit.

A completed direct task's result is checked once, in the transaction that records
its completion, by [BotTaskAcceptance](../../apps/server/src/bots/BotTaskAcceptance.ts):
the report line its work thread ends with, and whether the branches, commits and
files it names exist. The outcome is stored on the task, so the Home return, the
Waiting item and the relay's alert all read the same decision. A result that waits
for the user is never returned to a project Home, and its alert is held and gathered by
[BotAttention](../../apps/server/src/bots/BotAttention.ts) even when the user
started the task.

## Task worktrees

A task that may write launches into a worktree from
[BotWorktreePool](../../apps/server/src/bots/BotWorktreePool.ts). Each work thread
keeps one worktree path for its whole life, and the worktree moves: into that path
when a thread claims it, back to its resting place (`bot-pool-<id>`) when released.
A finished task's thread therefore points at a missing worktree, the state storage
cleanup already leaves behind, and turn start restores it:
[restoreMissingWorktree](../../apps/server/src/workspace/restoreMissingWorktree.ts)
first asks the pool for one. The alternative, a worktree that never moves and
threads pointed at it, fails because T3 treats a thread's path as that thread's own
checkout. Turn start reads the path before it restores, branch sync renames every
thread whose path holds a checkout, and rollback, terminals and diffs act on it, so a
released thread left at a shared path would act on the next task's work.

Only the pool creates and removes these worktrees; the launch gets an
`existing_worktree` and owns nothing it could remove. A row in `bot_worktrees`
lives as long as its worktree, and every transition is one step that starts from
that row: the claim is written before anything moves, release moves before it frees
the row, and the worktree's Git directory identifies it at either of its two places.
A step a restart interrupted runs again from what it finds. The rules each step
keeps:

- Before any checkout, clean, move or removal, the folder must be the top of a
  linked worktree of the project's repository, registered at that folder, with the
  expected Git directory. A move never targets an existing folder, since Git would
  move into it. A checkout of the thread's own branch at its folder, recreated there
  for a terminal or a side chat, joins the pool on the next turn; anything else there
  fails the turn rather than run in it.
- Nothing is reused or removed without a fresh check for uncommitted and untracked
  files and submodule history no remote has, the check storage cleanup uses. A free
  worktree must also still be at the commit it was parked at. One that fails stays
  where it is with `kept_reason` set, outside the pool's count; a message in its task
  picks it up again, and Clear retries it. A commit only the worktree holds, as when
  its task branch was deleted while it was parked, gets a ref under
  `refs/t3/bot-worktrees/` before HEAD moves on.
- A worktree stays held until its work thread, every thread sharing its path (side
  chats) and its setup script have finished. An awaited setup holds the agent back
  even when the script is async, so a run that started means the install succeeded.
  A worktree whose run never started is removed, not reused: its install may be
  unfinished, and a cancelled setup's process can outlive its terminal briefly.

Git cannot move a worktree with populated submodules, so such a worktree is removed
at release once the check passes, not reused. Release and turn start both run under
the path's workspace lease. A terminal does not take a pooled worktree, but release
sees terminals the way storage cleanup does
([liveTerminals](../../apps/server/src/terminal/liveTerminals.ts)): while a shell
works in the worktree, by the thread's folder or its own working folder, the
worktree stays where it is as kept, outside the count, and each pass releases it
once that terminal is gone. Nothing closes the user's terminal. The pool cap applies
to starting tasks; a follow-up still gets a worktree when the pool is full, and
release removes the extra one.

## Persistence and recovery

The server opens [two sibling databases](../../apps/server/src/persistence/Sqlite.ts).
`statev2.sqlite` owns thread history, runs, and schedules. `bots.sqlite` keeps
Bot profiles, project bindings, tasks, and routine links under its own migration
history. Task results and routine links refer to runs and schedules in
`statev2.sqlite`.

[BotRoutineStore](../../apps/server/src/bots/persistence/BotRoutineStore.ts)
journals changes that touch both databases so it can finish an interrupted
write on restart. Keep the two databases from the same backup when restoring
an environment. See [Back up or move Bots](../user/bots.md#back-up-or-move-bots).
