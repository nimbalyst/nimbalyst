# Nimbalyst Feature Inventory

A curated reference of Nimbalyst's notable capabilities, organized to help people discover what they can do with the product.

Maintain this when notable capabilities are added, significantly expanded, or removed; follow the root [CLAUDE.md](../CLAUDE.md) inclusion test. Group supporting details under the capability they explain. Routine polish, counters, badges, button placement, and performance fixes do not need entries. Keep platform and opt-in limits explicit. Extension features require the corresponding extension to be installed and enabled.

## Editors

- **Lexical rich text editor** (`.md`, `.txt`, `.mdc`) -- WYSIWYG with markdown shortcuts, slash commands, embedded diagrams, collaborative editing
- **Monaco code editor** (all code file types) -- syntax highlighting, IntelliSense, multi-cursor
- **CSV spreadsheet editor** (`.csv`, `.tsv`) -- formulas, typed columns, formatting, sorting/filtering, and AI data analysis and formula application
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
- Live custom-editor embeds in Markdown through a standalone file link, including mockups, data models, and animations
- Editor-header session history -- open the last AI session that worked on a file, choose another associated session, or start a new one
- Shared mockup comments anchored to a spot in the design, with live pins and agent read/reply support
- Decision blocks inside documents -- solo or collaborative voting on a decision, with the attributed outcome sealed into the markdown itself so it survives outside Nimbalyst

## AI Providers

Twelve built-in provider lanes, plus any agent an extension contributes. Every lane runs on keys the user entered in Nimbalyst settings or on a CLI the user already logged into — no provider is read from the environment, and no lane is required for another to work.

**Chat**

- Claude (direct Anthropic API)
- OpenAI / ChatGPT (direct API)
- LM Studio (local models, auto-discovered)

**Coding agents**

- Claude Code (Agent SDK with MCP, file access, plan mode, sub-agents)
- Claude Code CLI (off by default; the genuine CLI driven in a terminal, with a raw-terminal drawer for its native pickers and mid-session `/model` switching)
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
- Drag-and-drop reparenting into workstreams
- Session launch history links orchestrating sessions to the sessions they created

## Workstreams

