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

## Agent Mode

- Full-screen AI session interface
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
- Unified editor header bar
- Extension-contributed document headers

## Voice Mode

- Voice control via OpenAI Realtime API
- Live transcription streaming
- Voice commands with countdown before submit
- Interactive prompt answering (verbal AskUserQuestion, plan approval, git commit)
- Idle timer management
- Wake-from-sleep handling
- Echo cancellation
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
- Mobile voice mode

## Collaboration (E2E Encrypted)

- Real-time document editing (Lexical + yJS through Cloudflare Workers)
- E2E encrypted tracker item sync
- Team trust model with ECDH key exchange and key envelopes
- Stytch B2B org management
- Team invite / join / role management
- Personal org + team org separation
- Shared document list
- Key envelope distribution for new members
- Durable Objects per entity (session, document, tracker, team, index)
- **Extension-provided collab editors** — SDK `useCollaborativeEditor` hook lets any extension (Excalidraw, CSV spreadsheet, DatamodelLM shipped; others can opt in via `collaboration.supported` manifest flag) share its file type to team with real-time multi-client editing, cursors, and selection
- **Client-side snapshot compaction** — connected clients periodically send `docCompact` so initial sync stays fast as edit history grows (single-elector by lowest userId)

## Tracker System

- Tracker mode (Cmd+T) with kanban and list views
- Configurable tracker item types (bugs, tasks, architecture docs, decisions, etc.)
- Tracker sidebar with type counts
- Item detail panel
- E2E encrypted sync across team members
- Inline `#type` items in markdown (TrackerPlugin)

## Shared Links

- Share markdown files as E2E encrypted links
- Share AI sessions as encrypted links
- Expiration options: 1/7/30 days
- Shared links management panel in settings

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
- Settings panel contribution
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
- Image Generation
- iOS Dev Tools
- MockupLM
- PDF Viewer
- Planning
- SQLite Browser

## MCP Servers (Internal)

- Session context (summaries, workstream overview, recent sessions, edited files, scheduled wakeups)
- Session naming (name, tags, phase)
- Meta-agent (`create_session`, `spawn_session`, `send_prompt`, `respond_to_prompt`, `get_session_status`, `get_session_result`, `list_spawned_sessions`, `list_worktrees`) — lets a session spawn and orchestrate child, sibling, or isolated sessions
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

## Settings

- Global: theme, AI providers, MCP servers, notifications, sync/account, shared links, advanced, beta features
- Per-workspace: AI provider override, agent permissions, team, tracker config, extensions
- Claude Code: custom executable path, environment variables, effort slider, plan mode, auto-commit, extended context
- Multi-account support (add/remove accounts, per-project binding)
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
- Mouse back/forward button support
- Breadcrumb navigation

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
