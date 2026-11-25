# Bots

A Bot is a named agent with its own instructions and model. Attach it to a
project, and it keeps one conversation there that you come back to, instead of
starting a new thread each time. One Bot can serve several projects, each with
its own conversation, guidance and preferred sources.

## Set up a Bot

Open **Settings → Bots** and choose **New Bot**. Give it a name, instructions
for how it should work and answer, a Codex, Claude or Pi model (see
[Codex, Claude or Pi](#codex-claude-or-pi)), and a **Learning** option (see
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

### Codex, Claude or Pi

A Bot runs on a Codex, Claude or Pi model. Its conversations, tasks and
routines, and the threads it starts, stay on those providers: a Bot conversation
or task thread you switch to another provider refuses new messages until you
switch it back.

A Bot on Claude works with the same instructions, guidance, sources, learning,
working notes, tasks and routines. Its threads load T3 Code's own tools and the
[MCP connections](#mcp-connections) you grant it, and no other MCP server: your
Claude MCP servers, claude.ai connectors and plugins stay out. Hooks, skills, permission rules and `CLAUDE.md` files still apply, as they
do on Codex, and so do plugins and hooks your organization manages for Claude.

One feature needs a Codex model: **Use my own Codex MCP servers**. On a Claude
Bot, **Settings → Bots** shows it as unavailable and says why.

A Bot on Pi works with the same instructions, guidance, sources, learning,
working notes, tasks and routines. Its threads load T3 Code's own tools and the
MCP connections you grant it, and nothing else: Pi's own MCP servers from
`mcp.json` and every Pi extension and package stay off, including Pi's built-in
codemode and tool search, so its tools are declared to the model directly.
Skills, prompt templates and `AGENTS.md` files still apply. On a Pi Bot, **Use
my own Codex MCP servers**, Maintenance, No changes routines, the Daily Home
check and Diagnose failed routines show as unavailable.

To switch a Bot to Claude or Pi, first turn off what that provider can't do
yet. Otherwise the switch is refused, the message lists what to change, and the
Bot keeps its model.

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

Results of work you didn't start yourself, such as scheduled routines and diagnoses, count against
the Bot's alert budget (see [Alerts and remit](#alerts-and-remit)); results of tasks you asked for
and routines you ran with **Run now** always alert at once. Cancelled and skipped tasks do not alert. Work-thread failures follow the existing failure
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

A direct task starts with the Bot's model by default. The Bot can choose a
different Codex, Claude or Pi model for a task or subagent and can use a specific
model or reasoning level you request. It might use Luna or Haiku to pull facts
from many threads, or Sol or Opus to design and test a complex script. The choice
applies only to that work. If a requested model or option is unavailable, or the
provider can't run the task with your Bot's settings, the Bot tells you why.
Routine runs use the Bot's current model.

A **routine** runs a task on a schedule. In **Settings → Bots**, edit
the Bot and choose **Add routine** under the project. Describe what the Bot should do,
then pick a timing:

- **Before an event**: give the event's date and time and how long before it
  to prepare. The routine runs once.
- **Recurring**: a time of day on chosen weekdays, in the environment's time
  zone, which the form shows.

Choose **No changes** to have the Bot report results and propose changes
without editing files or data or sending messages. Choose **Changes allowed**
to authorize the edits or messages requested in the brief. New routines, and
older routines saved without a choice, default to **No changes** until you
choose otherwise. The brief determines
the result's content and format.

**Changes allowed** runs in **Full access** without approval prompts. **No changes**
is enforced, not only requested, and runs without approval prompts. It can read
files and search the web, but it cannot write files, reach other machines from a
shell, run subagents, use your MCP servers, apps, plugins or hooks, or use T3
Code actions that change something, such as sending to threads, scheduling,
delegating or saving what the Bot learned. On Codex the task keeps a shell for
reading, in a read-only sandbox without network. On Claude it has no shell at
all, and your permission rules, skills and launch arguments can't give it more
tools. It uses the provider account you selected for the Bot, including a
ChatGPT sign-in. The task's result is saved as usual.

On Claude, plugins and hooks your organization manages for Claude Code still
run in No changes tasks and Home checks, because Claude has no switch to turn
them off. The Bot can't add or change them. No changes limits what the Bot can
do, not what your organization set up on that computer. If no organization
manages your Claude Code, nothing extra runs.

No changes currently works only on macOS, with Codex 0.166.0 or Claude Code
2.1.326 or later. Anywhere else the routine's task fails with the
reason instead of running with more access. Follow-up messages in a routine's task stay No changes, and its
work thread shows No changes as its fixed permission; to have the
Bot make the changes it proposed, ask it directly. Tasks you ask for directly
run in the conversation's mode.

If the environment was off when a routine was due, it runs the latest missed
run once when it is back, unless the event has already started; then
the card shows it as skipped. A routine also skips a run while its previous one
is still working. You can pause, resume, run, edit or delete a routine in
**Settings → Bots**, and cancel a running task from its card.

### Standing assignments

Ask a Bot once to keep an eye on something that recurs, for example "watch for
upcoming sessions and tell me what preparation is still missing". The Bot sets
up one recurring **No changes** routine as a **watch**, instead of one routine
per occasion. Each run checks the sources its brief names.

- When an occasion needs you, the run's result appears as a card in the
  conversation, which turns unread, with one alert under the Bot's
  [alert budget](#alerts-and-remit).
- When nothing is new, you notice nothing: no card, no unread conversation, no
  alert. The run's thread is archived, and [maintenance](#learning) does not
  learn from it. The same goes for a run skipped because the previous one was
  still working.

T3 Code records what a watch posted for each occasion, and a watch posts once
per occasion: later runs on the same occasion stay quiet. To hear more about
it, ask the Bot. **Run now** always shows its result, also when nothing is new.

A watch only reads. It is a No changes routine with the limits above: the
project's files, web search, and the read-only tools of the MCP connections you
granted the Bot. It works where No changes routines do, so not on a Pi Bot.

You can also set one up yourself: in the routine form in **Settings → Bots**,
turn on **Watch** for a recurring No changes routine. The routine list marks it
as a watch. To end a watch, turn **Watch** off, pause or delete the routine, or
ask the Bot. Switching the routine to **Changes allowed** or to a single run
before an event turns it into an ordinary routine that reports every run.

### Diagnose failed routines

**Diagnose failed routines**, next to the Home check in **Settings → Bots**, has
the Bot look into a routine run that failed. Turn it on per project and write a
**Diagnostic brief**: what to look into and how to report it. When a routine run
fails, the Bot starts one diagnostic task with that brief. Its card in the
conversation says which routine run failed, and **Open failed run** opens that
run's work thread.

A diagnostic task always runs as **No changes**, in the failed routine's
project, on the Bot's model, whatever the routine itself was allowed to do, and
without the Bot's MCP connections. Like No changes, it needs a Mac server. Each
failed run gets at most one diagnosis, and a diagnosis that fails is not
diagnosed again. Only routine runs that fail count: cancelled, interrupted or
rolled-back runs, routines that could not start, and tasks you asked for
directly are not diagnosed, and neither are runs that failed before you turned
the setting on. Turning it off, detaching or archiving starts no new diagnoses;
cancel a running one from its card.

### Alerts and remit

**Alerts**, in a Bot's settings, limits how often its own work may notify your
phone. It counts results of work you didn't start yourself: scheduled routines,
diagnoses, and tasks or routine runs the Bot started without a message from you.
A task you asked for in the conversation and a routine you ran with **Run now**
always alert at once and never count.

- **Alerts per day** (3 by default) counts per day in the server's time zone.
  Type any whole number. With 0, every counted alert is held.
- **Quiet hours** (22:00 to 07:00 server time by default) hold every counted
  alert. You can change the times or turn them off.

Held alerts are not dropped. They arrive as one alert for the Bot when quiet
hours end, or at the start of the next day when quiet hours are off. That alert
does not count against the next day's limit, and tapping it opens the Bot's
conversation. The settings show how many alerts went out today and how many
are held.

**Remit** is up to 500 characters, in your words, on what deserves a Waiting
item and what doesn't, for example "Only school deadlines and bills need me".
The Daily Home check and early checks follow it when they choose what to add
to Waiting. It gives the Bot no other permissions.

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

## Earlier conversation

After a compaction or a fresh start, older messages are no longer in the Bot's
context, but they are still in its conversation. When you ask about something
discussed earlier, the Bot searches its own conversation for that project, from
the conversation itself or from one of its task threads, and links the message
it answers from. The search never reaches other Bots, other projects or your
other threads, and messages another agent sent into the conversation are not
searched. On web and desktop the link opens the conversation at that message;
on mobile it opens the conversation.

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
  entries appear under **Learning for all projects** in settings. **Apply to
  all projects** moves a project's entry there; restore its earlier version to
  move it back. If all projects already have the same entry, that one stays
  and the project's copy is retired. A proposal that would move an entry says
  so, and the entry stays in its project until you adopt it.
- When a second project learns a lesson another project already has, the Bot
  marks the newer one **Suggested for all projects**, in settings and in that
  conversation's memory notices. Nothing moves until you choose **Apply to all
  projects**, which also retires the other project's copy. **Dismiss** keeps
  the lesson where it is and the suggestion does not come back for it; **Show
  again** undoes that. The Bot finds lessons with the same wording on its own,
  and reworded ones during nightly maintenance.
- **Edit** rewords an entry as a new version, so its earlier wording stays in
  its history.
- **Retire** stops an entry, and **Restore** brings back an earlier version.
  A proposal made against a version that has since changed is marked outdated
  instead of being applied. The same lesson is not recorded twice.

**Maintenance**, under each project in **Settings → Bots**, reviews that
project's new messages and newly finished tasks once a night at 03:00 server
time and records lessons by the same **Learning** option. It needs the Bot on a
signed-in Codex or Claude model, and starts with what comes after you turn it
on. It always uses the Bot's own provider and model, never another one. A night
is skipped while the Bot's conversation or its tasks are still busy, while the
conversation is snoozed or archived, while maintenance is paused, or
while its model can't run.

**Run now**, under the Maintenance switch, runs the same pass right away, for
example after you corrected the Bot. Each step holds back for the same reasons
a night is skipped, and when the pass ends it shows what it learned, whether the
working notes were refreshed and whether the conversation was compacted. It does
not start while a pass is already running for that project.

Once the lessons and the Bot's working notes are saved, maintenance compacts a
long Bot conversation's context, so the next day starts small. The conversation
and its history stay as they were. A message you send before compaction starts
skips it for that night. Your Codex or Claude hooks run on the Bot's
conversation turns, including this compaction, and not on No changes routines,
the working notes refresh, the Daily Home check or the learning step.

The learning step is one model call without tools. When Claude's answer does not
fit the expected format, Claude Code asks it again, up to three answers in all;
more than that and the step fails for the night. On Claude it needs a Mac
server and Claude Code 2.1.331 or later, and it loads none of your Claude
settings: no hooks, plugins, skills, MCP servers, permission rules or
`CLAUDE.md` files, and it leaves no Claude session behind. Three things are
outside that seal:

- Settings your organization manages for Claude Code still apply, including its
  hooks and instructions, because Claude has no switch to turn them off.
- Claude Code adds its own context to every call, such as your account's email
  address and the empty temporary folder the call runs in.
- Claude Code's own background requests, for example its usage check, run as in
  every Claude process.

Because your Claude settings stay out, maintenance is unavailable on a Claude
Bot whose `settings.json` or `--settings` launch argument chooses its own API
backend, model mapping or key helper, where those settings can't be read, where
that argument or `CLAUDE_CONFIG_DIR` is a relative path, or where your
organization manages Claude's MCP servers. Otherwise the call could reach a
different service than the Bot's own turns. Set the backend in the provider's
environment in **Settings → Providers** instead, and give settings files and the
Claude config directory as absolute paths. A project's own Claude settings are not read
for this call, so a backend set only there applies to the Bot's turns in that
project and not to the learning step.

**Daily Home check**, next to Maintenance, has the Bot look over that
project's conversation once a day at the time you choose (08:00 server time by
default). It adds to **Waiting on you** what needs your decision or preparation
before the next check, each item quoting your message or naming its task, and
does nothing else: it starts no task and sends nothing. When it adds something,
the conversation turns unread; when there is nothing to add, you notice
nothing. A check waits until the conversation has been quiet for ten minutes,
skips while it is snoozed or archived, and runs only once after days the server
was off. It needs a Mac server, with Codex or with Claude Code 2.1.327 or later.
On Claude the check has no built-in tools at all, only T3 Code's tools for
reading the Home and adding to Waiting on you; your Claude MCP servers, plugins,
hooks, skills and permission rules can't give it more.

**Check early after finished work**, under the Daily Home check, runs the same
check soon after a routine, a diagnosis or a task you asked for finishes or
fails, so a decision it needs reaches Waiting on you the same day. Work that
finishes close together gets one check, once the conversation has been quiet
for ten minutes. A task that reports back to the conversation on its own, and
work that was cancelled, skipped or interrupted, do not count, and a failed
routine that **Diagnose failed routines** looks into waits for its diagnosis. A
Bot gets at most two early checks in any 24 hours across its projects, at least
an hour apart. What does not fit waits until an early check is allowed again or
the daily check runs, whichever comes first; a daily check covers everything
still waiting. An early check that fails still counts. It only works while the
Daily Home check is on and starts with work that finishes after you turn it on.

The Bot gets its current learning at the start of each turn, not its whole
history: at most 40 entries or 8,000 characters, your instructions first and
then the newest. Each project's **Learning** section previews the next turn
there: how many entries are in context, how many characters they use, and
which entries are on demand, so the Bot reads them only when it looks them up.
Retire or merge entries to make room. Learning does
not add preferred sources, settle project decisions or
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
this Bot may use. **Add connection** there adds a new one and gives it to this
Bot in one step. The Bot's conversations, tasks, routines, forks and subagents
load exactly those connections. So do threads the Bot starts with T3 Code's
tools, such as a new thread or a delegated task on this environment. Turn on
**Use my own Codex MCP servers** to load the MCP servers in your Codex config
as well; the switch lists them by name. A change applies from the Bot's next
turn. Connections work on Codex, Claude and Pi Bots; the switch needs a Codex
model, and a Claude or Pi Bot can only turn it off. A disabled connection stays granted but does not load until you enable it
again. A granted connection that can't start leaves its tools out, the turn runs
on, and the conversation says which connection it was. On Codex, T3 Code also
asks Codex which MCP servers the Bot's conversation loaded. If it loaded one the
Bot may not use, nothing runs and the conversation names that server.

On Pi, a changed connection or a renewed sign-in reconnects that connection at
the Bot's next turn, without restarting Pi. OAuth connections work on Pi:
T3 Code signs in and hands Pi the current token.

On Claude, a changed connection or a renewed sign-in restarts Claude at the
Bot's next turn. While the conversation still runs background agents or
commands, that turn is refused until they finish or you stop them. Removing a connection takes it away from every Bot that uses it; the
catalog shows which Bots those are and asks first.

These grants choose the connections loaded in the Bot's threads. They do not
limit which T3 Code features you can ask the Bot to use. Work a Bot delegates to
another environment runs with that environment's own setup, and a message the
Bot sends to one of your existing threads leaves that thread's setup unchanged.

A No changes routine uses only the tools a connection's server marks as
read-only. T3 Code cannot check that mark.

### Signing in with OAuth

For a service that signs you in with your account, such as a mail or calendar
server, choose **Add connection**, enter its URL, keep **Sign in with OAuth**
and choose **Connect**. Your browser opens the service's sign-in, and the
connection shows **Connected** once you finish. T3 Code keeps the tokens on the
environment and renews them on its own. For a second account of the same
service, add a second connection and sign in with the other account.

- **Use your own OAuth app** is for services that do not let T3 Code register
  itself. Enter the client ID and, if the app has one, its secret, and add the
  redirect URI shown there to the app in the service's developer settings.
- When the browser cannot reach the environment, for example a remote
  environment on plain http, the browser ends on a page that cannot load. Copy
  that page's address and paste it into the field T3 Code shows. The desktop
  app catches it for you.
- A **Signed out** connection, because you disconnected it or the service ended
  access, stays granted. Bots run without it until you choose **Reconnect**, in
  the catalog or in the Bot's settings.
- When you reconnect, sign in with the same account as before. T3 Code cannot
  tell which account you chose, and every Bot granted the connection gets the
  account you sign in with. If your browser is already signed in to another
  account of that service, switch accounts on the sign-in page.
- A sign-in that expires in the middle of a long turn fails that connection's
  later calls in that turn. The next turn renews it.

### Calendar (this Mac)

On a Mac with macOS 14 or later and the T3 Calendar Helper installed,
**Settings → MCP connections** lists **Calendar (this Mac)**. It reads the
calendars in Apple Calendar on that Mac, including Google and other accounts
synced into it. Elsewhere it explains why it is missing.

1. On the Mac itself, choose **Set up**, then **Check**. If access was never
   decided, choose **Connect Calendar** and allow Full Access for T3 Calendar
   Helper. From a phone or another computer, the dialog shows the state but
   setup has to happen on the Mac. A denied request is changed in System
   Settings > Privacy & Security > Calendars.
2. Select the calendars any Bot may read and choose **Save selection**. To make
   a selected calendar eligible for writing, check **Allow changes** beside
   that calendar.
3. Grant **Calendar (this Mac)** in a Bot's **MCP connections**. The Bot starts
   with **Read** access to every selected calendar. Uncheck calendars below the
   grant to limit this Bot to the rest, for example only your work calendar.
   **Use all selected calendars** undoes that. Turn on **Allow calendar
   changes** to grant **Read and write**.

A Bot that uses every selected calendar also gets calendars you select later. A
Bot limited to some calendars does not until you check them for it. A calendar
you remove from the selection is gone for every Bot, and selecting it again
does not give it back to Bots that were limited.

The Bot can then list events from its calendars, at most 14 days and
100 events per request: in its conversation, tasks, routines and No changes
routines, but not in the Daily Home check. It sees each event's title,
calendar, start, end and whether it lasts all day, never notes, attendees,
locations or links. Without calendars, or while disabled, the Bot runs
without it.

With **Read and write**, a Bot can create, rename, move in time, or delete
individual events in its calendars that allow changes. Events with guests
and recurring events are excluded. In a Home turn you start, the Bot can also
change events you created. A routine set to **Changes allowed** can change or
delete events that Bot created. No changes routines and Home checks cannot
write to calendars. A Bot can make up to three calendar changes per turn.

To revoke writing, turn off **Allow calendar changes** for that Bot or clear
**Allow changes** for the calendar. If a write times out, check the calendar
before asking the Bot to try again.

## Current limits

- Bots run on Codex, Claude and Pi only.
- On Codex, MCP connections apply only to Codex 0.166.0 or later on a macOS or
  Linux server. With other Codex setups, a Bot without connections uses Codex's
  own MCP setup, and a Bot with connections does not run.
- On Claude, MCP connections apply only on a macOS server. Elsewhere a Claude
  Bot with connections does not run; one without loads only T3 Code's own tools.
- On a Claude Bot, plugins and hooks your organization manages for Claude still
  load, in No changes routines, Home checks and maintenance too. Own MCP servers
  are not available.
- On a Claude Bot, maintenance needs a Mac server and Claude Code 2.1.331 or
  later.
- On Pi, MCP connections apply only on a macOS server. Elsewhere a Pi Bot with
  connections does not run; one without loads only T3 Code's own tools. A Pi Bot
  runs without your Pi extensions and packages, so a model or tool that comes
  from one is not available to it. No changes routines, the Daily Home check,
  Diagnose failed routines, maintenance and own MCP servers are not available.
  A granted connection that can't start on Pi leaves its tools out without the
  conversation naming it.
- Bots turn off Claude's automatic memory.
- Built-in email connections are not available. Calendar (this Mac) uses Apple
  Calendar on the Mac that runs the environment.

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
