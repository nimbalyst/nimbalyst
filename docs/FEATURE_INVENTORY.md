# Nimbalyst Feature Inventory

A concise reference of all features in the product. Keep this up to date as features ship.

## Editors

- **Lexical rich text editor** (`.md`, `.txt`, `.mdc`) -- WYSIWYG with markdown shortcuts, slash commands, embedded diagrams, collaborative editing
- **Monaco code editor** (all code file types) -- syntax highlighting, IntelliSense, multi-cursor
- **CSV spreadsheet editor** (`.csv`, `.tsv`) -- formula support, sorting, filtering
- **Excalidraw diagram editor** (`.excalidraw`) -- whiteboard-style diagramming with Mermaid import, AI tools, and real-time multi-client Share-to-Team collab
- **DataModelLM editor** (`.prisma`, `.datamodel`) -- visual ER diagrams with export to SQL/JSON/DBML
- **MockupLM editor** (`.mockup.html`) -- visual HTML/CSS mockup rendering with annotation layer
- **PDF viewer** (`.pdf`)
- **SQLite browser** (`.db`, `.sqlite`) -- table browsing, SQL query runner, AI tools
- **Browser** (`.html`, `.htm`, `.browser.json`) -- native Chromium `WebContentsView` (not an iframe, so frame-blocking sites load), URL bar / back-forward / reload, workspace-scoped `nim-preview://` local preview, source-mode toggle, and agentic control AI tools (navigate, click, type, evaluate, scroll, get_page_info, screenshot) over editor-backed or agent-owned headless sessions
- **Image generation project editor** (`.imgproj`) -- multi-variant AI image generation with iterative refinement
- **Astro editor** (`.astro`) -- schema-aware frontmatter form header
- **Image viewer** (`.png`, `.jpg`, `.gif`, `.svg`, `.webp`, `.bmp`, `.ico`)

### Cross-Editor Features

- Source mode toggle (raw file view)
- Diff mode for AI edits with per-file approve/reject bar
- Approve all / reject all pending changes
- Cell-level diff highlighting (CSV), visual diff slider (MockupLM), side-by-side diff (Monaco)
- Document history with diff viewer
- Auto-save

## AI Providers

- Claude (direct Anthropic API)
- Claude Code (Agent SDK with MCP, file access, plan mode, sub-agents)
- OpenAI / ChatGPT (direct API)
- OpenAI Codex (SDK with MCP support)
- LM Studio (local models, auto-discovered)

## AI Sessions

- Session creation, naming, archiving, deletion
- Launch a new session from any workspace mode with the reusable composer popup (Cmd+Shift+N), including model/mode controls, mentions, slash commands, and attachments
- Session search with full-text index (Cmd+L)
- Session pinning
- Session branching / forking
- Session tags and phase tracking
- Session HTML export and clipboard copy
- Shareable session links (E2E encrypted, 1/7/30 day expiry)
- Import Claude Code sessions
- Session draft persistence (unsent input preserved)
- Read/unread indicators
- Auto-continue sessions after app restart
- AI auto-naming of sessions after first turn
- Virtualized session list for large histories
- Drag-and-drop reparenting into workstreams

## Workstreams

- Parent sessions grouping related child sessions
- Workstream editor tabs (multi-file editing per session)
- Workstream session tabs (switch between child sessions)
- Workstream header with active session highlight
- Uncommitted files count per session
- Agent-to-agent session spawning (`/launch-new-session` slash command + `spawn_session` MCP tool) — sibling mode auto-promotes the caller into a workstream so the new session shares files-edited, tabs, and `get_workstream_overview`; isolated mode (`isolated: true`) creates a top-level session with no parent so fix-and-commit work doesn't pollute the caller's workstream

## Session Kanban Board

- Sessions organized into phase columns (backlog / planning / implementing / validating / complete)
- Keyboard navigation (arrows, Enter, Space)
- Move cards between phases (Cmd+arrows)
- Collapsible columns
- Configurable columns
- Auto-exit kanban when navigating to a session
- Agent-assisted cleanup (`/session-cleanup` slash command in the Planning extension) — audits sessions, proposes phase corrections and "mark complete" candidates for approval, and flags old sessions to archive

