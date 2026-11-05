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
were interrupted or cancelled, or were skipped.

For a direct task, you can ask the Bot to return its result here automatically
and continue the work you already authorized. This is off by default and allows
one pending return per conversation input turn. It waits for active work and
children to finish; newer direct input cancels the pending return. Failed or
cancelled tasks keep their status on the card without starting a result turn.
Detach, archive, and cancelling the task revoke a pending return. Routines and
older tasks do not gain automatic returns.

A **routine** runs a task on a schedule. In **Settings → Bots**, edit
the Bot and choose **Add routine** under the project. Describe what the Bot should do,
then pick a timing:

- **Before an event**: give the event's date and time and how long before it
  to prepare. The routine runs once.
- **Recurring**: a time of day on chosen weekdays, in the environment's time
  zone, which the form shows.

Choose **No changes** to instruct the Bot to report results and propose changes
without editing files or data or sending messages. Choose **Changes allowed**
to authorize the edits or messages requested in the brief. New and existing routines
default to **No changes** until you choose otherwise. The brief determines
the result's content and format.

Both modes run in **Full access** without approval prompts. The change mode
controls the Bot's instructions, not its tool access. Tasks you ask for directly
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
a restore can be undone too. An archived Bot's notes stay readable but can't be
edited.

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

The Bot gets its current learning at the start of each turn, not its whole
history. Learning does not add preferred sources, settle project decisions or
give the Bot more access. Research it did for one task stays in the
conversation but does not become a standing preference.

Bot conversations do not use Codex's own memories: nothing from them is added
to a Bot's turns, and Bot conversations are not used to build them. Your other
Codex threads keep your Codex memory settings.

## Current limits

- Bots run on Codex models only. If you switch a Bot conversation to another
  provider, its turns fail until you switch back.
- Results appear in T3 Code only. Routines don't send push notifications or
  emails, or read your calendar.

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
