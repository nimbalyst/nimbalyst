<p align="center">
  <a href="https://nimbalyst.com/wiki/coding-agents/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
      <img src="docs/images/logo-light.svg" alt="Nimbalyst" width="220">
    </picture>
  </a>
</p>

<h1 align="center">Nimbalyst Wiki</h1>

<p align="center">
  <b>A local wiki your coding agents write for you, so you can think, organize, and set direction.</b>
</p>

<p align="center">
  A Claude Code and Codex plugin that turns your sessions into a markdown wiki in your repo,<br>
  with every decision recorded in the page it affects.
</p>

<p align="center">
  <a href="https://github.com/nimbalyst/nimbalyst-wiki/blob/main/.claude-plugin/plugin.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fnimbalyst%2Fnimbalyst-wiki%2Fmain%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=2563eb" alt="Plugin version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href="#claude-code"><img src="https://img.shields.io/badge/Claude%20Code-plugin-D97757" alt="Claude Code plugin"></a>
  <a href="#codex"><img src="https://img.shields.io/badge/Codex-plugin-111111" alt="Codex plugin"></a>
  <a href="#other-agents"><img src="https://img.shields.io/badge/MCP-server-6E56CF" alt="MCP server"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933" alt="Node.js 22 or later">
</p>

<p align="center">
  <a href="#get-started"><b>Get started</b></a> &nbsp;·&nbsp;
  <a href="#watch-the-demo"><b>Demo</b></a> &nbsp;·&nbsp;
  <a href="#what-you-can-do"><b>Features</b></a> &nbsp;·&nbsp;
  <a href="#share-it-with-your-team"><b>Teams</b></a> &nbsp;·&nbsp;
  <a href="#common-questions"><b>FAQ</b></a> &nbsp;·&nbsp;
  <a href="#reference"><b>Reference</b></a> &nbsp;·&nbsp;
  <a href="#feedback-issues-and-contributing"><b>Contribute</b></a> &nbsp;·&nbsp;
  <a href="https://nimbalyst.com/wiki/coding-agents/"><b>Website</b></a>
</p>

<br>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.webp">
    <img src="docs/images/hero-light.webp" alt="Claude Code building the wiki with the Nimbalyst Wiki plugin, and the same wiki open in the browser with the Home page and the page tree" width="900">
  </picture>
</p>

Overwhelmed and disorganized working with agents? Your agent distills what you worked on into a wiki of plain markdown files: a Home page, the decisions you made and why, open questions with owners, and the things you track. You read and edit it in your browser, and every agent you use works on the same files.

<table>
  <tr>
    <td width="50%" valign="top"><b>Files in your repo</b><br>Text pages are markdown files in your project. By default the wiki lives in <code>nimbalyst-local/wiki</code>, kept out of git so it stays private to you. Put it in a checked-in folder like <code>docs/wiki</code> to diff and commit it like code.</td>
    <td width="50%" valign="top"><b>Stays on your machine</b><br>A local wiki needs no account and no server. The browser view listens on your machine only and is protected by a token.</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><b>One wiki across every agent</b><br>Claude Code, Codex, Cowork, Cursor and VS Code all use the same tools on the same files, so you can switch agents without losing what they wrote.</td>
    <td width="50%" valign="top"><b>Drawings, sheets and mockups too</b><br>Drawings, mind maps, spreadsheets, data models, mockups and canvases are pages too. Each keeps its own file, such as <code>.excalidraw</code>, <code>.csv</code>, <code>.prisma</code> or <code>.mockup.html</code>, so other tools can still open it.</td>
  </tr>
</table>

---

## Watch the demo

https://github.com/user-attachments/assets/ee9437ab-bbeb-4f3d-9d65-78e9afe24f47

<p align="center">
  <sub>The wiki in Claude Code and your browser, from installing the plugin to editing a page.</sub>
</p>

---

## Get started

You need Node.js 22 or later on your `PATH`, with the npm that comes with it. You don't need the Nimbalyst app or an account.

### 1. Install the plugin

#### Claude Code

```
/plugin marketplace add nimbalyst/nimbalyst-wiki
/plugin install nimbalyst-wiki@nimbalyst-wiki
```

#### Codex

```sh
codex plugin marketplace add nimbalyst/nimbalyst-wiki
codex plugin add nimbalyst-wiki@nimbalyst-wiki
```

