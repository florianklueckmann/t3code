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
tools that change state check the same constraint. If an adapter cannot enforce a required restriction,
the server refuses the turn. See [Adding a provider](./adding-a-provider.md)
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
The task card in Home opens the saved result. For a direct task that opts into an
automatic Home follow-up, [orchestration](../../apps/server/src/orchestration-v2/Orchestrator.ts)
admits the result only while the original Home input is still current. The
server submits the result to Home under the thread's existing permissions.

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