- Parent sessions grouping related child sessions
- Workstream editor tabs (multi-file editing per session)
- Workstream session tabs (switch between child sessions)
- Agent-to-agent session spawning (`/launch-new-session` slash command + `spawn_session` MCP tool) — sibling mode auto-promotes the caller into a workstream so the new session shares files-edited, tabs, and `get_workstream_overview`; isolated mode (`isolated: true`) creates a top-level session with no parent so fix-and-commit work doesn't pollute the caller's workstream
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
- Hierarchical session navigation (workstream/worktree aware)
- Create and follow Meta Agent sessions with children grouped under their parent when the desktop-synced Meta Agent alpha feature is enabled
- Multiple signed-in accounts with an active account for personal sync
- Mobile voice mode (soft chime + haptic cue when the session connects and it's your turn to talk)
- Mobile voice audio selection: view the active microphone and speaker, choose supported routes through native pickers (iOS 26 microphone picker with an older-iOS fallback), and switch to the phone speaker. Headphone disconnection pauses voice until explicit Resume.
- Mobile voice: asking the voice agent to start a new session opens it automatically on the device that asked
- Mobile voice: the floating mic shows a tool-call indicator (animated ring + tool-icon badge) while the agent runs a tool
- Mobile voice follows the session on screen for summaries and new tasks, while queued tasks and presented questions retain their source session. GPT Live preview supports spoken answers to simple questions, one-time permissions, and commit proposals after the app reads the exact prompt aloud; requires an updated source desktop with its workspace open. Longer or richer prompts and older hosts use existing UI cards.
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
- Start a desktop-backed session from Android
- Submit prompts with image attachments
- Answer interactive prompts (tool permissions, questions, plan approvals) from mobile
- Queued prompt management
- AI model picker (synced from desktop)
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
- Shared document list
- Share Folder to Team publishes supported files recursively and mirrors the folder hierarchy
- First-class shared folders — real synced folder entities (not path-in-title) with a full right-click menu: New Document, New Folder, Rename, Copy Link, and recursive Delete (with a document/subfolder count confirmation). Folders move by drag-and-drop (in or out of other folders); renaming or moving a folder keeps every document's local-to-shared link intact because the folder id is stable. A folder deep link (`nimbalyst://folder/…`) opens Collab mode focused on the folder. AI agents can create, move, rename, and delete shared files and folders through MCP tools that use the same path a person does
- Shared Docs discovery home — a center-pane hub (full-bleed empty state, or an overlay reachable via the sidebar Home button while docs are open) with title search, Favorites, Recently opened, and a New & Changed section that classifies unread docs as "New" (never opened) vs "Updated" (changed since you last viewed), plus a sortable full list, folder browsing, and row actions to open, rename, move, or trash
- Favorite shared docs — star a doc from the hub or sidebar (local per-user); powers a Favorites hub section and a sidebar filter
- Shared Docs sidebar filter — segmented All / Favorites / Updated view over the doc tree (persisted per workspace)
- Unread indicators on shared docs — a dot on a doc's sidebar entry when it is new or its content/title changed (by someone else) since you last opened it; clears when you open it; the doc index carries the last writer so your own edits (including cross-device) are suppressed. The sidebar overflow menu can hide the dots or mark all docs read, and a doc's context menu can mark just that one read
- **Extension-provided collab editors** — SDK `useCollaborativeEditor` hook lets any extension (Excalidraw, CSV spreadsheet, DatamodelLM shipped; others can opt in via `collaboration.supported` manifest flag) share its file type to team with real-time multi-client editing, cursors, and selection
- **Shared naming projects (Namenym extension)** — concurrent brief, theme, word, candidate and note editing; personal favorites with attributed team totals; legacy shortlists remain unattributed. Desktop AI generation shares results live, and domain searches run only on explicit request in shared documents. Favorites are editable document content, not audited approvals.
- **Offline-first shared documents** -- read and edit cached documents offline, with locally encrypted storage and synchronization when reconnected
- Linked local files can pull the latest shared-document content from the editor header; shared version history previews a version before restoration
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
- Knowledge wiki (its own nav item) -- knowledge items (entities, questions, findings) in a team project read as wiki pages under a tree of areas, starting from an editable home page with a "Needs you" list and recent decisions and changes. Each page has a collaborative, commentable body, an About/Connections rail, and a roll-up of its child pages and open questions; an area whose pages share comparison fields shows them as a live table. Tracker links in prose render as quiet title links with a hover peek, or as a live card or statements block. The state can be changed from the page, and agent-proposed items or state changes are kept or dismissed in place. The browser editor can insert tracker references and embedded cards (typeahead and slash menu), in the same markdown as desktop. Card and statements views render only in the web console; desktop shows links as chips. Requires knowledge types shared with the team
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
- Personal and team trackers, with unpublished team items remaining private and local item numbers available before publishing
- Table editing with multi-cell operations and undo/redo
- Tracker-item context menus open linked AI sessions or launch a new session or worktree; draft plans with linked commits show a status-mismatch chip
- Unread indicators — a dot on tracker rows/cards (list, kanban, tag board) when an item is new or was changed by someone else since you last viewed it; clears when you open it; your own edits and views sync across your devices (personal channel), and AI-agent edits count as unread
- Encrypted sync across team members (server-managed, encrypted at rest per team)
- Inline `#type` items in markdown (TrackerPlugin)
- Live tracker reference links — `#` in a document references an existing tracker item, inserting a chip that shows the item's current status and title (resolved live, not a snapshot) and links to it; serialized as portable `[NIM-123](nimbalyst://NIM-123)` markdown; the same link renders as a live chip in the AI transcript; one-click "convert to tracked reference" turns a legacy inline embed into a real tracked item plus a reference chip
- Tracker schema overrides in Trackers settings -- customize a built-in type into `.nimbalyst/trackers`, edit an existing override, reset back to the built-in default, and resync the local database mirror when schema files drift
- External-source importers: import GitHub issues (extension-provided) into the tracker as native bug, task, or feature items with a back-link to the source, a "from GitHub" chip, re-snapshot ("pull latest from source") with conservative merge, and a Source filter; agent tools `tracker_importer_list` / `tracker_importer_search` / `tracker_import` / `tracker_resnapshot` / `tracker_get_by_urn`
- Per-project "AI Agent Access" toggle in tracker settings -- allow or block AI agents from using tracker tools in that project (on by default)
- Knowledge kinds -- agents set up entity, claim, question, finding, and investigation trackers and a project vocabulary of relationship verbs (`.nimbalyst/predicates.yaml`) from the Knowledge extension's shared ontology, as team trackers in team projects; source, capture, and citation types stay hidden until the project defines `claim`. Knowledge kinds keep a full revision history, and a citation pins the exact revision of whatever it cites (any item type), shown in a citation inspector on the item detail
- Radar -- a since-you-left digest for a shared tracker covering teammate activity, status moves, bulk sweeps, and work that has gone stalled; available in the desktop app and the web console, and to agents via the `work_radar` tool so a session can check for concurrent work before starting on an item

## Shared Links

- Share markdown files as E2E encrypted links
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
- Extension hot reload
- Extension developer kit with scaffolding
- Extension marketplace (alpha)

### Built-in Extensions

- Animation — step-based animated explainer diagrams, with an authoring skill and an `/animate` command
- Automations
- Astro Editor
- CSV Spreadsheet
- Calc Sheets
- DataModelLM
- Developer Tools
- Excalidraw
- Extension Dev Kit
- Git -- commit history, diffs, push/pull, and branch operations
- GitHub Issues Importer
- Image Generation
- iOS Dev Tools
- Knowledge -- off by default; agent skill carrying the shared knowledge-graph ontology (kinds, fields, relationship verbs, and a hierarchy of areas) so team and public knowledge graphs stay consistent
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

- Customize each project’s initials, color, or image in Project Settings → Appearance or from the project rail’s context menu. Overrides stay on this computer, survive closing and reopening projects, and can be reset to the automatic defaults.

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