## Agent Mode

- Full-screen AI session interface
- Agent navigation badge with a grouped list of sessions awaiting input, running, or unread
- Plan mode toggle (Shift+Tab)
- Effort level selector (low/medium/high/max)
- Model selector (per-session or per-workstream)
- Context window usage display with pace tracking
- Files-edited sidebar with per-session scope
- Pending review banner (approve/reject AI changes)
- Red/green diff display per tool call
- Approve all / reject all pending changes
- Interactive prompts (durable, persist across restarts):
  - AskUserQuestion
  - ExitPlanMode / plan approval
  - GitCommitProposal
  - ToolPermission
- Rate limit warning (amber) and blocked (red) widgets
- Scheduled wakeups (agent self-paces via `schedule_wakeup` MCP tool; persists across restarts; banner with Fire now / Cancel; clock icon on session list rows; OS notification on fire; overdue prompt on launch)
- Transcript with collapsible tool call groups
- Click-to-copy code blocks
- Turn summary ("Finished in Xm Ys, N files +N -N")
- File `@` mention in input
- Image attachment support
- Selection chips above the input showing what will be sent as context (selected text, mockup annotations, and extension-provided items from node-like editors such as Excalidraw); each chip has an × to drop it from the prompt, and node-like editors can report multiple selections at once
- Queued prompts display
- Slash command typeahead
- Action prompts dropdown in composer (reusable prompt presets defined in `nimbalyst-local/ai-actions.md`; pick to insert verbatim into the draft, with undo support)

## Multi-Agent / Teams

- Sub-agent (teammate) spawning
- Teammate sidebar (status, elapsed time, tool count)
- Click-to-scroll to teammate spawn point
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
- Git operations panel (stage, commit, push)
- AI-assisted commit message generation
- Interactive git commit proposal widget
- Commit history view with ahead/behind tracking
- Auto-commit mode (toggle)
- Merge/rebase conflict dialogs
- Git ref watcher (detects external git operations)
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

## File Management

- File tree with expand/collapse and keyboard navigation
- Virtualized file tree for large repositories
- Context menu: rename, delete, reveal in Finder, open externally, copy path, move, copy
- Drag-and-drop file/folder operations (Option/Alt to copy)
- File watching with auto-reload on external changes
- .gitignore-aware filtering
- New file dialog with type selection and folder picker
- New browser tab (Cmd+Shift+B) -- opens a fileless Browser virtual tab in files mode
- Quick open (Cmd+O)
- Content search across files (Cmd+Shift+F)
- Auto-save (configurable interval)
- Local file history with diff viewer (Cmd+Y)
- Document history with configurable retention

## Tab System

- Multi-tab editing with tab bar
- Dirty indicator
- Reopen closed tab (Cmd+Shift+T)
- Navigate between tabs (Cmd+Option+Left/Right)
- Close tab (Cmd+W)
- Double-click a tab to maximize the editor to the whole window (collapses surrounding panels); double-click again to restore — works in Files, Agent, and Shared Docs modes
- Unified editor header bar
- Extension-contributed document headers

## Voice Mode

- Voice control via OpenAI Realtime API (gpt-realtime-2 by default, with automatic fallback to gpt-realtime)
- Selectable model and reasoning effort in settings
- Automatic reconnect with backoff on dropped connections (transient "reconnecting" state; voice/model preserved)
- Live transcription streaming
- Voice commands with countdown before submit
- Interactive prompt answering (verbal AskUserQuestion, plan approval, git commit)
- Idle timer management
- Wake-from-sleep handling
- Echo cancellation
- Extension-contributed voice tools (`voiceAgent: true` AI tools) and voice session-context providers — any extension can expose tools and start-of-session context to the voice agent
- Backend-module voice/agent tools — an extension's utility-process can register MCP tools dispatched in-process (no renderer hop), enabling native engines to answer the voice and coding agents sub-second
- Project-knowledge grounding (Nimbalyst Memory extension) — local hybrid search over your design docs, plans, CLAUDE.md, and notes, available to the voice and coding agents
- Hands-free brainstorm loop — talk an idea through, kick off a plan (`/design`), have the agent read the written plan back to refine it by voice, then `/implement`; ask "is it done yet?" anytime for live task status
- Voice agent tool calls (memory lookups, coding-agent questions, and more) are recorded in the voice session transcript and render as tool widgets, including a dedicated memory-recall widget showing the query and the returned source documents (title + snippet)
- Available on both desktop and iOS

