# Nimbalyst Feature Inventory

A curated reference of Nimbalyst's notable capabilities, organized to help people discover what they can do with the product.

Maintain this when notable capabilities are added, significantly expanded, or removed; follow the root [CLAUDE.md](../CLAUDE.md) inclusion test. Group supporting details under the capability they explain. Routine polish, counters, badges, button placement, and performance fixes do not need entries. Keep platform and opt-in limits explicit. Extension features require the corresponding extension to be installed and enabled.

## Editors

- **Lexical rich text editor** (`.md`, `.txt`, `.mdc`) -- WYSIWYG with markdown shortcuts, slash commands, embedded diagrams, collaborative editing
- **Monaco code editor** (all code file types) -- syntax highlighting, IntelliSense, multi-cursor
- **CSV spreadsheet editor** (`.csv`, `.tsv`) -- formulas with function autocomplete and signature help, click-to-insert cell references, F4 absolute references, error explanations and named ranges; Cmd+K cell links; typed columns and per-cell number formats; a formatting toolbar (text and fill colors, borders, alignment, wrap with row heights, column auto-fit); hide/unhide and freezing rows and columns; conditional formatting (rules and color scales); data validation (dropdowns, checkboxes, ranges, reject or warn); sorting/filtering; a selection status bar and zoom. Undo covers every edit, including row/column insert and delete, which rewrite formulas and formatting. Keyboard navigation and a clipboard that pastes from other spreadsheet apps follow common spreadsheet conventions. Formatting is stored in the file's metadata line. Agents can read, write, sort, insert and delete rows and columns, format ranges, and set data validation with A1 tools, each edit one undo step, including on files that aren't open. Merged cells and multiple sheets are not supported
- **Calc Sheets** (`.calc.md`) -- calculation worksheets mixing Markdown prose with formulas, units, assertions, and live results; supports document embeds and collaborative editing
- **Excalidraw diagram editor** (`.excalidraw`) -- whiteboard-style diagramming with Mermaid import, AI tools, and real-time multi-client Share-to-Team collab
- **DataModelLM editor** (`.prisma`) -- visual ER diagrams with relationship and layout editing and export to SQL/JSON/DBML
- **MockupLM editor** (`.mockup.html`) -- visual HTML/CSS mockup rendering with annotation layer
- **PDF viewer** (`.pdf`)
- **SQLite browser** (`.db`, `.sqlite`, `.sqlite3`, `.db3`) -- table browsing, SQL query runner, AI tools
- **Browser** (`.html`, `.htm`, `.browser.json`) -- native Chromium `WebContentsView` (not an iframe, so frame-blocking sites load), URL bar / back-forward / reload, workspace-scoped `nim-preview://` local preview, source-mode toggle, and agentic control AI tools (navigate, click, type, evaluate, scroll, get_page_info, screenshot) over editor-backed or agent-owned headless sessions
- **Image generation project editor** (`.imgproj`) -- multi-variant AI image generation with iterative refinement
- **Astro editor** (`.astro`) -- schema-aware frontmatter form header
- **Animation editor** (`.anim.json`) -- animated explainer diagrams with timeline editing, product UI frames, inline transcript playback, and HTML/GIF/MP4 export
- **Project Canvas** (`.canvas`) -- infinite board of live file and shared-document editors, with frames, notes, connections, team comments, revision comparisons, and screen navigation
- **Legacy mockup projects** -- read-only preview with Convert to canvas; conversion writes a new board beside the original, and legacy projects cannot be shared to a team
- **Image viewer** (`.png`, `.jpg`, `.gif`, `.svg`, `.webp`, `.bmp`, `.ico`)
- **Media Viewer** (`.mp4`) -- plays video in a tab with scrubbing through long recordings, streaming over `nim-asset://` with byte-range support so non-faststart files open and seek correctly

### Cross-Editor Features

- Source mode toggle (raw file view)
- Diff mode for AI edits with per-file approve/reject bar
- Approve all / reject all pending changes
- Cell-level diff highlighting (CSV), visual diff slider (MockupLM), side-by-side diff (Monaco)
- Document history with diff viewer
- Auto-save
- Live custom-editor embeds in Markdown through a standalone file link, including mockups, data models, and animations; a Team or Personal page of an extension type embeds the same way when linked with `@` (a Personal page embed is view only and follows edits made in its tab)
- Editor-header session history -- open the last AI session that worked on a file, choose another associated session, or start a new one
- Shared mockup comments anchored to a spot in the design, with live pins and agent read/reply support
- Decision blocks inside documents -- solo or collaborative voting on a decision, with the attributed outcome sealed into the markdown itself so it survives outside Nimbalyst
- Chart blocks -- a `chart` fence (bar, line, area, pie, scatter) with inline CSV or YAML data, or a raw Vega-Lite spec, rendered interactively (tooltips, hover highlight, legend toggle, zoom/pan) in the app theme, with errors shown in the block; edited as YAML text. Desktop only for now
- Callouts in GitHub alert syntax (`> [!NOTE]`, TIP, IMPORTANT, WARNING, CAUTION) with an optional title, which also render on GitHub
- Column layouts save to markdown as `<div data-columns>` wrappers, and an inline table of contents block (`toc` fence, optional depth) lists the page's headings live and scrolls to them
- Transclusion -- a page link titled `transclude` shows that page's section (or whole page) inline, read-only and live, with a link back to the source; team, typed and Personal pages. Desktop only for now
- Mentions -- `@` offers team members (written as `[@Name](mailto:...)`) and dates (written as `@2026-10-15`, shown relative) alongside page links
- Link previews -- a link alone on its line can show as a bookmark card (metadata fetched by the app) or, for allowlisted video and design-file hosts, the site's own player; it stays a normal link in plain markdown. Players are desktop only for now
- Code excerpts -- an `excerpt` fence quotes a line range of a committed file (read at HEAD; dotfiles refused), pinned to a commit with the snapshot stored in the page, and flags when the code has changed, moved or gone, with "Update to current" and open-at-line
- Tabs -- a tabs block with named panels of ordinary markdown (each panel is a collapsible section on GitHub)
- Action buttons -- a "Start session" button runs a stored prompt (optional model and effort) as a new agent session with the page as context, after showing the full prompt for confirmation; a "New item" button creates a typed page from an optional template and places it under the current page. Desktop only

## AI Providers

Twelve built-in provider lanes, plus any agent an extension contributes. Every lane runs on keys the user entered in Nimbalyst settings or on a CLI the user already logged into — no provider is read from the environment, and no lane is required for another to work.

**Chat**

- Claude (direct Anthropic API)
- OpenAI / ChatGPT (direct API)
- LM Studio (local models, auto-discovered)

**Coding agents**

