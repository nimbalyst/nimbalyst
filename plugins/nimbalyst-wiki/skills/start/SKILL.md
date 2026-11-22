---
name: start
description: "Start using Nimbalyst Wiki: show how agents build a local wiki, capture decisions, track typed pages, open the local browser view, and optionally use a team wiki. Use when the user asks what this plugin does, which skills it has, or how to begin."
argument-hint: "[optional goal]"
---

Give a short tour of Nimbalyst Wiki and point at the next step. Do not write any pages in this skill.

Say, in a few lines:

1. Nimbalyst Wiki is a local wiki your agents write for you, so you can think, organize, and set direction.
2. Best first step: `/nimbalyst-wiki:setup`. The agent builds the first wiki from this repository: Home, a writing guide, and starter pages.
3. The habit: at the end of a session, `/nimbalyst-wiki:capture` records what was decided in the page it affects.
4. Before working in an area, `/nimbalyst-wiki:recall` (or asking "what did we decide about X?") answers from the wiki's pages and decisions.
5. Growth paths: typed pages and tables to track things; reading and editing the wiki in the browser (ask "open the wiki in my browser"; the agent calls `openWikiInBrowser`, nothing to install); and optionally connecting a Nimbalyst Team wiki later (`/nimbalyst-wiki:connect`). A local wiki can be moved to Nimbalyst Teams later in one step with `/nimbalyst-wiki:team`, which also invites teammates; they need nothing installed to read it in the browser.

If the user gave a goal, tailor the next step to it. Check whether a local wiki already exists in this repository; if it does, suggest `capture` or asking a question about it instead of `setup`.

Mention the team add-on and its sign-in (the `team` skill installs `nimbalyst-wiki-team`) only if the user chooses the team wiki. The local wiki needs no account. Do not say the install runs onboarding by itself; it does not. The README has the full guide.