## Mobile (iOS)

- Native SwiftUI app with encrypted sync
- Session list with search and pull-to-refresh
- Session transcript viewing (WebView)
- Compose bar with slash command typeahead
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
- Mobile voice mode (soft chime + haptic cue when the session connects and it's your turn to talk)
- Mobile voice: asking the voice agent to start a new session opens it automatically on the device that asked
- Mobile voice: the floating mic shows a tool-call indicator (animated ring + tool-icon badge) while the agent runs a tool

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

> **Encryption posture.** Team collaboration data (trackers, documents, doc-index
> titles) is **encrypted in transit and at rest, isolated per team, and operated
> by Nimbalyst**. New teams use server-managed custody (Epic H2 — the server
> holds a per-team KMS-wrapped key and encrypts at rest, enabling
> web/CLI/cloud-agent access). Existing `legacy-e2e` teams are transitional and
> migrate silently, one-way, after an org-wide local plaintext recovery sweep.
> **Server-managed team
> data is not zero-knowledge.** **Personal sync** (your desktop ↔ phone: sessions,
> prompts, drafts, settings, personal index) **stays zero-knowledge** — the server
> never holds those keys. Customers who require true zero-knowledge for team data
> run the software on their own infrastructure (self-host).

- Real-time document editing (Lexical + yJS through Cloudflare Workers)
- Encrypted tracker item sync (zero-knowledge in `legacy-e2e`; server-managed at-rest in H2)
- Team trust model with ECDH key exchange and key envelopes (legacy-e2e mode)
- Server-managed per-team encryption keys (Epic H2): KMS-wrapped split-knowledge DEK, admin key-recovery, append-only audit log
- Stytch B2B org management
- Team invite / join / role management
- Personal org + team org separation
- Multiple projects per organization — add another workspace to an existing org as its own tracker space (sharing the org's roster and encryption)
- Three-scope Settings information architecture (Application | Account | Project) with typed deep links; organization administration lives in a dedicated organization window
- Dedicated organization-management window (opened from the organization switcher or the account inspector) with read-only roster, teammate invitations, project sharing, workspace → organization → bound-account identity, an interim administration area, and a web-console deep-link
- Global multi-account inspector in the navigation footer with per-account organization ownership, sync-account selection, add/sign-out/reconnect actions, and visible expired-session recovery
- Every organization you belong to, listed inline under its login in Account settings — role, membership state, project count, a Manage button that opens the organization window for that org, in-place invite acceptance, a New organization action, and a manual refresh; organizations reachable from more than one login appear once, under the login that authorizes them
- Organization window reachable on its own — a Window menu entry opens it without picking an org first, an in-window switcher moves between every organization you actively belong to, and it reopens on the organization you used last (falling back to your first one)
- Account settings split into one screen per topic — Accounts, Mobile App, Devices, and Shared Links are separate left-nav items, each with a single title instead of stacked headers; old links land on the screen that now owns their section
- Pick mobile projects in bulk — the Mobile App screen lists every project as a checkbox with Select all / Deselect all, so many projects (and their document sync) change in one interaction instead of one control at a time
- Decision-first project sharing — Project Settings → Sharing asks one question (add to an organization you already administer, or create a new one), then confirms in plain words what will happen and who gets access; a missing git remote is explained rather than silently disabling the flow. Projects are always added from the project itself, not by name from the organization window
- Per-personal-account mobile-sync profiles — project and document selections are retained when switching the active zero-knowledge sync account, independently of team organization selection
- Move a project to another organization — relocates its trackers, documents, history, and schemas into the destination, transfers member access by email (auto-invite for members not yet in the destination, with a per-person opt-out and seat-delta preview), and redirects the old location (server-managed orgs only)
- Merge one organization into another — consolidates every project, unions the rosters (higher role wins), and optionally deletes the drained org
- Shared document list
- First-class shared folders — real synced folder entities (not path-in-title) with a full right-click menu: New Document, New Folder, Rename, Copy Link, and recursive Delete (with a document/subfolder count confirmation). Folders move by drag-and-drop (in or out of other folders); renaming or moving a folder keeps every document's local-to-shared link intact because the folder id is stable. A folder deep link (`nimbalyst://folder/…`) opens Collab mode focused on the folder. AI agents can create, move, rename, and delete shared files and folders through MCP tools that use the same path a person does
- Shared Docs discovery home — a center-pane hub (full-bleed empty state, or an overlay reachable via the sidebar Home button while docs are open) with title search, Favorites, Recently opened, and a New & Changed section that classifies unread docs as "New" (never opened) vs "Updated" (changed since you last viewed), plus a sortable full list
- Favorite shared docs — star a doc from the hub or sidebar (local per-user); powers a Favorites hub section and a sidebar filter
- Shared Docs sidebar filter — segmented All / Favorites / Updated view over the doc tree (persisted per workspace)
- Unread indicators on shared docs — a dot on a doc's sidebar entry when it is new or its content/title changed (by someone else) since you last opened it; clears when you open it; the doc index carries the last writer so your own edits (including cross-device) are suppressed. The sidebar overflow menu can hide the dots or mark all docs read, and a doc's context menu can mark just that one read
- Key envelope distribution for new members
- Durable Objects per entity (session, document, tracker, team, index)
- **Extension-provided collab editors** — SDK `useCollaborativeEditor` hook lets any extension (Excalidraw, CSV spreadsheet, DatamodelLM shipped; others can opt in via `collaboration.supported` manifest flag) share its file type to team with real-time multi-client editing, cursors, and selection
- **Client-side snapshot compaction** — connected clients periodically send `docCompact` so initial sync stays fast as edit history grows (single-elector by lowest userId)
- **Offline-first shared documents** — device-key-encrypted Yjs replicas, durable body and attachment outboxes, cache-first `collab-asset://` resolution, separate replica/asset LRU budgets, and honest unavailable-asset placeholders. Always on (no flag).

## Tracker System

- Tracker mode (Cmd+T) with list, table, kanban, and tag-board views
- Kanban columns honor each type's status order from its schema (no hardcoded order)
- Tag-board view with one column per tag (items appear in every matching column, plus an Untagged column)
- Saved views: name, save, apply, and delete reusable filter/layout views per workspace
- Configurable tracker item types (bugs, tasks, architecture docs, decisions, etc.)
- Tracker sidebar with type counts
- Item detail panel
- Unread indicators — a dot on tracker rows/cards (list, kanban, tag board) when an item is new or was changed by someone else since you last viewed it; clears when you open it; your own edits and views sync across your devices (personal channel), and AI-agent edits count as unread
- Encrypted sync across team members (zero-knowledge in `legacy-e2e`; server-managed at-rest in H2)
- Inline `#type` items in markdown (TrackerPlugin)
- Live tracker reference links — `#` in a document references an existing tracker item, inserting a chip that shows the item's current status and title (resolved live, not a snapshot) and links to it; serialized as portable `[NIM-123](nimbalyst://NIM-123)` markdown; the same link renders as a live chip in the AI transcript; one-click "convert to tracked reference" turns a legacy inline embed into a real tracked item plus a reference chip
- Tracker schema overrides in Trackers settings -- customize a built-in type into `.nimbalyst/trackers`, edit an existing override, reset back to the built-in default, and resync the local database mirror when schema files drift
- External-source importers: import GitHub issues (extension-provided) into the tracker as native bug, task, or feature items with a back-link to the source, a "from GitHub" chip, re-snapshot ("pull latest from source") with conservative merge, and a Source filter; agent tools `tracker_importer_list` / `tracker_importer_search` / `tracker_import` / `tracker_resnapshot` / `tracker_get_by_urn`
- Per-project "AI Agent Access" toggle in tracker settings -- allow or block AI agents from using tracker tools in that project (on by default)

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

- Automations
- Astro Editor
- CSV Spreadsheet
- DataModelLM
- Developer Tools
- Excalidraw
- Extension Dev Kit
- GitHub Issues Importer
- Image Generation
- iOS Dev Tools
- MockupLM
- Nimbalyst Memory — local project-knowledge brain (hybrid search + facts) for the voice and coding agents
- PDF Viewer
- Planning
- Project Graph — navigable whole-project graph of plans, trackers, sessions, commits, and files, with a horizontally scrollable **Timeline mode** (phase-colored lifecycle bars per item; collapse items into per-tag activity lanes)
- SQLite Browser

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

## Terminal

- Built-in terminal panel (Ctrl+`)
- Multiple terminal tabs
- Theme integration
- Clickable links
- Command running indicator per tab
- Worktree-specific terminal sessions
- Context menu (clear, rename)
- Claude Code CLI sessions: raw-terminal drawer auto-reveals and focuses when the genuine CLI opens a native picker (`/model`, `/config`, `/login`, …)
- Claude Code CLI sessions: raw-terminal drawer is vertically resizable and remembers its height and collapsed state per session
- Claude Code CLI sessions: mid-session model switching from the model picker (drives the CLI's `/model` command; idle turns only)
- Claude Fable 5 selectable across all Claude providers (chat, Claude Agent, Claude Code CLI)
- Claude Sonnet 5 selectable across all Claude providers, with the previous Sonnet 4.6 still selectable as a pinned choice

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

## Theming

- Light, Dark, Crystal Dark, Auto (system)
- Extension-contributed themes
- CSS variable system (`--nim-*`)
- Terminal ANSI color theming
- Syntax highlighting colors per theme
- Diff colors per theme
- System tray icon follows system appearance

## Navigation

- Back/forward history (Cmd+[ / Cmd+])
- Cross-mode navigation
- Session quick open (Cmd+L) — Shift+Tab searches message contents, not just titles
- Prompt quick open (Cmd+Shift+L)
- Content search (Cmd+Shift+F)
- Memory search (Cmd+Shift+O) — a Quick Open "Memory" tab with Docs, Trackers, and Sessions scopes for hybrid semantic + keyword lookup, powered by the Nimbalyst Memory extension; appears only when that extension is enabled. Tracker results retain issue keys, status, type filters, and exact-match lookup; AI session indexing is optional and off by default
- Shared team document quick open (Cmd+Shift+D) — a team-gated Quick Open tab with name filtering, unread/favorite cues, and direct navigation into Shared Documents
- Mouse back/forward button support
- Breadcrumb navigation
- Customizable navigation gutter — hide/show any gutter icon (modes, extension panels, indicators) and drag-to-reorder within a group via a "Customize Gutter" popover (right-click the gutter) or right-click any icon to hide it; preferences are global across projects, and the account/settings button always stays visible

## Window & Application

- Multi-window support with per-project state persistence
- Project Manager (Cmd+P)
- System tray with session status and click-to-navigate
- Dock badge for sessions needing attention
- OS notifications for session events
- Sound notifications
- Auto-updater with toast notification
- Deferred restart (waits for active AI sessions)
- Splash screen
- Rosetta warning on Apple Silicon
- PGLite database with PID-based locking and backup

## Onboarding & Help

- Unified onboarding wizard
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
- Per-project usage breakdown
- Per-tool usage tracking (local counters for built-in and MCP/extension tools) surfaced as a Tools section in the AI usage report (top tools, built-in vs MCP split, over-time, per-provider) and as a targeting signal for contextual tips; backfill from past claude-code and codex sessions
