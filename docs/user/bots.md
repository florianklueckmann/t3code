# Bots

A Bot is a named agent with its own instructions and model. Attach it to a
project, and it keeps one conversation there that you come back to, instead of
starting a new thread each time. One Bot can serve several projects, each with
its own conversation, guidance and preferred sources.

## Set up a Bot

Open **Settings → Bots** and choose **New Bot**. Give it a name, instructions
for how it should work and answer, a model, and a **Learning** option (see
[Learning](#learning)). Then attach it to a project
under **Projects**. T3 Code starts the Bot's conversation in that project,
titled with the Bot's name and using the project's default permission mode.

The conversation title then works like any other thread's: your first message
gives it a generated title, and you can rename it. Renaming the Bot does not
change the title. The conversation header always shows the Bot's current name.

Your Bots sit in a column left of the thread list, on mobile in a row above
it. Click a Bot to open its conversation: the one that needs you, otherwise the
one you used last. Right-click it (on mobile, long-press) to pick another
project or open its settings. A dot shows when a conversation needs you, is
done, failed or is working. Bot conversations live only there, not in the
thread list; threads a Bot works on for a task show its figure in the list. A
Bot without a project opens its settings. You can also choose **Open
conversation** next to the project in **Settings → Bots**, or search the command
palette for the Bot or project name and pick **Open \<Bot\> in \<project\>**.

Changes to a Bot's instructions, guidance or sources apply from its next turn,
including in conversations that are already running. Changing its model
switches all of its attached conversations to that model.

Each Bot gets its own little figure. To change its color, face or topper, open
the Bot and select the figure next to its name (on mobile, **Change look**).
The look is shared by all of the Bot's projects and only changes how it
appears, never how it works. **Reset** returns it to its default.

## Project guidance and preferred sources

Each attached project has its own **Guidance** and **Preferred sources**. Guidance
is what the Bot should know about this project. Preferred sources are where it
should look first, such as a folder, a URL or a tool. Both apply only to that
project's conversation.

Preferred sources are a preference, not a limit. The Bot starts with relevant
saved sources and looks further when they are not enough. Its answers identify
their sources and, when relevant, the edition. They distinguish source facts,
decisions already made in the project, and suggestions. When a source is missing
or unreadable, or sources disagree, the Bot explains the gap and what could fill
it.

"Look in X" applies to the current task and its follow-ups. A later, unrelated
question goes back to the saved sources, though earlier lookups stay in the
conversation history. "Use X from now on" adds X to this project's sources and
keeps the others; the Bot removes or replaces a source only when you ask. The
change applies from the next turn. You can also edit sources in
**Settings → Bots**. Recording a source from the conversation needs the access
described in [Agents and Bots](#agents-and-bots).

## Tasks and routines

A Bot can work on something in its own **work thread** instead of in its
conversation. Ask the Bot to do it as a separate task, or start a routine. The
work thread runs in the Bot's project with its instructions, guidance and
sources. When it finishes, its card in the Bot's conversation shows the
run status and the conversation is marked unread. **View result** reads the saved
final response without opening the conversation; **Open thread** opens the work
thread for context or follow-up. The saved result stays tied to the task's run,
even after a follow-up in that thread. Completed means the run ended, not that
its answer proves the goal was achieved. Older tasks may have no saved result.
Cards also show tasks that are still working, waiting for your answer, failed,
were interrupted or cancelled, or were skipped. **Hide** removes a finished card
from the conversation on this device only, and **Show hidden** brings it back;
the task and its result stay in **Settings → Bots**.

On iOS and Android, completed direct tasks and routines use the same notifications
as agent work. Notifications require [T3 Connect](mobile-notifications.md). Enable them
for the environment in **Settings → Notifications** and allow them in the phone's
settings. Tapping a result notification opens its saved result in the task's work
thread. Result alerts use a generic title and do not include the prompt or answer text.
If the Bot continues in its conversation after a result, that follow-up may notify separately.

Cancelled and skipped tasks do not alert. Work-thread failures follow the existing failure
notification preference. If delivery is unavailable, the result card and unread
conversation remain; reconnecting can deliver a recent result, but results older
than two minutes do not trigger a delayed alert. Each registered device follows
its own notification settings. A missing saved result shows an unavailable notice
when opened; follow-up answers do not replace the saved task result.

For a direct task, you can ask the Bot to return its result here automatically
and continue the work you already authorized. This is off by default and allows
one pending return per conversation input turn. It waits for active work and
children to finish; newer direct input cancels the pending return. Failed or
cancelled tasks keep their status on the card without starting a result turn.
Detach, archive, and cancelling the task revoke a pending return. Routines and
older tasks do not gain automatic returns.

A direct task runs on the Bot's model unless you ask the Bot to use another
Codex model or reasoning level for that task. Only that task uses it; the Bot
and its conversations keep their model. A model or option the provider does not
offer, or a provider turned off for the project, is refused before the task
starts. Routines always follow the Bot's current model.

A **routine** runs a task on a schedule. In **Settings → Bots**, edit
the Bot and choose **Add routine** under the project. Describe what the Bot should do,
then pick a timing:

- **Before an event**: give the event's date and time and how long before it
  to prepare. The routine runs once.
- **Recurring**: a time of day on chosen weekdays, in the environment's time
  zone, which the form shows.

Choose **No changes** to have the Bot report results and propose changes
without editing files or data or sending messages. Choose **Changes allowed**
to authorize the edits or messages requested in the brief. New and existing routines
default to **No changes** until you choose otherwise. The brief determines
the result's content and format.

**Changes allowed** runs in **Full access** without approval prompts. **No changes**
is enforced, not only requested: the routine's task runs with a read-only
sandbox, no network for its commands, and no approval prompts. It can read files
and search the web, but it cannot write files, reach other machines from the
shell, run subagents, use your MCP servers, apps, plugins or hooks, or use T3
Code actions that change something, such as sending to threads, scheduling,
delegating or saving what the Bot learned. It uses the provider account you
selected for the Bot, including a ChatGPT sign-in. The task's result is saved
as usual.

No changes currently works only on macOS, with Codex 0.166.0 or 0.167.0.
Anywhere else the routine's task fails with the reason instead of running with
more access. Follow-up messages in a routine's task stay No changes, and its
work thread shows No changes as its fixed permission; to have the
Bot make the changes it proposed, ask it directly. Tasks you ask for directly
run in the conversation's mode.

If the environment was off when a routine was due, it runs the latest missed
run once when it is back, unless the event has already started; then
the card shows it as skipped. A routine also skips a run while its previous one
is still working. You can pause, resume, run, edit or delete a routine in
**Settings → Bots**, and cancel a running task from its card.

## Working notes

Each Bot keeps short working notes per project so it can pick up unfinished
business after a restart or a compacted conversation. They sit under the
project in **Settings → Bots** in four parts: **Open requests**, **Waiting on
you** (its questions and proposals), **Decided** and **Context**. A proposal
stays a proposal until you decide; only **Decided** records your choices.
Running tasks show under **Active work** from their live status, not from the
notes.

The Bot updates the notes when unfinished business changes, not after every
message. "3 messages since these notes were saved" tells you how much newer
conversation the notes don't cover yet. Each item shows where it came from;
a source that is gone or changed is marked unverified rather than dropped.

**Edit** the notes one item per line. If the Bot saved in the meantime, your
draft stays and you choose **Save mine** or **Discard mine**. **History** keeps
recent versions, and **Restore** saves an earlier one as the newest version, so
a restore can be undone too. Notes stay readable for archived Bots and detached
projects, but can't be edited or restored until they are active again.

## Learning

A Bot keeps what it learns per project by default, so a lesson from one campaign or
codebase does not leak into another. You see it under each project in
**Settings → Bots**, with where it came from and its earlier versions.

- **Your standing instructions** ("from now on…", "always…", "never…") apply
  from the Bot's next turn under either Learning option. The Bot records them
  when you say them, and you can also add them in settings.
- **Lessons from your corrections** follow the Bot's **Learning** option. With
  **Learn automatically** they apply from the next turn. With **Only after I
  adopt it** they wait under the project until you choose **Adopt** or
  **Reject**.
  A Bot cannot adopt its own lessons.
- A task's work thread can propose one lesson. It counts only once the task has
  completed, then follows the **Learning** option like any other lesson. If the
  task fails or is interrupted or cancelled, the proposal stays visible as
  **Task didn't finish** and is never applied.
- A lesson never overrides one of your standing instructions on its own. If it
  would, it waits for you even when the Bot learns automatically.
- Learning applies to the project it came from. It applies to all of the Bot's
  projects only when you say so, or when you adopt a lesson the Bot proposed
  for all projects. You can explicitly ask the Bot to remember a fact across
  all its projects too. The Bot tells you where the learning applies; shared
  entries appear under **Learning for all projects** in settings.
- **Retire** stops an entry, and **Restore** brings back an earlier version.
  A proposal made against a version that has since changed is marked outdated
  instead of being applied. The same lesson is not recorded twice.

**Maintenance**, under each project in **Settings → Bots**, reviews that
project's new messages and newly finished tasks once a night at 03:00 server
time and records lessons by the same **Learning** option. It needs the Bot on a
signed-in Codex model, and starts with what comes after you turn it on. A night
is skipped while the Bot's conversation or its tasks are still busy, while the
conversation is snoozed or archived, while maintenance is paused, or
while its model can't run.

Once the lessons and the Bot's working notes are saved, maintenance compacts a
long Bot conversation's context, so the next day starts small. The conversation
and its history stay as they were. A message you send before compaction starts
skips it for that night.

**Daily Home check**, next to Maintenance, has the Bot look over that
project's conversation once a day at the time you choose (08:00 server time by
default). It adds to **Waiting on you** what needs your decision or preparation
before the next check, each item quoting your message or naming its task, and
does nothing else: it starts no task and sends nothing. When it adds something,
the conversation turns unread; when there is nothing to add, you notice
nothing. A check waits until the conversation has been quiet for ten minutes,
skips while it is snoozed or archived, and runs only once after days the server
was off. It needs a Codex model on a Mac server.

The Bot gets its current learning at the start of each turn, not its whole
history. Learning does not add preferred sources, settle project decisions or
give the Bot more access. Research it did for one task stays in the
conversation but does not become a standing preference.

Bot conversations do not use Codex's own memories: nothing from them is added
to a Bot's turns, and Bot conversations are not used to build them. Your other
Codex threads keep your Codex memory settings.

## MCP connections

**Settings → MCP connections** stores an environment's MCP servers: one
connection per account, with its credentials as header or environment variable
values or secret-provider references. **Refresh** checks that those credentials
can be read; it does not start or contact the server. To change a connection's
URL or command, add a new connection.

In a Bot's settings, **MCP connections** lists them, and you choose which ones
this Bot may use. Its conversations, tasks, routines and the work they start
load exactly those connections and none of your own Codex MCP servers. A
change applies from the Bot's next turn. A disabled connection stays granted
but does not load until you enable it again. Removing a connection takes it
away from every Bot that uses it; the catalog shows which Bots those are and
asks first.

A No changes routine uses only the tools a connection's server marks as
read-only. T3 Code cannot check that mark.

## Current limits

- Bots run on Codex models only. If you switch a Bot conversation to another
  provider, its turns fail until you switch back.
- MCP connections apply only to Codex on a Mac server. Elsewhere, a Bot without
  connections uses the provider's own MCP setup, and a Bot with connections does
  not run.
- Built-in email and calendar connections are not available.

## Detach and archive

**Detach** stops the Bot in one project. Its conversation there is archived, and
its guidance and sources are kept. **Reattach** brings back the same conversation
with its history, switched to the Bot's current model.

**Archive** stops the Bot everywhere and archives all of its conversations. An
archived Bot cannot be edited or attached to projects. **Restore** brings back the
Bot and the conversations of its attached projects. Bots cannot be deleted.

Detach and archive also pause the Bot's routines there and stop its unfinished
tasks. Reattach and restore leave routines paused; resume each one when you want
it back.

Unarchiving a Bot conversation yourself does not reattach the project or restore
the Bot. Messages there fail until you do.

A project with an attached Bot cannot be deleted. Detach every Bot first.
Deleting the project then also removes those Bots' guidance and sources for it.

## Agents and Bots

[Outside agents](./outside-agents.md) and agents in T3 Code threads can manage
Bots through T3 Code's MCP tools. Any connected agent can list and read Bots.
Creating, editing, archiving, restoring, attaching and detaching Bots, and
changing a project's guidance and sources, need one of:

- an outside agent approved with **Full access**
- an agent in a T3 Code thread that runs in **Full access** and not in Plan mode

This is also what lets a Bot record a preferred source from its own conversation.

In the app, changing Bots needs the `orchestration:operate` permission, the same
one that starts and messages threads. See [Remote access](./remote-access.md)
for choosing a client's permissions.

## Back up or move Bots

Bots belong to the connected environment. To back up or move them, stop its
server and copy the whole T3 home, including both `userdata/bots.sqlite` and
`userdata/statev2.sqlite`. Keep the two databases from the same backup: Bot
conversations, work threads and schedules refer to records in both.
