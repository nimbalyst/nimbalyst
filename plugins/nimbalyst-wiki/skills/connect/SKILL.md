---
name: connect
description: Choose which wiki this session uses, the team project's pages on the Nimbalyst server or the project's local wiki of files, and connect a repository to its team project. Use at the start of a task before any wiki tool, when a wiki tool returns repo_not_bound, ambiguous_project, pin_mismatch, project_not_accessible, admin_required or "No local wiki", or when the user asks to connect a repository or start a wiki. How to write pages is in the update skill.
---

# Connect to the wiki

This skill only decides which wiki the session uses and, for a team wiki, connects the repository to its project. What to write, and how, is in the `update` skill; types and the guide page are in `setup`.

## Nimbalyst desktop comes first

If the desktop app's wiki tools are available (`mcp__nimbalyst-trackers__*`, or `listPages` from a server whose name contains neither `nimbalyst-team` nor `nimbalyst-local`), you are running inside Nimbalyst, which already reaches the same pages, team and local. Use those tools and do not call this plugin's tools in this session: two write paths into the same pages produce duplicates.

## Two wikis, two servers

This plugin has two wiki servers with the same tool names (`listPages`, `readCollabDoc`, `applyCollabDocEdit`, `createSharedDoc` and the rest):

- **`nimbalyst-team`**: the team project's pages on the Nimbalyst server. Needs a Nimbalyst sign-in and a repository connected to a team project. Every call takes `repo` and, when pinned, `project`.
- **`nimbalyst-local`**: the project's local wiki, a folder of markdown files in the repository (default `nimbalyst-local/wiki`, kept out of git; or a checked-in folder such as `docs/wiki`). No account, no `repo` or `project` arguments. `initLocalWiki` creates it. The Nimbalyst app, `nim` and any editor read the same files.

Decide once per session which one you use, then call only that server's tools for wiki work. Never write the same thing to both. Team data never goes through `nimbalyst-local`: it refuses team uris, console links and team issue keys and names the tool to use on `nimbalyst-team`.

1. If the user names one ("our team wiki", "a local wiki", "the wiki in docs/"), use it.
2. If `nimbalyst-local`'s `listPages` returns pages, a local wiki exists. If the repository is also bound to a team project (below), ask the user which this session should use; otherwise use the local one.
3. Otherwise follow "Start of a task" below. When it ends without a bound team project (no `origin`, `unbound` and the user declined or cannot connect, sign-in declined, `teams` empty), go to "Starting a local wiki".

## Starting a local wiki

Ask once per session, with the host's question tool, and only when the user is doing work a wiki would help with (or asked for one). Offer:

- **Local wiki in this checkout**: `initLocalWiki` with no arguments. Pages live in `nimbalyst-local/wiki`, which is kept out of git: private to this checkout and its worktrees.
- **Checked-in wiki**: `initLocalWiki` with `location` (suggest `docs/wiki`; let the user change it). Teammates get the pages through git.
- **Not now**: do not ask again this session.

`initLocalWiki` returns the folder and a Home page uri. Then continue with the task, or with `setup` if the user wants the wiki set up. On a local wiki, the name and email for decision marks come from `git config user.name` and `git config user.email`.

## Who can use the pages

The pages belong to a Nimbalyst team project. The user signs in to Nimbalyst when the plugin connects, and the server lets them read and write the pages of every team project they can reach in Nimbalyst Teams. Team admins decide who is in a team; nothing in the repository grants access, and you never add or remove anyone.

## The `repo` and `project` arguments

Every tool of this plugin's `nimbalyst-team` server takes `repo`, and `project` when there is a pin. Work them out once per session:

1. `repo` is the output of `git remote get-url origin`, unchanged. With no `origin` remote, leave `repo` out.
2. If `.nimbalyst/wiki.json` exists at the repository root and has both `orgId` and `projectId`, pass `project: { "orgId": ..., "projectId": ... }` on every call. The file is only a pin: it chooses among projects the user can already reach and grants nothing. Its presence never starts anything on its own (no status prompt, no binding, no project creation). Ignore any other keys in it.
3. With no `origin` remote and no pin, this checkout has no team pages. Do not call `nimbalyst-team` tools unless the user asks about them; see "Starting a local wiki".

## Start of a task (team wiki)