- Claude Code (Agent SDK with MCP, file access, plan mode, sub-agents)
- Claude Code CLI (off by default; the genuine CLI driven in a terminal, with a raw-terminal drawer for its native pickers and mid-session `/model` switching)
- Custom Claude models: models listed under `modelPicker` in Claude's user, project, or local settings appear in the Claude Code and Claude Code CLI pickers and are sent to the user's gateway by name (`behavesAs` sets context window and effort/thinking support; `replaceBuiltInOptions` hides the built-in models). CLI sessions follow a loopback `ANTHROPIC_BASE_URL` from Claude settings; non-loopback URLs are not followed
- OpenAI Codex (SDK / app-server transport with MCP support)
- OpenAI Codex over ACP
- GitHub Copilot CLI (ACP)
- Grok Build (ACP)
- Cursor Agent
- Gemini via Google Antigravity (Connect-RPC over the user's Antigravity login; reports no usage numbers, so context and cost display as unavailable rather than guessed)
- OpenCode, with slash commands, Compact, agent roles, and a model picker populated from the user's connected accounts

**Cross-provider behavior**

- Extension-contributed agent providers — an extension can register its own agent lane alongside the built-ins
- Per-provider file-change fidelity (`providerFileTracking.ts`) — each lane declares how well it can report the files it changed (`structured` / `tool-args` / `none`), and the filesystem watcher is switched off only for lanes that report authoritatively. Lanes with no delete or move tool (Grok Build, Gemini) deliberately keep the watcher on so `rm` inside a shell command still shows up in the files-edited sidebar
- Per-project AI provider overrides (Project settings) on top of application-level provider config

## AI Sessions

- Session creation, naming, archiving, deletion
- Launch a new session from any workspace mode with the reusable composer popup (Cmd+Shift+N), including model/mode controls, mentions, slash commands, and attachments
- Session search with full-text index (Cmd+L)
- Session pinning
- Session branching / forking
- Session tags and phase tracking
- Session HTML export and clipboard copy
- Shareable session links (E2E encrypted, 1/7/30 day expiry)
- Live import of external Claude Code and Codex CLI sessions — opt in with **Follow external agent sessions** under **Settings → Agent Features** (OFF by default); follow sessions in open workspaces and their worktrees into the session list and open transcripts, including later title updates while preserving names set in Nimbalyst
- Manual import of earlier Claude Code and Codex CLI sessions remains available with live following OFF
- Session draft persistence (unsent input preserved)
- Read/unread indicators, with mark-all-read actions for a workstream and the macOS menu bar sessions panel
- Auto-continue sessions after app restart
- AI auto-naming of sessions after first turn
- Drag-and-drop session reparenting and searchable move actions, with manager reassignment and Undo
- Session launch history links orchestrating sessions to the sessions they created

## Workstreams

- Nested session trees within a workspace or worktree, with collapsible orchestrators and subtree activity, unread, and uncommitted-file rollups
- Workstream editor tabs (multi-file editing per session)
- Workstream session tabs (switch between child sessions)
- Agent-to-agent session spawning (`/launch-new-session`, `spawn_session`, and `create_session`) places workers beneath their caller and shares the tree's files, tabs, and overview; isolated sessions and workers launched into another worktree remain separate roots managed by their caller
- Launching sessions can select a child session's reasoning effort, and coordinating sessions can interrupt a running session to deliver an instruction immediately

## Session Kanban Board

- Sessions organized into phase columns (backlog / planning / implementing / validating / complete)
- Configurable columns
- Agent-assisted cleanup (`/session-cleanup` slash command in the Planning extension) — audits sessions, proposes phase corrections and "mark complete" candidates for approval, and flags old sessions to archive
- Workspace coaching (`/planning:nimbalyst-coach` slash command in the Planning extension) — reviews the project and recent sessions, then recommends extensions matching the project's file types, product features going unused, and additions to the project's agent instructions; read-only until the user approves each edit

## Agent Mode

- Full-screen AI session interface
- Agent navigation badge with a grouped list of sessions awaiting input, running, or unread
- Plan mode toggle (Shift+Tab)
- Model-aware reasoning effort selector, including Ultra for supported Codex models
- Model selector (per-session or per-workstream)
- Context window usage display with pace tracking
- Files-edited sidebar with per-session scope
- Pending review banner (approve/reject AI changes)
- Red/green diff display per tool call
- Approve all / reject all pending changes
- Interactive prompts (durable, persist across restarts):
  - AskUserQuestion
  - PromptForUserInput (multi-field choices, reordering, editable text, and confirmations)
  - ExitPlanMode / plan approval
  - GitCommitProposal
  - ToolPermission
- Rate limit warning (amber) and blocked (red) widgets
- Scheduled wakeups (agent self-paces via `schedule_wakeup` MCP tool; persists across restarts; banner with Fire now / Cancel; clock icon on session list rows; OS notification on fire; overdue prompt on launch)
- Transcript with collapsible tool call groups
- Click-to-copy code blocks
- Agent file-placement preference -- open file tabs above the transcript or in the right pane
- Optional MCP status chip showing the session's configured, connected, and missing servers (off by default in Agent Features settings)
- File `@` mention in input
- Image attachment support
- Selection chips above the input showing what will be sent as context (selected text, mockup annotations, and extension-provided items from node-like editors such as Excalidraw); each chip has an × to drop it from the prompt, and node-like editors can report multiple selections at once
- Queued prompts display
- Slash command typeahead
- Action prompts dropdown in composer (reusable prompt presets defined in `nimbalyst-local/ai-actions.md`; pick to insert verbatim into the draft, with undo support)

## Multi-Agent / Teams

- Sub-agent (teammate) spawning
- Teammate activity monitoring
- Background sub-agent task panel
- Send/receive messages between agents
- Teammate shutdown requests
- Plan approval flow between agents

## Git Worktrees

- Create isolated worktrees for AI coding sessions (Cmd+Alt+W)
- Multiple sessions per worktree
- Merge worktree into base branch
- Rebase onto base branch
- Squash commit modal
- Pre-flight conflict detection
- "Resolve with Agent" for bad git states
- Worktree archiving with background cleanup
- Worktree pinning and renaming
- Onboarding modal

## Super Loops

- Autonomous iterative agent loop
- Learnings carried forward via progress.json
- Dedicated worktree per loop
- Progress panel (phase, iteration count, learnings, blockers)
- Pause / resume / stop controls
- Force-resume with configurable iteration count

## Blitz

- Parallel AI sessions across multiple worktrees
- Model blitzes with model-named titles

## Git Integration

- Real-time git status in file tree (modified, added, deleted, untracked)
- Git operations panel with a Changes list where users select files and commit directly or ask AI to write the message
- AI-assisted commit message generation
- Interactive git commit proposal widget with individual-hunk selection to commit only the intended lines of a shared file
- Commit history view with ahead/behind tracking and links to the AI sessions that produced commits
- Per-repository status, branches, file lists, and commit controls for multi-folder projects; Commit with AI proposes separate commits per repository
- Auto-commit mode (toggle)
- Merge/rebase conflict dialogs
- Gitignore-aware file watching

### Pull Request Review Mode

- Integrated GitHub PR view (Cmd+U, developer mode + GitHub remote): list, conversation, files-changed diffs, commits, checks
- Approve and merge (squash/merge/rebase) from inside the app; `gh` CLI auth, no stored tokens
- Open a PR in a git worktree with an agent session on its head branch
- Tracker integration (reference-based, works with any tracker type): status badge + priority marker on list rows, editable status pill and tracker chips in the detail header, dynamic review-status filter chips
- Jump PR ↔ tracker item ↔ review session in one click from any of the three surfaces
- Link any tracker item to a PR from the PR detail; opening a worktree auto-links the session to referencing items
- Merging transitions referencing tracker items via the opt-in `prMergedStatus` schema role (comment-only for types without it); externally merged PRs surface a one-click catch-up hint
- Tracker kanban cards show an item's external identity (e.g. PR number) via the `externalKey` schema role
- GitHub issue browsing and triage beside pull requests, with local investigation status and notes and an explicit action to adopt an issue into a tracker

## File Management

- Multi-folder projects -- attach folders from the File menu or quick open; their files participate in the explorer, search, and agent context, with Git tracked per repository
- File tree with expand/collapse and keyboard navigation
- Virtualized file tree for large repositories
- Context menu: rename, delete, reveal in Finder, open externally, copy path, move, copy
- Drag-and-drop file/folder operations (Option/Alt to copy)
- File watching with auto-reload on external changes
- .gitignore-aware filtering
- New file dialog with type selection and folder picker
- New browser tab (Cmd+Shift+B) -- opens a fileless Browser virtual tab in files mode
- Quick open (Cmd+O), with a remembered Local / Shared file filter
- Content search across files (Cmd+Shift+F)
- Auto-save (configurable interval)
- Local file history with diff viewer (Cmd+Y)
- Document history with configurable retention
- File links with line or line/column locations open at the referenced position

## Tab System

- Multi-tab editing with tab bar
- Reopen closed tab (Cmd+Shift+T)
- Navigate between tabs (Cmd+Option+Left/Right)
- Close tab (Cmd+W)
- Expand the active tab to the whole window by double-clicking it, using View > Toggle Expanded Tab, or pressing Shift+Escape; repeat to restore
- Extension-contributed document headers

## Voice Mode

- Desktop voice control with GPT Live and GPT Realtime engines; model and voice selection in Voice Mode settings
- Selectable model and reasoning effort in settings
- Live transcription streaming
- Voice commands with countdown before submit
- Interactive prompt answering (verbal AskUserQuestion, plan approval, git commit)
- Echo cancellation
- Extension-contributed voice tools (`voiceAgent: true` AI tools) and voice session-context providers — any extension can expose tools and start-of-session context to the voice agent
- Backend-module voice/agent tools — an extension's utility-process can register MCP tools dispatched in-process (no renderer hop), enabling native engines to answer the voice and coding agents sub-second
- Project-knowledge grounding (Nimbalyst Memory extension) — local hybrid search over your design docs, plans, CLAUDE.md, and notes, available to the voice and coding agents
- Hands-free brainstorm loop — talk an idea through, kick off a plan (`/design`), have the agent read the written plan back to refine it by voice, then `/implement`; ask "is it done yet?" anytime for live task status
- Voice agent tool calls (memory lookups, coding-agent questions, and more) are recorded in the voice session transcript and render as tool widgets, including a dedicated memory-recall widget showing the query and the returned source documents (title + snippet)
- Available on desktop and iOS; native iOS defaults to Realtime and offers GPT Live as an opt-in preview

## Mobile (iOS)

- Native SwiftUI app with encrypted sync
- Session list with search and pull-to-refresh
- Session transcript viewing (WebView)
- Rich mobile transcript cards for structured prompts, memory results, and live tracker links; zoomable/copyable images and tappable file links
- Personal document/file sync and bidirectional draft sync with the desktop
- Local wiki on the phone -- a Wiki tab for projects with a Local wiki shows its page tree by title and order (Home first, conflict copies grouped, trash hidden); pages open in the document editor with links between pages followed in the app, typed pages show their type and fields read-only above the body, and table types show their rows read-only. Page bodies are editable and keep frontmatter byte for byte; fields, table rows, and creating, renaming or moving pages stay on the desktop. A wiki in a newer format opens read-only. Requires an updated desktop syncing the project
- Team Wiki and Team Trackers on the phone -- a Team tab for projects that belong to a team opens the team's wiki and trackers from the web console inside the app, signed in automatically from the phone's account (no second sign-in; teams that require MFA or another sign-in method open in Safari instead). Pages open read-only with an Edit button for plain pages; typed pages and type tables stay read-only. Unsaved edits are flushed when leaving or backgrounding, with a warning if they have not reached the server. Console links from Mail, Messages, the transcript and `nimbalyst://console` open in the app. Online only. Requires the updated sync server
- Compose bar with slash command typeahead; delivery warnings track desktop activity and clear when execution or fresh output arrives, while mobile edits preserve desktop-owned running status
- Project Actions in the composer menu -- prefill a saved desktop action prompt or launch it in a new session
- Adaptive iPhone/iPad layout with a session sidebar on wide screens; session and draft preserved through rotation
- Image attachments (camera, photo library, clipboard)
- QR code pairing with desktop
- Email magic link and Google OAuth login
- Push notifications for agent completion
- Mobile session creation with project picker
- Cancel running sessions from mobile
- Answer interactive prompts from mobile
- AI model picker (synced from desktop)
- Archive/unarchive sessions
- Context usage display
- Queued prompt management
- Hierarchical session navigation follows nested orchestrators within workstreams and worktrees on iOS and Android
- Create and follow Meta Agent sessions with children grouped under their parent when the desktop-synced Meta Agent alpha feature is enabled
- Multiple signed-in accounts with an active account for personal sync
- Mobile voice mode (soft chime + haptic cue when the session connects and it's your turn to talk)
- Mobile voice audio selection: view the active microphone and speaker, choose supported routes through native pickers (iOS 26 microphone picker with an older-iOS fallback), and switch to the phone speaker. Headphone disconnection pauses voice until explicit Resume.
- Mobile voice: asking the voice agent to start a new session opens it automatically on the device that asked
- Mobile voice: the floating mic shows a tool-call indicator (animated ring + tool-icon badge) while the agent runs a tool
- Mobile voice follows the session on screen for summaries and new tasks, while queued tasks and presented questions retain their source session. GPT Live preview supports spoken answers to simple questions, one-time permissions, and commit proposals after the voice agent reads the exact prompt; requires an updated source desktop with its workspace open. Longer or richer prompts and older hosts use existing UI cards.
- GPT Live voice conversations on the phone are recorded as voice sessions on the connected desktop (what you said, the agent's replies, and tool calls with results); requires an updated desktop
- Opt-in GPT Live voice can open existing synced project files and carry the file reference into a coding request; idle closes the paid connection and foreground resume restores bounded conversation context
- GPT Live can announce source-desktop questions and completions with cross-device presentation ownership; the source workspace must be open in the desktop app. Interrupting a question readout requires reading it again before answering; completion announcements are explicitly dismissed on the phone.
- Session fleet Live Activity — Lock Screen card and Dynamic Island mirroring the macOS menu bar strip, with the sessions waiting on you ranked by wait time; tap a row to open that session. Server-started, so it appears without opening the app; stays visible while using the Mac, dims when the Mac stops reporting, ends when the fleet goes quiet. Toggled in Settings

## Mobile (Android)

Companion app; pairs with a desktop over encrypted sync. Voice mode is not included on Android.

- Native Kotlin/Compose app with end-to-end encrypted sync
- QR code pairing with desktop
- Email magic link and Google OAuth login
- Synced projects and sessions with unread state and desktop connection indicator
- Session transcript viewing (WebView)
- Create sessions, worktrees, workstreams, and Meta Agent sessions (when the desktop alpha is on) on a chosen desktop, choosing the model at creation from the desktop's list
- Files tab: browse and edit synced project markdown documents
- Team Wiki and Team Trackers on the phone, matching iOS (console links open the app through verified App Links); needs an Android System WebView with multi-profile support. Requires the updated sync server
- Local wiki on the phone, matching iOS: Wiki tab with the page tree, in-app links between pages, read-only typed fields and table rows, editable page bodies with frontmatter preserved. Requires an updated desktop syncing the project
- Cancel running sessions, archive/unarchive, and move sessions into workstreams
- Project Actions from the composer
- Submit prompts with image attachments
- Answer interactive prompts (tool permissions, questions, plan approvals) from mobile
- Queued prompt management
- Push notifications for agent/session updates, with tap-to-open routing and an in-app toggle
- In-app account deletion (permanently removes the account and all synced data)

## Collaboration

> **Encryption posture.** Team collaboration data (trackers, documents, doc-index titles) is **encrypted in transit and at rest, isolated per team, and operated by Nimbalyst**. The server holds a per-team KMS-wrapped key and encrypts at rest, which is what enables web, CLI, and cloud-agent access. This is the only supported mode for team data, and **it is not zero-knowledge**. **Personal sync** (your desktop ↔ phone: sessions, prompts, drafts, settings, personal index) **stays zero-knowledge** — the server never holds those keys. Customers who require true zero-knowledge for team data run the software on their own infrastructure (self-host).

- Real-time document editing (Lexical + yJS through Cloudflare Workers)
- Encrypted tracker item sync (server-managed, encrypted at rest per team)
- Server-managed per-team encryption keys: KMS-wrapped split-knowledge DEK, admin key-recovery, append-only audit log
- Stytch B2B org management
- Team invite / join / role management
- Personal org + team org separation
- Multiple projects per organization — add another workspace to an existing org as its own tracker space (sharing the org's roster and encryption)
- Three-scope Settings information architecture (Application | Account | Project) with typed deep links; organization administration opens in a dialog in the current window
- Organization administration -- members and roles, invitations, projects, billing, settings, and danger-zone actions; owners/admins can remove members and revoke invitations
- Global multi-account inspector in the navigation footer with per-account organization ownership, sync-account selection, add/sign-out/reconnect actions, and visible expired-session recovery
- Every organization you belong to, listed inline under its login in Account settings -- role, membership state, project count, management and invitation actions, and manual refresh; organizations reachable from more than one login appear once under the login that authorizes them
- Organization messaging opens inside the project window; a standalone organization window remains available
- Teammate invitations can include a role, additional projects, and folders to share; accepting an invitation leads into the team's browser workspace
- Shared projects can be opened into a chosen local folder, including projects without a Git repository
- Pick mobile projects in bulk — the Mobile App screen lists every project as a checkbox with Select all / Deselect all, so many projects (and their document sync) change in one interaction instead of one control at a time
- Decision-first project sharing — Project Settings → Sharing asks one question (add to an organization you already administer, or create a new one), then confirms in plain words what will happen and who gets access; a missing git remote is explained rather than silently disabling the flow. Projects are always added from the project itself, not by name from the organization window
- Per-personal-account mobile-sync profiles — project and document selections are retained when switching the active zero-knowledge sync account, independently of team organization selection
- Paired-computer inventory: the execution picker filters stale offline installations without project history; device settings support reversible Hide/Restore and labels when the sync server advertises inventory support, preserving historical sessions
- Move a project to another organization — relocates its trackers, documents, history, and schemas into the destination, transfers member access by email (auto-invite for members not yet in the destination, with a per-person opt-out and seat-delta preview), and redirects the old location (server-managed orgs only)
- Merge one organization into another — consolidates every project, unions the rosters (higher role wins), and optionally deletes the drained org
- Wiki mode (the shared-docs mode in the navigation gutter, Cmd+D, previously labeled Pages and before that Shared Docs) -- the team project's page tree. It shows the current project's pages only, like its trackers; a link to a page in another project of the same team still opens it. Pages nest inside pages (there are no folders; on the updated sync server a team's existing folders become pages with the same place in the tree, and older servers keep the folder tree). A tracker type can be placed in the tree as a node (one placement per type per project, from a page's or the tree's "Place type..." menu; removed from the tree without deleting its items); a placed subtype (a type defined with `extends`, inheriting its base's fields) nests inside its base type. Pages, typed pages and types share one order among their siblings and can be reordered by drag. Clicking a type opens it as a page: a prose description of the type above a table of every item of that type with a Where column. An item sits under its type until it is moved or dragged under any page or typed page; typed pages can hold pages, typed pages and types. An item opens as a document page: breadcrumb, title, one row of single-valued fields (empty fields are added from a "+" menu; multi-valued fields and relationships never show in the header), its collaborative body, and the Links section; no tracker detail panels. Every plain page is of type Page, with its own status (draft, current, outdated), owner, one-line summary and tags, edited from the same header row as a typed page's fields and shown as Search columns and filters (Team pages need the updated sync server). A plain page and the plain pages under it can move between the Personal and Team sections ("Move to Team..." / "Move to Personal..."): every body is copied and read back before the original goes to its section's Trash; pages with images, typed pages or types don't move yet. "Set type" on a plain page turns it into an item of that type in place: same position, same body, same child pages (the body is copied and read back and every child move confirmed by the server before the page is moved to Trash). Page and type tabs reopen after a restart alongside shared documents. Placements sync to every teammate through the team room (requires the updated sync server). Relations are made by linking in the prose: hovering (or clicking) a link to another item in a typed page's body offers the named relations the project's predicate registry allows for that pair of types, with their inverse names, or Plain link; the choice is stored on the link in the page's markdown. A Links section at the bottom of the page lists each relation on one collapsed line (incoming relations under their inverse name, plain links under Mentions), expands to the sentence that made the link, and opens the linked page on click; it also lists relationship-field links. Links in a teammate's edits are indexed on this device when the edit syncs. The tree has a Team section (team projects) and a Local section (each collapses to its header) that works with no account and no team: the Local wiki is a folder of plain files in the project (default `nimbalyst-local/wiki`, or any project folder set in `.nimbalyst/local-wiki.json`), with nested pages as markdown files, or files of any shareable editor type (drawing, mind map, data model, mockup, spreadsheet and the like, each with a hidden sidecar holding its id and order), that open as ordinary file tabs in their editor with local history, typed pages for types whose YAML declares `storage: pages`, and table types (`storage: table`) kept as one CSV per type; agents and the `nim` CLI read and write the same files. Personal pages from earlier versions, stored in the local database, stay visible and are copied to files only when the user chooses Export from the Local section's right-click menu. Each section starts with an editable Home page pinned at the top (the team's is created once by the sync server, the Personal one locally; neither comes back after being deleted or renamed), and New page is offered from a right-click on empty tree space, on a section header, and in an empty tree. Above each section's tree, Home, Search and Types rows: Search is one filterable table of the section's pages and typed pages (types placed in the tree), matching titles and the text inside pages, with filters on type, tags, author, updated and a type's own fields; Types shows every type as a map of types and their relations or as a table, with New type. New type (also offered from Set type) defines a type with fields, select options, a person, a relation to another type, or a parent type to extend, in Team or Personal, without an agent. The Wiki opens on the Home page. Pages navigate like a wiki: a click opens the page in the current Wiki tab, Cmd/Ctrl+click opens a new tab, and each tab has its own Back and Forward (Cmd+[ / Cmd+], a two-finger trackpad swipe, the mouse side buttons, or the buttons at the start of the tab strip). Every page body has history with compare and restore, including typed pages and type-page prose (from the page header or the row menu; Personal history is local and works offline). A Trash entry at the bottom of each section restores trashed pages with their subtree; team Trash is emptied by the sync server after 30 days. Typed pages are archived rather than trashed. Desktop
- Configurable views inside pages -- table, board, list, timeline and 2x2 layouts share view settings stored in the page link. Editors can change layout, field order, grouping, multiple sorts, filters and axes; table header sorting and resized column widths are saved with the view; read-only exploration is temporary. Boards support single-value custom fields, card moves, shared manual ordering and selected field chips. Create items directly in tables/lists or board lanes, with unambiguous filter/lane values prefilled and refused drafts retained for retry. Open a placed view full-size on its type page as an unsaved view, preserving its filters and layout without changing the source page; browser links carry that definition in the URL. Timeline views can select explicit start/end date fields, keeping items without those dates visible as undated. Type pages can add, rename, configure and remove named view tabs, or save an unsaved view by name; definitions live as page-view fences in the type description, with independent settings merging through its collaborative document. Place in page copies a self-contained view link, with a selectable fallback when clipboard access is unavailable. Desktop settings persistence, creation and full-view handoff verified through the mounted editor; browser delivery uses the shared components.
- Decisions, open questions, citations and placed views in pages -- a sentence in any page (team, typed, type or Personal) can be marked decided (by whom, with email, when, and what was not chosen) or open, from the selection toolbar; a page can cite a person's prompt, answered question or page comment as a chip that shows the quoted words, or cite a web page or document, listed with the page's properties in a Page info panel beside the page on desktop (a Sources line under the page in the web console). A table of any type (columns, sort and filter kept in the link; cells edit the items), a 2x2 drawn from two number fields with optional pinned points, a hand-filled 2x2 block, a chart of a type's items grouped by a field and counted or summed (desktop only for now), and a list of decided or open marks across all pages (filterable by person; plain, typed and type pages come from a project-scoped sync-server index, with live archive/deletion/access checks and visible partial results) can be placed in a page from the slash menu. New links in pages are https console links that open in the desktop app when it can show the target and otherwise in the web console, which hands Personal pages and session citations back to the app. Agents edit team and Personal pages directly, list the page tree with bounded pagination (100 nodes by default, up to 500), subtree/depth/kind filters and compact metadata, create, place, reorder and move pages, typed pages and types, set a page's type and a plain page's fields, and look up a session's citable inputs; each page an agent edits gets an "Updated <page>" line in the transcript. Agents read another project of the same team by naming it (`project` on the list and read tools): that project's whole tree, typed pages and type pages included, comes from the sync server and needs access to that project; agent changes always stay in the current project. Desktop and web console. Requires the updated sync server for the server marks index, team Home and console link pages
- Copy local files into the Wiki -- "Copy to Wiki..." on a file in the Files tree, tab or editor menu, or "Add from Files..." in the Wiki's New menu and a page's ⋯ menu (lands inside that page), copies a file as a page of its type (markdown, Excalidraw, mind map, data model, mockup, spreadsheet and the other shareable editor types) into Team, or into the Local section with or without a team (it becomes a file in the Local wiki folder and opens in its editor; code files go to Team only); Team copies keep a link back to the local file. Agents do the same with `importFileToPages`, and a Team page edit that links a local file path returns a warning. Agents edit a Team page of an extension editor type (drawing, mind map, data model and the like) with that editor's own tools by passing the page's `collab://` uri, without the page open. Share Folder to Team publishes supported files recursively and mirrors the folder hierarchy. Desktop
- First-class shared folders — real synced folder entities (not path-in-title) with a full right-click menu: New Document, New Folder, Rename, Copy Link, and recursive Delete (with a document/subfolder count confirmation). Folders move by drag-and-drop (in or out of other folders); renaming or moving a folder keeps every document's local-to-shared link intact because the folder id is stable. A folder deep link (`nimbalyst://folder/…`) opens Collab mode focused on the folder. AI agents can create, move, rename, and delete shared files and folders through MCP tools that use the same path a person does
- Favorite pages — star a page from its menu (local per-user)
- Unread indicators on shared docs — a dot on a doc's sidebar entry when it is new or its content/title changed (by someone else) since you last opened it; clears when you open it; the doc index carries the last writer so your own edits (including cross-device) are suppressed. The sidebar overflow menu can hide the dots or mark all docs read, and a doc's context menu can mark just that one read
- **Extension-provided collab editors** — SDK `useCollaborativeEditor` hook lets any extension (Excalidraw, CSV spreadsheet, DatamodelLM shipped; others can opt in via `collaboration.supported` manifest flag) share its file type to team with real-time multi-client editing, cursors, and selection
- **Shared naming projects (Namenym extension)** — concurrent brief, theme, word, candidate and note editing; personal favorites with attributed team totals; legacy shortlists remain unattributed. Desktop AI generation shares results live, and domain searches run only on explicit request in shared documents. Favorites are editable document content, not audited approvals.
- **Offline-first shared documents** -- read and edit cached documents offline, with locally encrypted storage and synchronization when reconnected
- Linked local files can pull the latest shared-document content from the editor header; shared version history compares a version with the previous one or the current page in red/green before restoration
- Agents can read and edit shared documents without an open tab, including supported custom editors

### Organization Messaging and Feedback

- Organization inbox, rooms, and direct messages with a rich composer, attachments, mentions, live document/tracker links, unread badges, and desktop notifications
- Inbox entries for mentions, assigned work, replies, tracker comments, and document discussions, with unread/source filters and a resizable preview pane
- Structured teammate feedback requests -- agents draft questions for selected recipients, who can answer in the desktop app or a browser; the organization's Feedback view retains sent requests and results
- Feedback artifact and mockup previews, including side-by-side option choices, full-size previews, publish-destination selection, and a link back to the composing session
- Document questions can collect private teammate answers, record a human-settled outcome, and resume the waiting agent; sent questions appear in Feedback with response progress and links back to the document

### Web Console

- Browser access to team documents, shared folders, and trackers, with live collaboration with desktop clients
- Shared trackers in list, table, board, timeline, and tag-board views, with search, filters, grouping, column selection, inline edits, comments, and drag-and-drop
- Phone tracker browsing defaults to stacked rows with search and filter sheets; plan readers offer collapsed properties and explicit live editing, and retain list position and unsent comment drafts within the current project session
- Supported shared custom editors include spreadsheets, mockups, Excalidraw diagrams, data models, and Canvas; editable source mode provides access when a document's editor cannot render it
- Namenym shared projects open in the browser with manual editing, individual/team favorites, presence, and read-only access; AI generation remains desktop-only. Browser creation, source mode, export and history actions are not offered for Namenym.
- Shared-document comments and replies with mentions delivered to the recipient's inbox
- Wiki (its own nav item) -- the same page tree as desktop Wiki mode: Home, pages, typed pages with their fields and Links, type pages with their table, Set type, New page, decisions and open questions, citations, placed views, page history with red and green compare and restore (pages, typed pages and type pages), Trash with restore, archiving typed pages, Search (titles and page text, with filters in the URL), the Types map, and New type for team types. Console links to pages, typed pages, types and views land here, or offer to open in the desktop app. Relations are typed as links; the browser editor has no relation picker
- Public knowledge graphs -- an org admin can publish a team project's earlier knowledge-graph items and their types from Tracker setup > Public, after confirming what becomes visible; anyone can then read it without signing in at `/public/wiki/<slug>`, including its Types pages, and search engines may index it. Comments, author names and activity, health checks, ontology proposals, other trackers, and unshared items stay private (links to unshared items read "Private page"). Turning it off takes effect on the next read; moving the project unpublishes it. Rate-limited; toggles are audited in the project's room
- Team creation from the browser, and approval pages for connecting Claude Code and the `nim` CLI to your teams (see "Nimbalyst Wiki for Claude Code" under CLI and Remote Execution)
- Organization invitations, pending-invite management, and a Requests inbox for feedback, mentions, replies, and discussions
- Quick open (Cmd+K), tracker row context menus, Nimbalyst themes, and layouts that adapt to narrow screens

## Tracker System

- Tracker mode (Cmd+T) with list, table, grid, kanban, tag-board, timeline, and inbox views
- Board lanes and timeline grouping by milestone, goal, or another field, with drag-and-drop and bulk assignment
- Full-document tracker view with collaborative body editing, inline comments, editable field chips, AI chat, and shareable reopen links
- Tag-board view with one column per tag (items appear in every matching column, plus an Untagged column)
- Saved views: name, save, apply, and delete reusable filter/layout views per workspace; a view captures the whole table state (columns, widths, per-column filters), and can be shared with the team so a colleague opens the same view
- Editable spreadsheet grid — virtualized grid where any schema-backed cell edits in place with an editor chosen by the field's type, plus per-column filters and multi-cell paste
- Collections — `milestone` and `release` items that group other tracker items through a relationship, with member rollups (counts by status, progress) and an "Add to collection" bulk action
- Triage inbox — a keyboard-driven queue of everything nobody has decided about yet (unassigned, unprioritized, in no collection, still on its initial status), scoped globally or to one type. Assign, prioritize, accept, add to a milestone, snooze, or dismiss without leaving the keyboard; agent-filed items are flagged as proposals. Snoozes are personal
- Releases as tracker items — create the next release early, associate work with it as it lands, and let the release scripts fill in version, git tag, and date at build time (`nim release finalize`); `nim release notes` renders the release's members as changelog markdown
- Review lane — `in-review` -> `changes-requested` / `approved` on bugs, tasks, and plans. An AI agent can move work into review but cannot approve it; only a person can
- Configurable tracker item types (bugs, tasks, architecture docs, decisions, etc.)
- Item detail panel
- Quick Track (Cmd+Shift+I) creates an item of any type from anywhere, with similar-item suggestions before creating a duplicate
- Ready view surfaces unblocked work, ordered by how much other work it unblocks; items record what they are waiting on
- Open / All / Closed filter, hiding closed work by default; Owner and Due Date available across the All view
- Personal and team trackers, with unpublished team items remaining private; local item numbers (`NIM.75`) are given only to items of types that set `localNumbers: true`
- Table editing with multi-cell operations and undo/redo
- Tracker-item context menus open linked AI sessions or launch a new session or worktree; draft plans with linked commits show a status-mismatch chip
- Unread indicators — a dot on tracker rows/cards (list, kanban, tag board) when an item is new or was changed by someone else since you last viewed it; clears when you open it; your own edits and views sync across your devices (personal channel), and AI-agent edits count as unread
- Encrypted sync across team members (server-managed, encrypted at rest per team)
- Inline `#type` items in markdown (TrackerPlugin)
- Live tracker reference links — `#` in a document references an existing tracker item, inserting a chip that shows the item's current status and title (resolved live, not a snapshot) and links to it; serialized as portable `[NIM-123](nimbalyst://NIM-123)` markdown; the same link renders as a live chip in the AI transcript; one-click "convert to tracked reference" turns a legacy inline embed into a real tracked item plus a reference chip
- Tracker schema overrides in Trackers settings -- customize a built-in type into `.nimbalyst/trackers`, edit an existing override, reset back to the built-in default, and resync the local database mirror when schema files drift
- External-source importers: import GitHub issues (extension-provided) into the tracker as native bug, task, or feature items with a back-link to the source, a "from GitHub" chip, re-snapshot ("pull latest from source") with conservative merge, and a Source filter; agent tools `tracker_importer_list` / `tracker_importer_search` / `tracker_import` / `tracker_resnapshot` / `tracker_get_by_urn`
- Per-project "AI Agent Access" toggle in tracker settings -- allow or block AI agents from using tracker tools in that project (on by default)
- Knowledge kinds (earlier knowledge graph; the Wiki skills no longer create them) -- existing entity, claim, question, finding, and investigation trackers and a project's labels.yaml still load and sync, and values stored with qualifiers keep them when edited. The desktop no longer shows claim statements, qualifier editors, or Add statement, and agents can no longer author labels; the frozen web-console wiki still reads them
- Ontology inspector (web console Tracker setup) -- a read-only "What we track" view of a team project: the categories it tracks with examples, how completely each relationship between them is recorded, and a "Worth fixing" list of gaps, with links to the wiki's Types section, where per-label health and proposals live. Health checks report pages missing the statements their labels expect, statements whose target has the wrong label, unknown labels, undeclared properties, label cycles, and near-duplicate labels, and never block a write. Each gap drafts an ontology proposal (add a label or property, give a label a property or broader label, extend a range, apply or split a label) that is previewed, accepted or rejected per change, applied, and undoable
- Radar -- a since-you-left digest for a shared tracker covering teammate activity, status moves, bulk sweeps, and work that has gone stalled; available in the desktop app and the web console, and to agents via the `work_radar` tool so a session can check for concurrent work before starting on an item

## Shared Links

- Share markdown files as E2E encrypted links; 2x2 charts and Mermaid diagrams render as images (other editor blocks show as their markdown)
- Share AI sessions as encrypted links
- Expiration options: 1/7/30 days
- Account-attributed shared links management in Account settings, plus an explicit create-share account picker defaulted from the workspace binding

## Automations

- Scheduled recurring AI tasks via markdown files with YAML frontmatter
- Schedule types: interval, daily, weekly
- Output modes: new-file, append, replace
- Manual run option
- Document header showing schedule and controls
- AI tools: list, create, run

## Extensions System

- Manifest-based extension registration
- Custom editor contribution
- AI tool (MCP) contribution
- Document header contribution
- File icon contribution
- New file menu contribution
- Lexical node and transformer contribution
- Claude slash command contribution
- Nested settings panel contribution plus first-class application/project settings routes with project context
- Tracker importer contribution (`trackerImporters`) — external-source importers backed by a backend module
- Extension-driven AI sessions (`ai-sessions` permission): a backend module can create sessions with a system-prompt directive (agent providers only), queue prompts, read status, results, and token usage, and receive settle events for the sessions it owns and their descendants; panels can embed a session transcript with its composer and set a gutter badge, including from the backend while the panel is closed
- Extension hot reload
- Extension developer kit with scaffolding
- Extension marketplace (alpha)

### Built-in Extensions

- Animation — step-based animated explainer diagrams, with an authoring skill and an `/animate` command
- Automations
- Astro Editor
- CSV Spreadsheet
- Calc Sheets
- Crew (Alpha) -- off by default; persistent agent personas (for example a PM) defined as markdown files in `nimbalyst-local/crew/`, each with a role directive, notes, a journal, weekly/interval shift schedules, notification limits, and token budgets counted across all tokens including cache. Shifts run as ordinary agent sessions grouped under the member's workstream, in the project's normal permission mode. Fullscreen panel with roster, per-member desk (embedded transcript), feed, and hiring from templates or by cloning a member; `/crew:hire` designs a new member from a job description in any agent session. Desktop only; schedules run only while the project is open, and a missed run fires once on reopen
- DataModelLM
- Developer Tools
- Excalidraw
- Extension Dev Kit
- Git -- commit history, diffs, push/pull, and branch operations
- GitHub Issues Importer
- Image Generation
- iOS Dev Tools
- Wiki (the Knowledge extension) -- off by default; agent skills (`/wiki:setup`, `/wiki:update`) for writing a project's wiki pages: pages, typed pages and the types the project chooses, relations written as links, decisions and open questions as marked sentences with the person's email, citations pasted from the session's citable inputs, and sources cited as links; setup asks about the wiki's audience, purpose, sources, and desired depth, then populates Home and project-appropriate starter pages with sourced content and navigation, installs an editable "How we write this wiki" guide page (never overwritten on re-run), and adds types and relations when useful. Re-runs reuse existing pages and preserve their content; earlier knowledge-graph content stays in place, with a reference for moving it into pages. Alpha: a curator sorter tool asks TypeSafe's Jev model whether commits, sessions, and tracker changes carry knowledge, which area they belong to, and which existing item they update, gating on confidence; requires the user's TypeSafe API key or Cloudflare Workers AI token, optionally through an AI Gateway (Settings > Knowledge curator), and sends event text to api.typesafe.ai or Cloudflare
- MockupLM
- Math -- inline and block LaTeX rendering in documents and agent transcripts
- Nimbalyst Memory — local project-knowledge brain (hybrid search + facts) for the voice and coding agents, with separate instruction/personal-memory sources, optional on-device embeddings, and index/semantic-search readiness controls
- PDF Viewer
- Planning
- Playwright -- test explorer and agent tools for running tests and inspecting failures, flaky tests, and history
- Project Canvas — authoring skill for `.canvas` boards; the editor itself is built in
- Media Viewer — `.mp4` playback in a tab
- Project Graph — navigable whole-project graph of plans, trackers, sessions, commits, and files, with a horizontally scrollable **Timeline mode** (phase-colored lifecycle bars per item; collapse items into per-tag activity lanes), plus **Atlas**, **Pulse**, and **Evidence Trails** for exploring a project across broader source coverage, with saved views and linked source exploration
- SQLite Browser
- RTL Support -- automatic or forced right-to-left text direction for transcripts, prompts, and Markdown, with per-block detection and a toggle shortcut

## MCP Servers (Internal)

- Session context (summaries, workstream overview, recent sessions, edited files, scheduled wakeups)
- Session naming (name, tags, phase)
- Meta-agent (`create_session`, `spawn_session`, `send_prompt`, `notify_user`, `respond_to_prompt`, `get_session_status`, `get_session_result`, `list_spawned_sessions`, `list_worktrees`) — lets a session spawn and orchestrate child, sibling, or isolated sessions and send bounded OS notifications when the user has authorized an attention signal
- Settings control (`settings_get_overview`, `workspace_create`, `workspace_open`, `sync_set_for_project`, `appearance_set_theme`, `analytics_set_enabled`, `ai_set_default_model`, `features_toggle`, `extension_set_enabled`, `tracker_set_sync_policy`, etc.) — lets the agent change Nimbalyst settings through a curated, allow-listed surface; never exposes API keys or auth credentials; kill-switch via `settingsAgentToolsDisabled`
- Developer tools (extension lifecycle, database query, log access, renderer eval, environment info)
- Super Loop progress reporting
- Display tools (charts, images inline in transcript)
- Voice agent bridge (speak, stop)
- Git commit proposal
- Git log
- Editor screenshot capture

## CLI and Remote Execution

- `nim` CLI for workspace, session, document, and tracker queries, with filters and JSON/CSV output; tracker mutations, readiness queries, release helpers, and live importer commands
- CLI live mode uses the running app's tools; offline mode supports native tracker reads and writes with schema checks and refuses writes while the live app owns the database. Session/document commands are read-only
- Nimbalyst Wiki for Claude Code without the desktop app -- the `nimbalyst-wiki` Claude Code plugin (skills `setup`, `update`, `connect`) reads and writes a team project's wiki pages through a remote MCP server with the same wiki tools as the desktop agent (list the tree, search page text, read and edit page bodies, create, move, rename, delete, set a page's type and fields, typed pages and types), cites the terminal user's own typed prompts and answers through a local transcript helper, and cites comments on shared pages; `nim wiki` offers the same tools from a shell (one noun for the team and local wikis; `--team`/`--local` force either). Sign-in is a Nimbalyst account approved in the web console (`nim login` uses a device code); access follows Nimbalyst Teams membership, a team admin binds a repo to a team project, and an agent only reaches projects its user already has. Edits land directly with a history revision; team pages only. Requires the updated sync server
- Local wiki without the desktop app -- `nim wiki init/list/read/write/move/search` work on the project's Local wiki folder (the same files the desktop Local section uses; drawings and other editor pages are listed with their type and read and written as raw file text, and the browser view shows them as a pointer to open them in Nimbalyst), `nim tracker` lists, reads, creates and updates items of wiki types, `nim mcp` is a stdio MCP server with the local wiki's page and tracker tools for Claude Code and other agents, which can create the wiki themselves (team targets are refused and named for the remote server); the `nimbalyst-wiki` plugin bundles it as `nimbalyst-local`, so its skills and `/capture` work on a local wiki when the repo has no team project, and `nim wiki serve` opens the wiki in a browser on this machine for reading and editing (loopback only, token-protected; the browser app is the separate `@nimbalyst/wiki-web` package). No account needed. The CLI and browser app are published to npm as `@nimbalyst/cli` and `@nimbalyst/wiki-web`
- Headless Node runner creates or resumes Claude Code sessions without Electron, persists transcripts, and can serve as a personal-sync execution device for mapped repositories
- Cloudflare sandbox management from Settings using the user's own account -- deploy, inspect status, wake, stop, delete, and pair a headless runner
- Remote sandbox sessions use the normal composer, attachments, project Actions, session list, streamed transcripts, follow-up prompts, and stop controls
- Remote execution limitations: sandbox files/processes are ephemeral; previous execution state is not restored after the host restarts, and remote interactive question/permission answers and remote worktree creation are not supported

## Terminal

- Built-in terminal panel (Ctrl+`)
- Multiple terminal tabs
- Theme integration
- Clickable links
- Worktree-specific terminal sessions
- Context menu (clear, rename)
- Claude Code CLI sessions: raw-terminal drawer auto-reveals and focuses when the genuine CLI opens a native picker (`/model`, `/config`, `/login`, …)
- Claude Code CLI sessions: mid-session model switching from the model picker (drives the CLI's `/model` command; idle turns only)

## Settings

- Application: theme, AI providers, MCP servers, notifications, advanced, beta features, and extensions
- Account: signed-in accounts, sync-account selection, active zero-knowledge mobile-sync profile, paired devices, and account-attributed shared links
- Project: sharing/organization attachment, project access, AI provider overrides, agent permissions, tracker config, GitHub, and extensions
- Tools & Token Cost panel: per-tool-group estimated context-token cost and load policy (eager / on-demand / conditional) across built-in, extension, and user MCP servers; trackers toggle inline; reachable from the AI panel's token meter ("Manage tools")
- Claude Code: custom executable path, environment variables, effort slider, plan mode, auto-commit, extended context
- Multi-account support (add/remove/reconnect accounts, per-project binding, explicit share/team account defaults)
- Release channel selection (stable / beta / alpha)
- Document history retention
- Auto-save interval
- System spellchecker toggle; Windows/Linux language selection follows the OS locale with an override available through settings tools, while macOS uses the system spellchecker languages
- MCP server configuration and OAuth authorization, including explicit client registration details for servers without dynamic registration; project-level Claude server disabling also applies to external Claude Code
- Database controls for backup retention, pruning old tool output, migration status, and recovery of preserved database copies

## Theming

- Light, Dark, Crystal Dark, Auto (system)
- Extension-contributed themes
- CSS variable system (`--nim-*`)
- Terminal ANSI color theming
- Syntax highlighting colors per theme
- Diff colors per theme

## Navigation

- Back/forward history (Cmd+[ / Cmd+])
- Cross-mode navigation
- Session quick open (Cmd+L) — Shift+Tab searches message contents, not just titles
- Prompt quick open (Cmd+Shift+L), with filters for user-authored and agent-sent prompts
- Content search (Cmd+Shift+F)
- Memory search (Cmd+Shift+O) — a Quick Open "Memory" tab with Docs, Trackers, and Sessions scopes for hybrid semantic + keyword lookup, powered by the Nimbalyst Memory extension; appears only when that extension is enabled. Tracker results retain issue keys, status, type filters, and exact-match lookup; AI session indexing is optional and off by default
- Shared team document quick open (Cmd+Shift+D) — a team-gated Quick Open tab with name filtering, unread/favorite cues, and direct navigation into Shared Documents
- Mouse back/forward button support
- Breadcrumb navigation
- Customizable navigation gutter — hide/show any gutter icon (modes, extension panels, indicators) and drag-to-reorder within a group via a "Customize Gutter" popover (right-click the gutter) or right-click any icon to hide it; preferences are global across projects, and the account/settings button always stays visible

## Window & Application

- Multi-window support with per-project state persistence
- Multi-project rail with an optional "Allow unlimited projects" setting. The default is eight projects per window; enabling unlimited projects can use more memory and CPU. Turning it off keeps current and restored projects open.
- Project Manager (Cmd+P)
- System tray with session status and click-to-navigate
- macOS menu bar fleet monitoring -- follow active sessions, see which need attention, and open them from the menu bar
- Dock badge for sessions needing attention
- OS notifications for session events
- Sound notifications
- Auto-updater with toast notification
- Deferred restart (waits for active AI sessions)
- Linux `.deb` package for Debian and Ubuntu, which starts on Ubuntu 24.04 and later where the AppImage is blocked by AppArmor's user-namespace restriction
- SQLite for new installs and migration from existing PGLite databases, retaining original data and recovery copies; backup and recovery controls in Database settings

## Onboarding & Help

- Unified onboarding wizard
- Ready-made tutorial project with documents, data, designs, plans, and example sessions, available on first launch and from the Project Manager or Help menu
- Walkthrough guide system (multi-step floating guides)
- Contextual tips system (targeted tip cards: floating, empty-transcript inline, and Files empty state; All Tips dialog)
- Files-mode empty state with New file and Ask-the-agent action cards, example prompt chips, and rotating tips
- Help tooltips (hover, keyed by data-testid)
- Keyboard shortcuts dialog (Cmd+?)
- Community channels popup (Discord, YouTube, LinkedIn, X, TikTok, Instagram)

## Feedback & Bug Reporting

- In-app feedback intake dialog (gutter feedback button) with two paths: Report a bug, Request a feature
- Inline log-gathering consent checkbox with anonymization warning
- Each path launches a guided Claude agent session via the `nimbalyst-feedback` claude-plugin (`/nimbalyst-feedback:bug-report` and `/nimbalyst-feedback:feature-request`)
- Two-pass anonymization: regex pass via `feedback_anonymize_text` MCP tool, then LLM second-pass review before any redacted text is shown to the user
- Issue posting via `feedback_open_github_issue` MCP tool, which opens a pre-filled `github.com/nimbalyst/nimbalyst/issues/new` URL using the right issue-form template (`bug_report.yml` or `feature_request.yml`) and routes the body into the template's primary textarea field; the template's frontmatter applies the GitHub issue type and `status:needs-triage` label automatically. Falls back to copy-paste when the body exceeds the safe URL length
- Secondary links: Browse existing issues, Discuss on GitHub Discussions, Email private feedback to support@nimbalyst.com

## Analytics

- PostHog integration (opt-in, anonymous)
- AI usage report with historical graph and activity heatmap
- Claude model-specific weekly usage percentages and reset times, including Fable
- Per-project usage breakdown
- Per-tool usage tracking (local counters for built-in and MCP/extension tools) surfaced as a Tools section in the AI usage report (top tools, built-in vs MCP split, over-time, per-provider) and as a targeting signal for contextual tips; backfill from past claude-code and codex sessions
- Developer Dashboard Renders tab for inspecting component re-render counts and causes
