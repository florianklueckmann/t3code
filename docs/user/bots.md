# Bots

A Bot is a named agent with its own instructions and model. Attach it to a
project, and it keeps one conversation there that you come back to, instead of
starting a new thread each time. One Bot can serve several projects, each with
its own conversation, guidance and preferred sources.

## Set up a Bot

Open **Settings → Bots** and choose **New Bot**. Give it a name, instructions
for how it should work and answer, a model, and a **Learning** option (see
[Current limits](#current-limits)). Then attach it to a project
under **Projects**. T3 Code starts the Bot's conversation in that project,
titled with the Bot's name and using the project's default permission mode.

To open a conversation, choose **Open conversation** next to the project in
**Settings → Bots**, or search the command palette for the Bot or project name
and pick **Open \<Bot\> in \<project\>**. Both work on web, desktop and mobile.

Changes to a Bot's instructions, guidance or sources apply from its next turn,
including in conversations that are already running. Changing its model
switches all of its attached conversations to that model.

## Project guidance and preferred sources

Each attached project has its own **Guidance** and **Preferred sources**. Guidance
is what the Bot should know about this project. Preferred sources are where it
should look first, such as a folder, a URL or a tool. Both apply only to that
project's conversation.

Preferred sources are a preference, not a limit. The Bot can still use other
sources when they help, and looking something up elsewhere once does not add
that source to the list. To make a source a default, add it in
**Settings → Bots**, or ask the Bot to record it for the project (see
[Agents and Bots](#agents-and-bots)).

## Current limits

- Bots run on Codex models only. If you switch a Bot conversation to another
  provider, its turns fail until you switch back.
- The **Learning** setting is saved with the Bot but has no effect yet. Bots do
  not learn from their conversations on their own.
- Bots do not run routines or scheduled work on their own.

## Detach and archive

**Detach** stops the Bot in one project. Its conversation there is archived, and
its guidance and sources are kept. **Reattach** brings back the same conversation
with its history, switched to the Bot's current model.

**Archive** stops the Bot everywhere and archives all of its conversations. An
archived Bot cannot be edited or attached to projects. **Restore** brings back the
Bot and the conversations of its attached projects. Bots cannot be deleted.

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
