# Nimbalyst Wiki

A project wiki that people and coding agents write together. It holds what the team decided and why, in the page each decision affects, with the person's own words cited. Agents read it for context before they work and record what was settled when they finish.

There are two kinds of wiki, and you can use either or both:

- **Local wiki**: a folder of markdown files in your repository. No account, no server. Keep it private to your checkout (`nimbalyst-local/wiki`, ignored by git) or check it in (`docs/wiki`) so teammates get it through git.
- **Team wiki**: a Nimbalyst Teams project's pages, shared live on the Nimbalyst server, with comments, history and access managed by your team.

You can work with the wiki from four places, all on the same pages:

| | Local wiki | Team wiki |
| --- | --- | --- |
| Claude Code (this plugin) | yes | yes |
| Nimbalyst app | Wiki mode, Local section | Wiki mode, Team section |
| `nim` command line | `nim wiki ...` | `nim wiki ...` |
| Browser | `nim wiki serve` | the Nimbalyst web console |

## Claude Code

### Install

In Claude Code:

```
/plugin marketplace add nimbalyst/nimbalyst
/plugin install nimbalyst-wiki@nimbalyst
```

The plugin brings three MCP servers. `/mcp` lists them:

- `nimbalyst-local`: the local wiki. Runs on your machine and needs nothing else installed.
- `nimbalyst-team`: the team wiki on the Nimbalyst server. It asks you to sign in to Nimbalyst the first time you connect it in `/mcp`. Leave it disconnected if you only use a local wiki.
- `nimbalyst-session`: lets Claude cite what you typed in this session when it records a decision. It reads only this session's transcript, on your machine.

### Commands

- `/nimbalyst-wiki:setup` builds a wiki that is useful from day one: it asks a few questions about who the wiki is for, then writes a Home page, the writing guide ("How we write this wiki") and a handful of starter pages from your project's README and docs. It can also define types (below). Running it again fills gaps and never duplicates or overwrites what people wrote.
- `/nimbalyst-wiki:capture` records what this session decided. Claude lists the decisions, answered questions and open questions from the conversation, finds the page each one affects, and writes it there. If nothing is worth keeping, it says so.
- `/nimbalyst-wiki:update` is the writing guide Claude follows for every wiki edit. You rarely call it yourself.

You can also just ask: "start a wiki for this repo", "what does the wiki say about auth?", "add a page about our deploy process".

### Which wiki Claude uses

At the start of wiki work Claude decides once per session:

1. If you name one ("the team wiki", "the local wiki"), it uses that.
2. If the repository has a local wiki, it uses it. If the repository is also connected to a team project, it asks which.
3. Otherwise it checks for a team project connected to this repository's git remote. If there is none, it offers once to start a local wiki: private in this checkout, checked in under a folder you choose, or not now.

It never writes the same thing to both. Team data never goes through the local server.

### How decisions are recorded

A decision is a marked sentence in the page it affects, not a separate record:

```markdown
[We store and evaluate flags in Flagship.]{decided by="Dana Lee" email=dana@example.com on=2026-09-30 over="our own Durable Object store"}
```

Open questions use the same form with `open`. When the person's own words support a statement, Claude adds a citation copied from this session's transcript. It never invents a decision, a reason or a quote. On a local wiki the name and email come from `git config user.name` and `git config user.email`.

After a session with real work in it (a commit, a plan, or several file edits), the plugin reminds Claude once to run `/nimbalyst-wiki:capture` before it stops. Set `NIMBALYST_WIKI_NUDGE_MIN_EDITS` to change how many edits count.

### If you also use the Nimbalyst app

Inside the Nimbalyst app, agents already have the wiki tools, and the plugin stands aside so there is one write path per page.

## Nimbalyst app

Open **Wiki** in the navigation gutter (Cmd+D).

- **Local** is the local wiki of the open project. Pages open as ordinary file tabs. Drawings, mind maps, data models, mockups and spreadsheets can be pages too; each keeps its own file.
- **Team** is the team project's wiki, when the project is shared with a team.
- Pages you kept in the app's older Personal section still show. Use **Export** in the section's menu to copy them into the wiki folder as files. The originals are kept.
- **Copy to Wiki...** on any file in the Files tree copies it in as a page.

The app and `nim` find the wiki the same way: the folder named in `.nimbalyst/local-wiki.json` (`{ "location": "docs/wiki" }`), else `nimbalyst-local/wiki`. In a git worktree the wiki is the main checkout's, so every worktree shares one.

## `nim` command line

```sh
npm install -g @nimbalyst/cli
```

Requires Node.js 22 or later. `nim wiki` works on both wikis.

```sh
nim wiki init                         # create the local wiki (nimbalyst-local/wiki, ignored by git)
nim wiki init --location docs/wiki    # or a checked-in folder
nim wiki list                         # the page tree
nim wiki read "Product"               # a page by title, path or id
echo "..." | nim wiki write "Notes" --create
nim wiki search "deploy"
nim wiki move "Notes" --parent "Product"
nim wiki serve                        # open the wiki in your browser
```

- `list`, `read`, `move` and `search` use the local wiki when the project has one, and the team wiki otherwise. `--team` or `--local` picks one.
- `write` replaces a page body from stdin or `--file`. With `--expected-version` (from `read --json`) it refuses to overwrite a page that changed since you read it.
- Team-only commands (`status`, `edit`, `create`, `items` and more) need `nim login`. `nim --help` lists them all.
- `nim tracker list/get/create/update` work on typed pages in the local wiki.
- `nim mcp` runs the local wiki's MCP server on stdio, for agents other than Claude Code: `claude mcp add nimbalyst-local -- nim mcp` is the equivalent of the plugin's local server.

### `nim wiki serve`

Opens the local wiki in your browser to read and edit: the page tree, pages in the same editor as the app, typed pages with their fields, and type tables. Edits save straight to the files, and changes made in your editor or by an agent show up live.

The server listens on this machine only and requires the token in the URL it opens. The browser app is a separate package; the first time, `nim` prints the command to install it:

```sh
npm install -g @nimbalyst/wiki-web
```

`--no-open` prints the URL instead of opening a browser; `--port` picks the port.

## The files

A local wiki is plain files you can read, edit, diff and commit without any Nimbalyst tool. The full contract is [FORMAT.md](../../packages/local-wiki/FORMAT.md); in short:

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

- **Pages** are `<Title>.md`. Renaming a page renames its file and its child folder.
- **Frontmatter** is flat: `id` (never changes), `order`, and for a typed page `type` plus its fields.
- **Links** between pages are relative paths that carry the target's id: `[CMO](Personas/CMO.md "id=01M4...")`. They work on GitHub and in any editor. Nimbalyst rewrites them when a page moves, and repairs links broken by a move done outside Nimbalyst on its next scan.
- **Types** are defined in `.nimbalyst/trackers/<type>.yaml`. A type whose definition says `storage: pages` keeps one markdown page per item; `storage: table` keeps all its items as rows of one CSV. Types without `storage:` (bugs, tasks) stay in the app.
- **Deleting** moves files to `.trash/`, from where a page can be restored. Files are only removed when an item is deleted from the trash itself.

Agents can edit the files directly too. The MCP tools and `nim` add what plain edits do not: ids, ordering, link rewriting on moves, type fields, CSV rows and trash.