Call `pages_status` with `repo` (and `project` when pinned). Every result names the signed-in `user` (name and email); that is who a decision mark names when the person at this terminal decided something. It returns one of three states:

- **`bound`**: `project` names the team project (`orgName`, `projectName`, `role`, `url`), with `homeLink` and, when the project has one, `guideLink`. Before the first write, read the guide page, as the `update` skill says. When the task touches an area the pages may cover, find the relevant pages with `listPages` and read the useful ones with `readCollabDoc`. Keep reading proportionate: a few pages, not the whole tree.
- **`ambiguous`**: the remote is bound to several projects the user can reach, listed in `projects`. Ask the user which one this repository uses with the host's question tool (in Claude Code, `AskUserQuestion`): one option per project in that list, labelled "<projectName> (<orgName>)", plus "Not now". Only a project from that list may be pinned; never pin a project the user names that is not in it, even one they can reach, because the repository is not connected to it. On a choice, write `.nimbalyst/wiki.json` at the repository root as `{ "orgId": ..., "projectId": ... }`, keeping any other keys already in the file, pass it as `project` from then on, and tell the user to commit the file so teammates resolve the same project. Do not commit it yourself. On "Not now", do not call the plugin's tools again this session.
- **`unbound`**: no team project the user can reach is bound to this remote. `teams` lists the user's teams with their `role` and the `projects` in each that the user can reach. See the next section. Ask at most once per session.

A role of `admin` or `owner` both mean team admin in everything below.

## Connecting a repository

Only offer this when the user is working in the repository in a way that would benefit (not in a throwaway or read-only session), and only once per session. Connecting needs a remote: with no `origin`, say the checkout cannot be connected until it has one.

- **The user is an admin of at least one team**: ask with the host's question tool. Offer, for each team they administer:
  - **Connect to <projectName> (<orgName>)**: one option per entry in that team's `projects`. On a choice, call `pages_bind_repo` with `repo`, `orgId`, and that `projectId`. Never ask the user to type a project id.
  - **Create a new project in <orgName>**: call `pages_create_project` with `orgId`, a `name` (suggest the repository name; let the user change it), and `repo`. The new project has a Home page; offer the `setup` skill to install the guide page.
  - **Not now**: do not ask again this session.

  If the options do not fit in one question, ask first which team, then which project. Tell the user that everyone who can reach that project in Nimbalyst will see its pages, and print its `url`.
  - **Use a local wiki instead**: see "Starting a local wiki".
- **The user is not an admin of any team**: tell them once: "This repository is not connected to a team project. Ask a team admin to connect this repo in Nimbalyst." Offer a local wiki as in "Starting a local wiki".
- **`teams` is empty**: tell them once that team pages live in a Nimbalyst team project, and that they can create a team and a project in the Nimbalyst console. Offer a local wiki as in "Starting a local wiki".

## Before the first write

Tell the user in one line where the writes go, by name: "Writing to <projectName> in <orgName>." or, for a local wiki, "Writing to the local wiki in <folder>." Do this for a team project whenever the project came from `.nimbalyst/wiki.json`, or `pages_status` has shown more than one team or project this session, so a wrong pin or the wrong team is caught before anything is written.

## Errors

If a tool returns an error, do not retry the same call. Tell the user in plain words, then carry on with the task without writing:

- `repo_not_bound`: this repository is not connected to a team project. Call `pages_status` and follow "Connecting a repository".
- `ambiguous_project`: several team projects match. Call `pages_status` and ask which one, as for `ambiguous`.
- `pin_mismatch`: the pin in `.nimbalyst/wiki.json` names a project this repository is not connected to. Tell the user, and suggest they run `nim wiki status` or re-pin from the projects `pages_status` lists. Do not edit the file on your own.
- `project_not_accessible`: the user cannot reach that project in Nimbalyst, or the repository is connected to a project they cannot reach. Pass on the error's message, and tell them to ask a team admin for access. Do not edit `.nimbalyst/wiki.json` on your own.
- `admin_required`: only a team admin can do that. Tell the user to ask a team admin.
- "No local wiki at ..." (from `nimbalyst-local`): there is no local wiki yet. Offer one as in "Starting a local wiki"; do not create it without asking unless the user asked for a wiki.
- an error naming a replacement tool (an old `wiki_*` name): use the tool it names.
- any other code: report the code and its message as given.