Using Cursor, VS Code, Cowork or the Codex app? See [Other agents](#other-agents). The team wiki's add-on comes later, only when you [share the wiki with your team](#share-it-with-your-team).

### 2. Build the wiki

```
/nimbalyst-wiki:setup
```

Claude asks who the wiki is for, then writes a Home page, a writing guide and starter pages from your README and docs, as markdown files in your repo. In Codex, ask it to "set up a wiki for this repo." For a short tour first, run `/nimbalyst-wiki:start`.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/setup-dark.webp">
    <img src="docs/images/setup-light.webp" alt="Claude Code after installing the Nimbalyst Wiki plugin, with /nimbalyst-wiki:setup typed at the prompt" width="700">
  </picture>
</p>

### 3. Capture what you decided

```
/nimbalyst-wiki:capture
```

At the end of a session, capture writes each decision into the page it affects, with who decided, when and what was passed over, and records open questions with their owners. Claude Code reminds the agent once to capture after a session with a commit, a plan or several file edits.

### 4. Open it in your browser

Ask your agent to "open the wiki in my browser," with nothing to install. You get the page tree and the page editor, and you can edit pages, drawings, mind maps, spreadsheets and mockups. Edits save straight to the files, and what your agent writes shows up live. From a terminal, run `nim wiki serve` (see [`nim` command line](#nim-command-line)).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/home-dark.webp">
    <img src="docs/images/home-light.webp" alt="The wiki Home page in the browser, with the page tree on the left and links to every area of the wiki" width="900">
  </picture>
</p>

> [!TIP]
> **Using Codex?** Codex does not run plugin hooks, so there is no end-of-session reminder; ask it to "record what we decided in the wiki." Session citations read Claude Code transcripts only, so decisions recorded from Codex carry your name but no quote.

---

## What you can do

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Decisions in the page they affect</h3>
      Each decision is marked with who decided, when and what was not chosen.
      <br><br>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/retries-dark.webp">
        <img src="docs/images/retries-light.webp" alt="The Payment retries page in the browser, with two decisions marked with who decided, when and what was not chosen">
      </picture>
    </td>
    <td width="50%" valign="top">
      <h3>What is decided and what is still open</h3>
      An index page links to every decision and open question, so you can catch up in a few minutes.
      <br><br>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/decisions-dark.webp">
        <img src="docs/images/decisions-light.webp" alt="The Decisions and open questions page in the browser, listing what was decided and what is still open">
      </picture>
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <h3>Track things with types</h3>
      Ask your agent to track competitors, customers or features, and it creates a type with the fields you care about. Each item gets its own page with those fields at the top, and the type keeps a table of every item.
      <br><br>
      <code>Track our competitors in the wiki: category, threat, setup speed and payment recovery for each.</code>
      <br><br>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/types-dark.webp">
        <img src="docs/images/types-light.webp" alt="The Competitors type in the browser, a table listing Cartwell, Paylane and Tillpoint, each one its own page">
      </picture>
    </td>
  </tr>
</table>

You can also just ask: "what does the wiki say about auth?", "add a page about our deploy process", "open the wiki in my browser".

---

## Add drawings, mind maps, spreadsheets and more

Pages hold more than text. Ask your agent for a drawing, a mind map, a spreadsheet, a data model, a mockup or a canvas, and it builds the page in your wiki. Open any of them in your browser to edit, or start one yourself from the New page menu.

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Drawings</h3>
      Excalidraw drawings for flows and architecture. Your agent places the shapes and arrows, and you move them around in the browser.
      <br><br>
      <code>Draw the payment retry flow as a page under Payment retries.</code>
      <br><br>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/editor-drawing-dark.webp">
        <img src="docs/images/editor-drawing-light.webp" alt="An Excalidraw drawing of the payment retry flow open in the wiki browser view">
      </picture>
    </td>
    <td width="50%" valign="top">
      <h3>Mind maps</h3>
      Mind maps for open questions, risks and brainstorms, with nodes you add, move and fold.
      <br><br>
      <code>Make a mind map of the open questions and risks for retries.</code>
      <br><br>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/editor-mindmap-dark.webp">
        <img src="docs/images/editor-mindmap-light.webp" alt="A mind map of open questions and risks for payment retries open in the wiki browser view">
      </picture>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Spreadsheets</h3>
      CSV spreadsheets your agent fills in and you sort and edit like any other sheet.
      <br><br>
      <code>Add a spreadsheet of retry outcomes by decline code.</code>
      <br><br>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/editor-spreadsheet-dark.webp">
        <img src="docs/images/editor-spreadsheet-light.webp" alt="A spreadsheet of retry outcomes by decline code open in the wiki browser view">
      </picture>
    </td>
    <td width="50%" valign="top">
      <h3>Data models</h3>
      Data models from a Prisma schema, drawn as tables and relations you can rearrange.
      <br><br>
      <code>Model the retry attempts we store as a data model page.</code>
      <br><br>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/editor-datamodel-dark.webp">
        <img src="docs/images/editor-datamodel-light.webp" alt="A data model of payment retry attempts open in the wiki browser view">
      </picture>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Mockups</h3>
      HTML mockups of screens, so a decision about the UI sits next to a picture of it.
      <br><br>
      <code>Mock up the retry settings screen.</code>
      <br><br>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/editor-mockup-dark.webp">
        <img src="docs/images/editor-mockup-light.webp" alt="A mockup of the retry settings screen open in the wiki browser view">
      </picture>
    </td>
    <td width="50%" valign="top">
      <h3>Canvases</h3>
      Canvases that lay pages out side by side, with each card a live view of its page.
      <br><br>
      <code>Put the retry pages together on one canvas.</code>
      <br><br>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/editor-canvas-dark.webp">
        <img src="docs/images/editor-canvas-light.webp" alt="A canvas laying out the payment retry pages side by side in the wiki browser view">
      </picture>
    </td>
  </tr>
</table>

---

## Share it with your team

Start with a local wiki and move it to [Nimbalyst Teams](https://nimbalyst.com/wiki/teams/) when your team needs it. Your text pages, typed pages, types and the links between them move to a team wiki where everyone edits the same pages in their browser and every teammate's agents write into it. Your local files stay where they are.

- Sign in with your Google account.
- Create a team and invite teammates by email.
- The team wiki runs on Nimbalyst's servers on Cloudflare, at [console.nimbalyst.com](https://console.nimbalyst.com).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/team-home-dark.webp">
    <img src="docs/images/team-home-light.webp" alt="The team wiki home page in the Nimbalyst web console, with the page tree, the open questions that need the team and recently decided items" width="900">
  </picture>
</p>

### Upgrade a local wiki to a team wiki

The team wiki uses a separate add-on plugin, `nimbalyst-wiki-team`. It holds the `nimbalyst-team` server and the Nimbalyst sign-in, and it is separate so a local wiki never asks you to sign in. You don't need to install it ahead of time: the team skill offers to install it when you share the wiki.

#### Claude Code

Update the plugin to 0.8.0 or later (see [Updating the plugin](#updating-the-plugin)), then run the team skill, with your team's name if you like:

```
/nimbalyst-wiki:team Northwind
```

You can also ask in your own words: "Move this wiki to a team wiki for Northwind." Claude walks you through these steps:

1. **Install the add-on.** Claude asks before it installs `nimbalyst-wiki-team`. Claude Code loads plugins when a session starts, so type `/exit`, then run `claude --continue` in the same folder to come back to the same conversation.
2. **Sign in.** Run `/mcp`, choose `nimbalyst-team` and pick Authenticate. A browser page opens where you sign in to Nimbalyst or create an account. Tell Claude when it says you are connected.
3. **Choose a team and project.** With no team yet, Claude proposes a name and creates the team, its first project and a Home page, connected to this repository's git remote. Already in a team? Connect to one of its projects or create a new one.
4. **Approve the move.** The local server signs in with the same account so pages go straight from your files to Nimbalyst. Claude opens the approval page and you confirm the code.
5. **Move.** Claude shows what will move, then moves pages, typed pages, types, hierarchy, order, fields and links in one step. If it is interrupted, running it again picks up where it stopped.
6. **Invite.** Claude opens the team wiki in your browser and can invite teammates by email, reading the list back to you first, or create an invite link.
7. **Commit the connection.** Commit `.nimbalyst/wiki.json` so your teammates' agents find the same project. Claude also offers to add both plugins to this repository's `.claude/settings.json`, so teammates who open the repository in Claude Code are offered them. Commit that file too.

Your local files are not deleted. They are marked as moved, and the local Home page links to the team wiki.

#### Codex

Ask Codex to "move this wiki to a team wiki." It follows the same steps. When it installs the add-on, sign in from a terminal, then start a new Codex session in the project and ask it to continue:

```sh
codex plugin add nimbalyst-wiki-team@nimbalyst-wiki   # Codex runs this for you after you agree
codex mcp login nimbalyst-team
```

#### From a terminal

The `nim` command line moves the wiki without the add-on:

```sh
nim login
nim wiki team-create "Northwind"
nim wiki move-to-team --dry-run    # preview what will move
nim wiki move-to-team
```

#### Cursor, VS Code, Cowork and other agents

These agents don't use plugins, so there is no add-on to install. Move the wiki from a terminal with the `nim` commands above, or ask your agent to run them for you. `nim login` opens a browser page where you sign in to Nimbalyst, and `nim wiki move-to-team` ends with a link to the team wiki's Home page.

To work on the team wiki from your agent afterward, add the team server to the same MCP config as `nim mcp` (see [Other agents](#other-agents)). Your agent asks you to sign in to Nimbalyst the first time it connects.

```json
{
  "mcpServers": {
    "nimbalyst-team": {
      "type": "http",
      "url": "https://sync.nimbalyst.com/mcp"
    }
  }
}
```

### If you were invited

An invite email or link signs you in to Nimbalyst in the browser and opens the team's wiki. You can read, edit and comment there with nothing installed.

To use the wiki from your agent too, add the marketplace as in [Get started](#get-started), install both plugins and sign in with the same email:

- **Claude Code:** `/plugin install nimbalyst-wiki@nimbalyst-wiki` and `/plugin install nimbalyst-wiki-team@nimbalyst-wiki` (or accept them when Claude Code offers them for the repository), restart Claude Code, run `/mcp`, choose `nimbalyst-team` and Authenticate.
- **Codex:** `codex plugin add nimbalyst-wiki@nimbalyst-wiki` and `codex plugin add nimbalyst-wiki-team@nimbalyst-wiki`, then `codex mcp login nimbalyst-team`.

If the repository has a committed `.nimbalyst/wiki.json`, your agent uses that team project right away; otherwise it finds the project through the repository's git remote.

---

## Common questions

### What should go in it?

Decisions and their reasons, open questions, the preferences and constraints people set, and hard-won lessons. The work itself stays in your sessions, code and trackers, and the wiki links to it. It's the strategic view.

### Where does my wiki live?

In your project, in `nimbalyst-local/wiki` by default, which git ignores. Choose a folder such as `docs/wiki` to check it in and share it through git.

### Do I need an account?

Not for a local wiki. You only sign in to Nimbalyst when you share the wiki with your team.

### Do I need the Nimbalyst app?

No. Your agent, the `nim` CLI and the browser view give you a complete wiki, including drawings, mind maps, spreadsheets, data models, mockups and canvases you can edit in the browser. Open it in the Nimbalyst app when you want the wiki in the same place as your sessions and code.

### What is the Nimbalyst app?

Nimbalyst is the visual workspace for Codex and Claude Code. It runs your agents in parallel sessions and gives you visual editors for the work around them, including tasks, docs, diagrams, mockups, spreadsheets and code, all deeply linked. Every AI edit arrives as a diff you can review. The desktop app is free and open source for individuals, on macOS, Windows and Linux, and Nimbalyst Teams makes it multiplayer.

### Is it the same wiki as the one in the Nimbalyst app?

Yes. The app's Local wiki is the same folder of files, so you can start in your agent and open the app later without moving anything.

---

## Reference

### Skills

| Skill | What it does |
| --- | --- |
| `/nimbalyst-wiki:setup` | Builds the first version of the wiki: Home, the writing guide ("How we write this wiki") and starter pages. It can also define types. Running it again fills gaps and never duplicates or overwrites what people wrote. |
| `/nimbalyst-wiki:capture` | Records what this session decided, answered and left open, in the page each one affects. If nothing is worth keeping, it says so. |
| `/nimbalyst-wiki:recall` | Answers what the wiki says or decided about a question or an area, and which pages cover the code you are about to change. The agent also uses it unasked for a "why did we..." question. |
| `/nimbalyst-wiki:team` | Moves the wiki to Nimbalyst Teams, installing the `nimbalyst-wiki-team` add-on the first time, and invites teammates. See [Upgrade a local wiki to a team wiki](#upgrade-a-local-wiki-to-a-team-wiki). |
| `/nimbalyst-wiki:start` | A short tour of the plugin. |
| `/nimbalyst-wiki:connect` | Chooses which wiki the session uses and connects a repository to a team project. Runs on its own when needed. |
| `/nimbalyst-wiki:update` | The writing guide the agent follows for every wiki edit. You rarely call it yourself. |

### What the plugin installs

Two MCP servers, listed by `/mcp` in Claude Code and `codex mcp list` in Codex:

| Server | What it does |
| --- | --- |
| `nimbalyst-local` | The local wiki and its browser view. Runs on your machine. When you move the wiki to a team, it signs in to Nimbalyst to copy the pages. |
| `nimbalyst-session` | Lets the agent cite what you typed in this session when it records a decision. Reads only this session's transcript, on your machine. |

The team wiki's server, `nimbalyst-team`, is in a separate add-on plugin, `nimbalyst-wiki-team`, so a local wiki never asks you to sign in. `/nimbalyst-wiki:team` installs it when you share the wiki. If you used the team wiki with 0.7.0 or earlier, install the add-on once after updating.

In Claude Code the plugin also adds two hooks. At the start of a session it tells the agent what the local wiki covers and which pages cover files you have changed. When a session with real work ends, it reminds the agent once to run `/nimbalyst-wiki:capture`, naming the pages the session's changes touched.

The plugin itself holds no code. Both servers and both hooks run the [`@nimbalyst/cli`](https://www.npmjs.com/package/@nimbalyst/cli) package from npm through `npx`, pinned to the plugin's version, so its source is published with each release. The first session downloads it, including the browser app; later sessions use npm's cache and work offline.

### What it connects to

- **registry.npmjs.org**, through `npx`, to download `@nimbalyst/cli` at the plugin's version the first time, or after npm's cache is cleared. `npx` follows your npm configuration, including a company registry mirror.
- **raw.githubusercontent.com**, at most once a day, to read the latest plugin version from this repository (see [Updating the plugin](#updating-the-plugin)).
- **sync.nimbalyst.com** and **console.nimbalyst.com**, only for the team wiki: when you sign in, share or move the wiki to a team, or use the `nimbalyst-team` server.

Your pages, your sessions and your code stay on your machine unless you move the wiki to a team.

### Which wiki the agent uses

At the start of wiki work the agent decides once per session:

1. If you name one ("the team wiki", "the local wiki"), it uses that.
2. If the repository has a local wiki, it uses it. If the repository is also connected to a team project, it asks which.
3. Otherwise it checks for a team project connected to this repository's git remote. If there is none, it offers once to start a local wiki: private in this checkout, checked in under a folder you choose, or not now.

It never writes the same thing to both. Team data never goes through the local server.

### How decisions are recorded

A decision is a marked sentence in the page it affects:

```markdown
[We store and evaluate flags in Flagship.]{decided by="Dana Lee" email=dana@example.com on=2026-09-30 over="our own Durable Object store"}
```

- Open questions use the same form with `open`.
- When your own words support a statement, the agent adds a citation copied from the session transcript. It never invents a decision, a reason or a quote.
- On a local wiki the name and email come from `git config user.name` and `git config user.email`.
- Set `NIMBALYST_WIKI_NUDGE_MIN_EDITS` to change how many edits trigger the capture reminder.

### Updating the plugin

Once a day the plugin checks GitHub for a newer version, and if there is one, the agent mentions it the next time it uses the wiki. The check sends nothing about you or your wiki. Set `NIMBALYST_WIKI_NO_UPDATE_CHECK=1` to turn it off.

**With the `nim` CLI installed**, `nim update` updates `nim` and this plugin for Claude Code and Codex in one step, checks that each one is on the new version, and says what to restart. `nim update --check` only reports what is out of date, and `nim doctor` shows which versions are installed.

**Claude Code** updates this marketplace on its own only if you turn on auto-update for it (`/plugin`, then Marketplaces). The Claude desktop app runs Claude Code with its updater turned off, which also stops plugin auto-update there unless `FORCE_AUTOUPDATE_PLUGINS=1` is set. Updating by hand works everywhere; run both commands, then restart Claude Code:

```sh
claude plugin marketplace update nimbalyst-wiki
claude plugin update nimbalyst-wiki@nimbalyst-wiki
```

**Codex:** run `codex plugin marketplace upgrade nimbalyst-wiki` and start a new session.

A session that is already open keeps the version it started with: run `/reload-plugins` or start a new session in Claude Code, and start a new session in Codex.

**Coming from 0.3.0?** That version was installed from the `nimbalyst/nimbalyst` marketplace. Switch to this one so you get updates and the browser view, then restart Claude Code. Your wiki is files in your repository, so nothing in it changes.

```
/plugin uninstall nimbalyst-wiki@nimbalyst
/plugin marketplace remove nimbalyst
/plugin marketplace add nimbalyst/nimbalyst-wiki
/plugin install nimbalyst-wiki@nimbalyst-wiki
```

### Other agents

Cursor, VS Code, Cowork, the Codex app and any other MCP agent.

These agents use the wiki through `nim mcp`, the same local server the plugin runs. Install the `nim` CLI, then add the server to your agent's MCP config:

```sh
npm install -g @nimbalyst/cli
```

| Agent | Config file | Workspace argument |
| --- | --- | --- |
| Cursor | `.cursor/mcp.json` (key `mcpServers`) | `${workspaceFolder}` |
| VS Code, Copilot in agent mode | `.vscode/mcp.json` (key `servers`) | `${workspaceFolder}` |
| Cowork | The Claude desktop app's MCP config (key `mcpServers`) | `/path/to/your/project` |
| Codex app, any MCP client | Your client's MCP config | Your project path |

```json
{
  "mcpServers": {
    "nimbalyst-wiki": {
      "command": "nim",
      "args": ["mcp", "--workspace", "${workspaceFolder}"]
    }
  }
}
```

If the app cannot find `nim`, use the full path that `which nim` prints. Then ask the agent to "start a wiki for this repo." A wiki started in one agent is ready in the others.

To share the wiki with your team from these agents, see [Cursor, VS Code, Cowork and other agents](#cursor-vs-code-cowork-and-other-agents).

These agents get the wiki tools but not the plugin's skills (`setup`, `capture` and the writing guide), so ask for what you want in your own words. Opening the wiki in the browser works from them too: the browser app installs with `nim`.

Installing the plugin does not update this `nim`, and updating `nim` does not update the plugin. Once a day `nim mcp` checks npm for a newer `nim`, and the agent mentions it the next time it uses the wiki. Run `nim update` in a terminal, then start a new session so the agent restarts the server.

### `nim` command line

For scripts and your own terminal. You don't need it to use the plugin. `nim wiki` works on both the local and the team wiki.

```sh
nim wiki init                         # create the wiki in nimbalyst-local/wiki (ignored by git)
nim wiki init --location docs/wiki    # or in a checked-in folder
nim wiki list                         # the page tree
nim wiki read "Product"               # a page by title, path or id
echo "..." | nim wiki write "Notes" --create
nim wiki search "deploy"
nim wiki move "Notes" --parent "Product"
nim wiki serve                        # open the wiki in your browser
nim wiki move-to-team --dry-run       # preview moving the local wiki to Teams
nim update                            # update nim and the Claude Code and Codex plugins
nim doctor                            # which versions are installed, and from where
```

- `list`, `read`, `move` and `search` use the local wiki when the project has one, and the team wiki otherwise. `--team` or `--local` picks one.
- `write` replaces a page body from stdin or `--file`. With `--expected-version` (from `read --json`) it refuses to overwrite a page that changed since you read it.
- `nim wiki serve` uses the browser app that installs with `nim`. `--no-open` prints the URL instead of opening a browser; `--port` picks the port.
- In a terminal, `nim` prints one line when a newer version is published (checked at most once a day, in the background).
- `nim tracker list/get/create/update` work on typed pages in the local wiki.
- Team commands (`status`, `edit`, `create`, `items` and more) need `nim login`. `nim --help` lists them all.

### The files

The wiki is plain files you can read, edit, diff and commit without any Nimbalyst tool. The full contract is [FORMAT.md](../../packages/local-wiki/FORMAT.md).

```
nimbalyst-local/wiki/
  .nimbalyst-wiki.yaml          format version
  Home.md
  How we write this wiki.md
  Product.md
  Personas.md
  Personas/                     a page's children live in a folder of the same name
    CMO.md
    CMO.activity.jsonl          change log of a typed page
  Partners.csv                  a table type: one row per item
  .trash/                       deleted pages, restorable
```

| | |
| --- | --- |
| **Pages** | `<Title>.md` with flat frontmatter: `id` (never changes), `order`, and for a typed page `type` plus its fields. Renaming a page renames its file and its child folder. |
| **Links** | Relative paths that carry the target's id, `[CMO](Personas/CMO.md "id=01M4...")`, so they work on GitHub and in any editor. Nimbalyst rewrites them when a page moves. |
| **Types** | Defined in `.nimbalyst/trackers/<type>.yaml`, stored as one page per item (`storage: pages`) or rows of one CSV (`storage: table`). |
| **Trash** | Deleting moves files to `.trash/`, from where a page can be restored. |
| **Location** | The folder named in `.nimbalyst/local-wiki.json` (`{ "location": "docs/wiki" }`), else `nimbalyst-local/wiki`. Git worktrees share the main checkout's wiki. |

Agents can edit the files directly too. The MCP tools and `nim` add ids, ordering, link rewriting on moves, type fields, CSV rows and trash.

---

## Feedback, issues and contributing

The Nimbalyst Wiki is built from the main [Nimbalyst repository](https://github.com/nimbalyst/nimbalyst) and published here with each release (the `SOURCE` file names the commit). Everything about the wiki is handled in this repository:

- **Star this repository** to follow releases and help other people find it.
- **Report a bug or request a feature** in [Issues](https://github.com/nimbalyst/nimbalyst-wiki/issues/new).
- **Send a pull request** here. We apply accepted changes to the source in the main repository, credit you, and the next release brings them back here, so the pull request is closed rather than merged.

[CONTRIBUTING.md](https://github.com/nimbalyst/nimbalyst-wiki/blob/main/CONTRIBUTING.md) shows where each part of this repository comes from. For the Nimbalyst app itself, use the [main repository](https://github.com/nimbalyst/nimbalyst).

---

## Open it in the Nimbalyst app

The same files open in the free, open-source [Nimbalyst app](https://nimbalyst.com/wiki/local/), with live tables, 2x2s, mockups and diagrams you edit in place, next to your sessions and code. Open **Wiki** in the navigation gutter (Cmd+D) and choose **Local**. Nothing moves: the app reads the same folder your agent writes to. Inside the app, agents already have the wiki tools, and the plugin stands aside so each page has one write path.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/app-dark.webp">
    <img src="docs/images/app-light.webp" alt="The Competitors page in the Nimbalyst app's Local wiki, with a live table of competitors and a 2x2 below it" width="900">
  </picture>
</p>

---

<p align="center">
  <a href="https://nimbalyst.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
      <img src="docs/images/logo-light.svg" alt="Nimbalyst" width="140">
    </picture>
  </a>
</p>

<h3 align="center">Built with love by the Nimbalyst team</h3>

<p align="center">
  The Nimbalyst Wiki is part of <a href="https://nimbalyst.com">Nimbalyst</a>, the open-source visual workspace for Codex and Claude Code, and is built from <a href="https://github.com/nimbalyst/nimbalyst">our main repository</a>. For anything about the wiki, star this repository, file issues and send pull requests here. MIT licensed.
</p>

<p align="center">
  <a href="https://github.com/nimbalyst/nimbalyst-wiki"><b>Star the Nimbalyst Wiki</b></a> &nbsp;·&nbsp;
  <a href="https://github.com/nimbalyst/nimbalyst-wiki/issues/new">Report an issue</a> &nbsp;·&nbsp;
  <a href="https://github.com/nimbalyst/nimbalyst-wiki/blob/main/CONTRIBUTING.md">Contributing</a> &nbsp;·&nbsp;
  <a href="https://github.com/nimbalyst/nimbalyst">Nimbalyst on GitHub</a>
</p>
