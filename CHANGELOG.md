# Changelog

All notable changes to Nimbalyst will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]

### Added
- Internal scaffolding for the upcoming PR review panel: detects whether the `gh` CLI is installed and authenticated, with an onboarding banner that guides install/login without ever storing a GitHub token. (#307)
- PR review cache schema (`pull_requests`, `pull_request_files`, `pull_request_commits`, `pull_request_checks`) and `worktrees.pr_*` linkage columns, plus a typed `PullRequestsStore` and `WorktreeStore.linkPullRequest` / `findByPullRequest` helpers. (#307)
- `GhApiService` and IPC channels (`pr:list`, `pr:get`, `pr:files`, `pr:file-contents`, `pr:commits`, `pr:checks`, `pr:conversation`, `pr:refresh`, `pr:detect-remote`) that fetch GitHub data via `gh api` and persist normalized rows to the cache. (#307)
- `PullRequestPollScheduler` that polls open PRs every 60s when the PR review panel is in the foreground and every 5min otherwise, broadcasting `pr:list-updated` after each successful tick so the renderer re-reads the cache. (#307)
- A `pr-review` workspace mode with a navigation-gutter button (with a help tooltip and the `Cmd/Ctrl+U` shortcut) that appears only when the active project has a GitHub remote, wired to PR atoms and listeners (gh status, remote detection, list-updated). (#307)
- PR list view with a filter sidebar (open/closed/awaiting-review/created-by-me/with-conflicts/draft), title/number search, and sortable columns (last activity / created / number); selecting the state filter fetches via `gh`, the rest narrow client-side. (#307)
- Read-only PR detail panel with Conversation, Files Changed (Monaco side-by-side diff), Commits, and Checks tabs; the panel re-fetches its visible tab every 60s while open. (#307)
- "Open in Worktree" on a PR fetches the PR head branch into a worktree (reused if it already exists), links the worktree to the PR, spawns/reuses an agent session in it, and switches to Agent mode. (#307)
- Approve and merge a PR (squash / merge commit / rebase) from the detail header, gated by the viewer's `gh`-derived repo permissions and the repo's allowed merge methods; merging requires an explicit in-app confirm. (#307)
- Edit the merge commit title/message before merging (squash / merge-commit) via the merge dropdown's "Edit commit message…" option. (#307)
- Inline review threads in the Conversation tab, grouped by file with Open/Resolved status and resolved threads collapsed by default (via `gh api graphql`). (#307)
- `NIMBALYST_GH_PATH` env var to pin a non-standard `gh` CLI location for PR review. (#307)
- Per-project GitHub account for PR review: pick a global default `gh` account in User settings and override it per project in Project settings (GitHub panel). The selected account's token is resolved from the `gh` keyring per request and never stored by Nimbalyst. (#307)
- A guided walkthrough that introduces the PR review mode from the navigation gutter. (#307)
- PR review Files Changed adds a "Collapsed diff" mode: a scrollable diff across all changed files with syntax highlighting, line numbers, and red/green backgrounds, switchable between unified and side-by-side (split) layouts. (#307)
- Refresh button in the Files Mode sidebar header reloads the file tree from disk without using the Developer menu. (#259)
<!-- New features go here -->
- Claude Code sessions use the SDK's `permissionMode: 'auto'` classifier when workspace trust is "Allow All"; safe operations run silently, uncertain ones prompt the user. (#379)
- File paths mentioned in AI transcripts are now clickable links that open the file, even when the agent writes them as plain text or inline code.
- New Browser Tab command in the File menu (Cmd+Shift+B) opens a browser virtual tab in files mode.
- Quick Open's Sessions tab can now search message contents (Shift+Tab or the in-input button), not just titles.
- Inline comments on shared documents: select text to add a comment, reply in threads with @-mentions, and resolve threads, all synced in realtime across collaborators.

### Changed
<!-- Changes to existing functionality go here -->
- PR review now uses a persistent master/detail layout with the PR list and filters fixed in the left sidebar. (#307)
- PR review Files Changed groups files into a collapsible directory tree (expanded by default) and colors filenames by status instead of A/M/D letters. (#307)
- PR list rows lead with the title at full width, moving the PR number to the metadata line so long titles stay readable. (#307)
- PR review GitHub account settings now appear only in Developer Mode. (#307)
- Calc Sheets now ship a Falcon 9 `.calc.md` demo and custom syntax coloring for headings, comments, variables, units, and formatters.

### Fixed
- Inline tracker item edits now save back to the markdown file for markers without an explicit id, and due-date edits persist across a re-scan instead of being dropped (#404).
- PR review now shows an actionable message on a GitHub 404 (repo not found or the active `gh` account lacks access — check `gh auth status` / `gh auth switch`) instead of a raw error, and no longer prints a duplicated `api` in the failure text. (#307)
- PR review cache tables are now created on the better-sqlite3 backend too (migration registered with the SQLite runner), not only on PGLite. (#307)
- PR review: merged PRs now show as "Merged" (not "Closed") in the list, the Approve/Merge buttons refresh immediately after a merge (cache-bypassed refetch), and a success notice / "Merged" badge confirms the action. (#307)
<!-- Bug fixes go here -->
- SQLite migration dry-run no longer aborts on sessions created in `Allow All` permission mode: the `ai_sessions.mode` CHECK constraint now allows `auto` alongside `planning`/`agent`. (#379)
- Context usage meter now opens its breakdown on click instead of hover, so the popover no longer lingers over and blocks the queued-prompt controls. (#429)
- Effort Level selector now takes effect: sessions follow the selected/default effort instead of always running at "high".
- Typing in the chat box no longer has keystrokes hijacked into an open markdown file while an agent is editing it.
- Restored diff application in headless mode (tests and server-side diffing), which had started throwing on `getRootElement` after the chat-box focus fix.
- Browser extension toolbar and URL bar now use the active theme's colors instead of rendering with a white URL box in dark mode.

### Removed
<!-- Removed features go here -->

## [0.64.4] - 2026-06-03


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
<!-- Bug fixes go here -->
- AI Usage Report no longer crashes the app on the SQLite backend.
- Terminal scrollback is preserved when it contains a stray NUL byte, instead of discarding all saved history.
- Claude Code session token totals in the AI Usage Report are no longer inflated.
- Tracker tool widgets no longer crash on the SQLite backend over a JSON-string `type_tags` column.

### Removed
<!-- Removed features go here -->

## [0.64.3] - 2026-06-03


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
<!-- Bug fixes go here -->
- Release packaging validators now find the codex binary at its codex-sdk 0.131+ `vendor/<triple>/bin/` path, which broke the release build.

### Removed
<!-- Removed features go here -->

## [0.64.2] - 2026-06-03


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
<!-- Bug fixes go here -->
- Renderer build no longer breaks on the Anthropic SDK's Node-only agent-toolset (node:crypto/child_process/etc.), which broke the release build.

### Removed
<!-- Removed features go here -->

## [0.64.1] - 2026-06-03


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
<!-- Bug fixes go here -->
- pdf-viewer extension build no longer bundles the host runtime (and the Anthropic SDK's Node built-ins), which broke the release build.

### Removed
<!-- Removed features go here -->

## [0.64.0] - 2026-06-03


### Added
- Claude Opus 4.8 is now selectable in the Claude provider (1M context, dateless ID `claude-opus-4-8`) and is the default Claude model for new installs. (#473)
- Claude Code variants `opus-4-7` and `opus-4-7-1m` pinned to Opus 4.7 so it stays selectable after the canonical `opus` alias was bumped to 4.8. (#473)
- Extension themes can contribute Monaco editor themes via an optional `monaco` block in `contributions.themes[]`, defining `base`, `rules`, and `colors`. Monaco-backed editors register the theme dynamically and switch to it when the user activates the theme; omitting the block keeps the previous `vs` / `vs-dark` fallback.
- Claude Code sessions now show a Task List panel in the right sidebar with the agent's SDK-native task queue (TaskCreate/TaskUpdate), including status, owner, and blocked-by dependencies.
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->
- Default Claude model bumped from `claude-opus-4-7` to `claude-opus-4-8`. Existing sessions keep their configured model; only new sessions and "reset to default" pick up 4.8. (#473)
- Bumped `@openai/codex-sdk` from 0.130.0 to 0.136.0; updated the binary path resolver for the new `vendor/<triple>/bin/codex` and `codex-path/` layout.

### Fixed
<!-- Bug fixes go here -->
- Claude Code sessions on Opus 4.8 now actually run on 4.8 (#531) Upgraded `@anthropic-ai/claude-agent-sdk` to 0.3.161 (and `@anthropic-ai/sdk` to 0.100.1 for its peer requirement).
- Commit proposal diff peeks use the normal default size again instead of collapsing to a tiny bottom-right popover.
- Quick Open file search no longer lags because hidden tabs stop re-rendering on each keystroke.
- Fixed an EPIPE feedback loop where the main-process uncaught-exception handler re-entered itself when stderr was broken on Linux, flooding the log until the process died.
- Meta-agent child sessions now inherit the parent session's provider and model instead of silently falling back to a Claude/Opus default for non-Claude parents.
- iOS: fast typing into the prompt input no longer jumbles characters; synced drafts are no longer applied while the compose field has keyboard focus.
- iOS: switching back to a recently-viewed session is now instant — the transcript keeps up to 3 sessions warm and no longer waits on the sync round-trip to reveal already-local messages.
- iOS: fixed the transcript bundle failing to build (and shrank it ~3.8MB) by stopping a tool widget from importing the runtime barrel, which dragged the Anthropic SDK into the browser bundle.
- "Commit with AI" now prompts the agent to include relevant, commitable, side-effect files.
- Localhost `/clip` endpoint now rejects requests from arbitrary web pages, accepting only extension-origin JSON requests.


### Removed
<!-- Removed features go here -->

## [0.63.9] - 2026-06-02


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
<!-- Bug fixes go here -->
- Meta-agent child sessions now inherit the parent session's provider and model instead of silently falling back to a Claude/Opus default for non-Claude parents.
- Public builds no longer spam logs with normal-path AI, sync, auth, git, and diff-trace diagnostics.
- OpenAI Codex settings panel no longer triggers an infinite re-render loop.

### Removed
<!-- Removed features go here -->

## [0.63.8] - 2026-06-02


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- AI edits to markdown files with inline base64 images no longer trigger multi-minute main-process beachballs.
- Tool calls no longer get stuck at "running" when multiple AI sessions are open.
- Workstream parent sessions now rise to the top when a child session becomes active.
- AskUserQuestion, ExitPlanMode, and GitCommitProposal widgets now render via MCP-prefixed tool names.
- Workspace search now caches the resolved ripgrep path instead of reprobe-logging on every keystroke.
- Quick Open no longer stalls while listing prompts, and older prompts now appear in results again.
- Tracker labels no longer crash the backfill on reconnect or gain a phantom leading `null` on SQLite.
- New Worktree no longer stays disabled in git repos when the initial probe races mount.
- Calc Sheets PARSE ERR rows are legible in dark mode.
- Document-edit usage analytics no longer crash on either database backend.
- Database backups now clean up stranded temp files and catch up after sleep or startup gaps.
- Database Browser now shows SQLite backup sizes.

### Removed
<!-- Removed features go here -->

## [0.63.7] - 2026-06-01


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- ScheduleWakeup no longer logs a spurious "Unrecognized tool" warning each time the agent schedules a wake-up.
- Commit proposal widget reliably flips from "Pending" to "Changes Committed" after a successful commit.
- "Waiting for your response" sidebar indicator no longer gets stuck after the prompt is answered; survives renderer reloads and stays in sync with mobile.

### Removed
<!-- Removed features go here -->

## [0.63.6] - 2026-06-01


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- SQLite migration dry-run no longer fails on row-count mismatch when PGLite is being written to concurrently

### Removed
<!-- Removed features go here -->

## [0.63.5] - 2026-06-01


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Commit proposal widget no longer reverts to "pending" after a successful commit when a later duplicate response carries an error.
- SQLite migration no longer crashes with `Invalid URL` during the adopt phase in packaged builds.

### Removed
<!-- Removed features go here -->

## [0.63.4] - 2026-06-01


### Added
<!-- New features go here -->

### Changed
- Canonical transcript events kept in-memory per session and rebuilt from raw messages on demand instead of persisted to disk.
- Agent-message search index now mirrors extractor output, keeping tool noise and metadata chunks out of search results.

### Fixed
- Multi-minute startup beachball for users with many shared trackers; document-sync key-fingerprint check is now single-flighted and cached, and tracker prewarm is debounced.
- Marketplace `.nimext` packages now ship the `claude-plugin/` directory so installed extensions can register their Claude skills.
- Pending-files query no longer throws `json_extract` errors on PGLite installs.
- Claude Code mid-turn widgets (commit proposal, etc.) now appear in the background-session view as the turn streams, not only after the next session load.

### Removed
<!-- Removed features go here -->

## [0.63.3] - 2026-06-01


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Auto-updater no longer pops a giant "Cannot find latest-mac.yml ... HttpError: 404" toast on background polls when a release is mid-publish. Treats the 404 the same as "no update available" until the workflow finishes uploading metadata; manual checks see a friendly "release is being published" message instead of the raw HttpError.
- Release builds no longer fail on CI when the afterPack worker-bundle ABI check times out spawning the unsigned Electron binary. The path-resolution and `.node`-presence checks remain fatal (those catch the packaging-miss class); only the Electron-as-Node boot probe is now informational.

### Removed
<!-- Removed features go here -->

## [0.63.2] - 2026-06-01


### Added
- Claude Opus 4.8 is now selectable in the Claude provider (1M context, dateless ID `claude-opus-4-8`) and is the default Claude model for new installs. (#473)
- Claude Code variants `opus-4-7` and `opus-4-7-1m` pinned to Opus 4.7 so it stays selectable after the canonical `opus` alias was bumped to 4.8. (#473)
<!-- New features go here -->
- Calc Sheets: a new `.calc.md` custom editor for line-oriented worksheets with units, currency-aware evaluation, assertions, Monaco-based editing, and a live result gutter.
- Alpha SQLite storage backend behind an opt-in Settings → Database migration. Dry-run reports row counts and integrity against your live PGLite without touching it; the real migration preserves PGLite at `pglite-db.migrated-<ts>/` for rollback. WriteCoordinator batches writes through a single lane and chunks slow ops on a background lane; FTS5 mirrors back agent-message and transcript-event search; Database Browser gains a Performance tab.
- Worktree git panel now has a Manual/Smart commit toggle and "Commit with AI" button, matching the non-worktree experience.
- Contextual tips: small bottom-left cards that suggest tracker mode, worktree sessions, the keyboard-shortcuts dialog, and theme exploration based on local feature usage.
- Tip body now renders basic markdown (paragraphs, bullets, bold).
- Empty AI session panels now cycle through 15 additional contextual tips: the four embedded editors (Excalidraw, MockupLM, DataModelLM, spreadsheets), shared session and document links, CLAUDE.md standing instructions, auto-commit mode, document history (Cmd+Y), quick open (Cmd+O), content search (Cmd+Shift+F), mobile pairing, scheduled wakeups, action prompts, and the lightning interrupt button.
- Session history search supports a virtual `#worktree` tag that filters to all worktree sessions and their children.
- Shared Documents file tree now has inline search by document name or folder path.
- Unified Quick Open: one tabbed dialog replaces the four separate Files / Sessions / Prompts / Projects quick-open dialogs, adds a real Trackers tab, a comma-separated file-mask filter (same syntax as the git extension) on Files / In Files, and a type filter on Trackers. ⌘O / ⌘⇧F / ⌘L / ⌘⇧L / ⌘⇧P each open the unified dialog on their tab and also jump between tabs while it's open.

### Changed
<!-- Changes to existing functionality go here -->
- Main-process startup now logs event-loop lag, per-batch progress in `ProjectFileSyncService.buildManifest`/`handleSyncResponse`, per-phase timing in `document-sync:open`, and per-request elapsed time in `TeamService.fetchTeamApi` to diagnose multi-minute startup freezes.
- Default Claude model bumped from `claude-opus-4-7` to `claude-opus-4-8`. Existing sessions keep their configured model; only new sessions and "reset to default" pick up 4.8. (#473)
- Monaco editor host wrappers now support custom load/save content transforms so extensions can present normalized editor views while preserving richer on-disk source formats.
- Bumping a tip or walkthrough version now re-shows it even if the prior version was completed or dismissed.
- The alpha SQLite backend now migrates session, transcript, tracker, and document stores more completely, with worker-backed execution and expanded validation/adoption flows to keep large migrations and database browsing responsive.
- Blitz, Super Loops, and Meta Agent now appear in the new-session menu for any user with their alpha feature enabled, instead of being hidden behind developer mode. (#438)
- Transcript tool-call diff enrichment moved to the main process, removing per-render IPC chatter from the renderer.
- Cloudflare session sync now clamps payloads more aggressively and routes metadata-only index updates through a lightweight path to cut server write churn.

### Fixed
<!-- Bug fixes go here -->
- Primary buttons pick a readable label color on light/pastel theme accents instead of hardcoded white. (#504)
- Packaged better-sqlite3 binaries validated during build to catch broken native modules before release.
- PromptForUserInput widget no longer crashes with "Cannot read properties of undefined" when the agent emits a malformed field. (#494)
- AI sessions no longer appear to keep running forever on the mobile app after a desktop turn ends; v0.63.0 routed the "isExecuting" signal through a new lightweight wire message the server and iOS did not yet understand, so the running indicator never cleared.
- Lexical selection-toolbar format dropdowns now render inside the editor root when portaled, so shared dropdown styling and theme backgrounds no longer disappear.
- AskUserQuestion widget no longer goes blank (header-only "Waiting..." with no options) after switching from Agent mode to Files mode and back when the same session is open in both panels.
- Mobile sync no longer wastes per-session storage on transient Codex app-server delta and diff-update events, preventing noisy sessions from tripping the 10 MB SessionRoom cap too early.
- Codex sessions no longer persist transient app-server notifications (message/reasoning deltas, token-usage updates, MCP startup status, thread lifecycle) to the local raw log; only durable item/turn/error events are kept, cutting per-session DB churn for long Codex runs.
- Claude Code sessions no longer persist transient SDK chunks (hook lifecycle, task progress, tool progress, auth status, rate-limit events) to the local raw log or sync them, since they never render in the canonical transcript.
- Codex app-server transcripts no longer duplicate commit proposal widgets or final messages when repeated item/turn notifications arrive.
- SQLite migration now reconciles final PGLite writes before cutover, rollback works after SQLite is active, voice-mode session resume no longer depends on PG-only interval SQL, and SQLite-backed analytics no longer hit PostgreSQL-only queries.
- Sessions resumed from queued prompts now stay marked running until the continuation actually finishes, so the session dashboard and background-task UI no longer flip to idle mid-turn.
- Sessions no longer get stuck in the running state after the final queued-prompt continuation completes; the dispatcher now ends the session once the queue chain fully drains.
- Embedded calc sheets and other inline custom editors no longer immediately lose focus after the second click used to enter the embedded editor.
- Agent transcript no longer collapses `$7M ... $40M`-style currency text into LaTeX. (#462)
- Markdown-led transcript file change cards no longer append sibling embedded editor previews like Excalidraw beneath the markdown diff.
- Tracker table view now gives the Type column enough width to show its header and icon instead of collapsing to a clipped sliver.
- Smart commit in worktree sessions now resolves session-edited files against the worktree path, so the cross-reference with git status correctly matches.
- Blitz no longer silently dismisses the dialog when run against a workspace whose git repo has no commits. (#455)
- Share to Team now seeds new shared extension documents into the collab room before publishing the link, so teammates no longer open blank MockupLM docs when they join immediately.
- Re-uploading a shared MockupLM document now resolves the correct collab content adapter for `.mockup.html` and `.mockupproject` files.
- Shared-document history now records bootstrap and manual revisions reliably; Cmd/Ctrl+S inside a collab editor creates a manual revision, and Restore waits for pending writes to settle before bailing on transient sync status.
- Session history no longer pegs the renderer at 100% CPU during AI streaming.
- Slow `getPendingFilesForSession` query that compounded the streaming slowdown now uses a partial expression index and a short-lived cache.
- Monaco editor now picks the right dark or light base theme for extension themes whose IDs don't include `-dark` (e.g. rose-pine), so the editor matches the rest of the UI.
- Developer Dashboard no longer crashes when database stats arrive in the SQLite instrumentation shape instead of the legacy per-table counts shape.
- Extension uninstall now also prunes settings for providers contributed under `aiAgentProviders`, not just `aiProviders`, so the ghost-provider cleanup keeps working with the new contribution point. (follow-up to #446)

### Removed
<!-- Removed features go here -->

## [0.62.0] - 2026-05-26


### Added
- Non-markdown shared documents (Excalidraw, Mindmap, Mockup, etc.) now show the unified editor header bar with breadcrumb, View History, and local-source actions.
- Editor header bar's "Shared to Team" dropdown links to the shared document, showing its name with the team-side folder path in subscript.
- Shared documents have revision history: Cmd/Ctrl+S saves a named version, auto snapshots run after idle, and any past revision can be restored.
- Custom shared-document editors can publish history controllers so the global History dialog can route to collaborative revisions.
- Extensions SDK permissions and backend modules.
- Extension panels can run read-only SQL via `host.data.query()` against the local PGLite store when the manifest declares `nimbalyst-database-read`.
- Backend-module allowlist: only built-in extensions, curated marketplace ids, and dev-installed extensions with `NIMBALYST_ALLOW_DEV_BACKEND_MODULES=1` can ship native-code backends.

### Changed
- Auto-update downloads in the background and shows only the "Ready to install" toast; the redundant "Update Available" toast is removed. (#327)
- Extension docs now cover all four markdown/transcript contribution surfaces in both the internal architecture doc and the public SDK docs.
- Backend-module consent prompt leads with an explicit "this extension will run native code on your computer" banner; granular catalog ids only cover host-brokered services.

### Fixed
- Claude Code sessions break out of the SDK iterator after the `result` chunk so the binary's task-list reminder hook can't emit a 14+ minute `tool_result(Stream closed)` flood that pins sendMessage open.
- Claude Code sessions flip to "ready" the moment the model's turn finishes instead of sitting on the last output for up to 30 s while the SDK stdin grace period expired.
- Claude Code sessions no longer reset mid-conversation when the agent spawns sub-agents. (#451, #456, #457)
- CI `npm ci` no longer fails resolving `@nimbalyst/collab-adapters`; the workspace was missing from `package-lock.json`.
- Project quick open loads recent projects from stored recents instead of crawling every workspace on open.
- Rebuild Extensions submenu lists buildable extensions alphabetically.
- Shared Excalidraw and mockup tabs no longer come back blank after restart or close+reopen.
- Tracker list, table, and kanban views share the session-style `#tag` typeahead filter.
- Session history search bar no longer overlaps floating popovers (e.g. Claude Usage).
- Re-uploading a local source into a shared markdown document waits for the collab write to be acknowledged before tearing down the headless sync client.
- Codex session-naming reminder no longer leaks into the chat transcript. (#420)
- Mobile sync picks up Codex sessions running in git worktrees by resolving worktree workspaceIds to the parent project path. (#430) Thanks @stamkivi.
- Claude Code plugins installed at the project scope appear in the Installed plugins list with marketplace and scope badges.
- Slash-command typeahead lists commands and skills from Claude CLI plugins without requiring the experimental "Agent Workflows" toggle.
- Excalidraw "import mermaid" registers the rendered diagram image, so it no longer shows as a broken thumbnail. (#428)
- Codex sessions append actionable guidance when `~/.codex/config.toml` has a url-based MCP server the bundled Codex rejects, instead of an opaque failure. (#424)
- Dollar signs in markdown no longer collapse currency text like `$7M ... $40M` as inline LaTeX; the typing-time `$...$` shortcut is replaced by slash-menu "Math (inline)" / "Math (block)". (#447)
- Trackers panel refetches when switching projects in the sidebar rail instead of staying pinned to the workspace that was active at app startup. (#441)

### Removed
- Catalog permission ids `spawn-process`, `network-loopback`, `network-internet`, and `filesystem` are no longer accepted; they were unenforceable inside a Node backend. Manifests listing them load with a non-fatal warning.

## [0.61.1] - 2026-05-21


### Added
- AI action seed file now includes sibling-session launch examples for planning and worktree implementation.
- Tracker screen has a table view with sortable columns, resizable widths, and aligned headers.
- "Share to Team" opens a folder picker so you can choose the destination folder and rename the document before sharing; last-used folder is remembered per workspace.
- Shared documents can remember their local source file, surface re-upload actions, and relink missing local files.

### Changed
- Tracker row interactions unified in a shared hook; legacy `'table'` view-mode entries migrate to `'list'`.
- Agent guidance treats markdown links to custom-editor files as the default way to share visuals.

### Fixed
- Bug-report anonymizer scrubs workspace paths and Windows path-form variants. (#396)
- Imported sessions now show the model actually used instead of always Sonnet. (#394)
- CollabV3 no longer hammers the server with rejected connections on JWT/userId mismatch; backs off pre-open failures exponentially up to 5 minutes.
- Renderer no longer hangs during heavy tool-call streams when CollabV3 JWT/userId mismatch latch is set.
- Shared docs defer markdown bootstrap until server sync to avoid duplicated content; share-to-team preserves full custom-editor suffixes.
- Shared-document tabs respect Find and Close Tab menu commands; dev HMR no longer stacks stale reconnect listeners.
- Mobile git commit proposal cancellation sends a durable prompt response so blocked sessions actually cancel.
- iOS session sync preserves workstream, worktree, pin, and naming metadata so sessions don't reappear as duplicates.
- Floating menus use floating-ui portals so they stay visible instead of clipping inside panels.
- Agent transcript no longer repaints on every streamed token or keystroke; text selection in running sessions stays usable.
- Dev-mode transcript reprocess refreshes views without marking sessions unread; child session menus under workstreams unified.
- Settings Alpha badges show the shared tooltip with alpha risk details and future Team pricing.
- Codex app-server tool events now appear in transcripts.
- Renderer no longer hangs when opening large markdown files mid-AI-edit.
- External session edits excluded from git staging. (#398)

## [0.61.0] - 2026-05-21

### Added
- Shareable deep links for tracker items via "Copy Link" on the kanban, table, and detail header.
- Shareable deep links for team documents via "Copy Link" in the shared-document menu.
- Programmable actions can launch a new sibling session (per-action `launch` / `model` / `foreground` / `autoSubmit` config in `ai-actions.md`).

### Changed
- File-based plan trackers (`design/trackers/*.md`) unified with DB tracker items on the kanban.
- `nimbalyst-session-naming` MCP server set to `alwaysLoad` so `update_session_meta` stays in the prompt instead of behind ToolSearch.
- Triple-layered defenses against file-watcher attribution-queue overflows under multi-session codegen / build storms. (#352, #365)
- Stytch B2B auth recovery: honor JWT `exp`, log WS close codes, surface worker error params, centralize auth state, add iOS Sign Out.
- Cut ~970k/week of low-value PostHog events (file-save / file-conflict / streamed-response / update-poll dedup).
- System addendum nudges agents toward `PromptForUserInput` widget over chat-based questions.
- CLAUDE.md refactored into path-scoped `.claude/rules/` plus dedicated docs.

### Fixed
- Database lock dialog vs. false-positive lockout on fresh-timestamp / ambiguous locks; force-unlock path restored. (#272 follow-up)
- AI-edit review diff preserved in CSV and datamodel custom editors. (#328)
- Auto-update toast no longer fires on transient DNS failures during background polls. (#387)
- Tracker "Updated" widget renders every field change, not just the hardcoded set.
- Dragging files into AI input inserts `[name](/absolute/path)` markdown links instead of `@<relative-path>`.
- Shared tracker bodies now sync end-to-end through the collab Y.Doc, not just local cache.
- Pasted Google-Docs-style images stored as assets instead of inline base64.
- iOS Codex on app-server transport renders messages (was throwing in the SDK parser and silently dropping output).
- Transcript no longer rerenders on activity in unrelated sessions.
- AIService shutdown no longer dereferences `sessionManager` / `settingsStore` on late-arriving IPC during quit.
- Dead flat-list transcript code path removed; desktop and iOS now run VList unconditionally.
- E2E selectors unstuck (worktree, datamodellm, core specs).

## [0.60.6] - 2026-05-19

### Fixed
- Windows release build no longer fails `vite build` with `[postcss] Cannot read properties of undefined (reading 'blocklist')`; tailwind config path now uses `fileURLToPath`.

## [0.60.5] - 2026-05-19

### Added
- LaTeX math editing in the Lexical document editor via a new built-in `math` extension; KaTeX inline (`$...$`) and block (`$$...$$`) with double-click edit.
- Programmable action prompts in the AI composer; per-workspace `nimbalyst-local/ai-actions.md` defines reusable prompt presets.
- Collaborative editing for extension custom editors via `useCollaborativeEditor` hook + `customEditors[].collaboration` manifest field (extension-sdk 0.2.0); Excalidraw and CSV opt in.
- MockupLM Share-to-Team collaborative editing for `.mockup.html` and `.mockupproject`.
- Tracker sync rewritten as metadata-layer `TrackerSyncEngine`: server-assigned monotonic `syncId`, hybrid conflict resolution, Y.Doc-CRDT bodies, encrypted envelopes.
- Install-from-GitHub prefers Release assets over cloning source; authors no longer need to commit `dist/`.
- `nimbalyst-settings` MCP server for in-app configuration (theme, sync, feature flags, extensions, tracker policies, workspaces) with allowlist + audit logging.
- Runtime contributions for transcript markdown and tool widgets; transcript math moves into the new `math` extension.

### Changed
- `@nimbalyst/collab-protocol` extracted as single source of truth for client<->server WebSocket wire types; `packages/collabv3` moved to a separate `nimbalyst-collab` project.
- `extension-sdk` 0.2.0 with the new collab editor API (backwards-compatible; no-ops on hosts without collaboration).
- Agent transcript returned to virtua with safer selection handling; wider desktop render buffer.
- Wakeup-resumed prompts no longer render in the user lane; new "Resumed from scheduled wakeup" system card. (#376)
- `getMcpConfigService` extracted into `mcpConfigServiceRef` so non-entry modules stop back-importing `main/index.ts`.

### Fixed
- Crash-on-load loop on markdown files with extremely wide table rows; `TABLE_TRANSFORMER` now skips rows above 5 KB and falls back to plain markdown. (#321)
- Tracker (kanban) tools now work from the agent; all 11 `tracker_*` tools added to `INTERNAL_MCP_TOOLS`. (#236)
- CSV editor currency / percent / number column formats render via RevoGrid `cellTemplate`. (#329)
- Claude usage indicator no longer hidden by a deprecated `navigator.platform` check on Windows / Linux. (#362)
- Marketplace clone-source path no longer bricks an existing GitHub install when the new clone is missing `dist/`.
- Manifest-only extensions (theme-only, `claudePlugin`-only) install from a GitHub URL. (#355, #356)
- Queued prompts no longer re-send on restart-after-AskUserQuestion, mid-turn cancel, or mobile-sync rollback. (NIM-615)
- Lightning button reliably interrupts and drains the queue. (#337)
- Unsaved tab edits survive file renames. (#367)
- CSV and datamodel shared documents survive close-and-reopen.
- In-app issue flow uses the correct `.yml` template, drops bogus labels, and prefills the right field.
- Codex interactive prompt correlation stabilized; new thread IDs persisted before interactive prompts can block.
- B2B auth callback fails fast when Stytch returns no session instead of building a broken deep link. (#351, NIM-600)
- Alpha updates no longer 404 on stray non-`v0.*` tags landing in the `releases.atom` feed.
- Mac local builds unblocked; renderer / extension build-time warning noise reduced.

## [0.60.4] - 2026-05-16

### Changed
- Tracker schema watcher test rewritten to use mocked chokidar callbacks instead of real filesystem timing.

### Fixed
- Agent transcript regressions from v0.60.3's flat-list switch: drag-selection lands correctly, short transcripts hug the input, sticky-bottom no longer drops on streaming or lazy-mount.

## [0.60.3] - 2026-05-15

### Added
- Filter the sessions list by tag with a `#` picker that composes with title search. (#244)
- In-app ChatGPT / API-key sign-in for OpenAI Codex via the app-server transport; pre-flight auth gate with a "Sign in to OpenAI Codex" CTA.
- URL fields for tracker items and PR metadata in the tracker schema.
- Compact Rename and Move buttons in the project header. (Refs #305)

### Changed
- Agent session transcript switched to a flat `content-visibility:auto` list on non-iOS so DOM node identity (and selection) survive scrolling.

### Fixed
- CSV editor no longer truncates `YYYY-MM-DD` date cells to the year via `parseFloat`. (#329)
- Claude Code permission stream no longer dies on sessions with many accumulated tracker tasks; `PROMPT_GRACE_MS` bumped from 5s to 30s. (#320)
- Enter at end of a list item ending with inline-code-plus-space no longer keeps the new bullet in inline-code format. (#302)
- "+" (Create new...) button in the session sidebar now works when all sessions are archived. (#306)
- Cmd+O Quick Open and @-mention picker scope "recent files" to the current workspace. (#301, #304)
- Find-in-page search bar no longer hides behind the session-phase pill on narrow widths. (#309)
- Long multi-line git errors stay a single line with View / Copy buttons via a new shared `GitStatusBar`.
- Git extension Output tab errors are now readable and copyable.
- Codex pasted images unblocked in app-server turns (camelCase `localImage`).
- Codex helper PATH preserved in app-server mode for packaged Windows builds.
- Codex `developer_git_commit_proposal` no longer produces duplicate "Changes Committed" cards across SDK / app-server transports.
- Codex bottom-left usage indicator no longer sticks at a stale percentage after the 5h / 7d window resets. (#120)
- "Thinking…" indicator no longer pins after Claude Code finishes on sessions where the workspacePath isn't yet known. (#116)
- PGLite lock self-heals on Windows after PID reuse (60s grace window inside the EPERM branch). (#272)
- Quick Open and @-mention picker no longer flash stale hover state when opened via keyboard.
- Agent session history list now has stable ordering.
- Collab v3 JWT-mismatch warning is now actionable: decodes claims, names the consequence, points at the file to look at.
- PGLite worker `init` allows 120s (was 30s) so the first relaunch after a force-close doesn't fail while WAL recovery is in progress. (#238)

## [0.60.2] - 2026-05-15

### Added
- Codex moved to the app-server transport for proper file-edit hooks and unified-diff capture; one codex child per session, cached across turns.
- `inheritModel` flag on `spawn_session` MCP tool so `/launch-new-session` can keep the new session on the caller's model.
- LaTeX math rendering in agent transcript markdown via remark-math / rehype-katex / katex. (#136)
- Inline embeds for extension-edited files (Excalidraw, mockup, datamodel, csv, sqlite) inside markdown documents.
- Unified embedded editor breadcrumbs to match the main editor toolbar.
- Extension manifest gains `supportsTranscriptEmbed` / `transcriptEmbedHeight`; MockupLM, DatamodelLM, and CSV Spreadsheet opt in.
- Clear-all-unread action in the system tray.
- Workstream tag row collapses overflow tags into a "+N" pill that opens a floating menu.
- Human-readable widget for upstream Claude API 5xx errors with the `request_id`. (#277)
- Dev-only `transcript:force-reparse-session` IPC to rewrite canonical events for one session.

### Changed
- Codex session sync bandwidth reduced via per-block 8 KB truncation before encryption; per-session 50 MB cap with FIFO eviction; `SessionRoom` TTL dropped 30 -> 14 days.
- `MessageStreamingHandler` tracks per-listener refs instead of `removeAllListeners` so other subscribers aren't dropped. (#225)

### Fixed
- Pre-approved tools in the global Claude allow list now bypass the permission dialog; new `matchesAllowPattern` handles MCP server-wide / bare-name / `Bash(...)` wildcards. (#152)
- CommonMark angle-bracket inline links (`[text](<url>)`) render as clickable hyperlinks. (#86)
- OpenCode test-connection finds the `opencode` binary under nvm / asdf / Volta / fnm. (#184)
- Large pasted-text attachments use the platform tmpdir on Windows instead of hardcoded `/tmp`. (#269)
- Chat-attached text files reach the agent instead of degrading to a `@filename` token. (#239)
- "Allow this tool?" permission dialog no longer gets stuck with no buttons. (#276)
- Right-click Archive surfaces backend rejections in a visible error notification instead of failing silently. (#282)
- Meta-agent `get_session_result` returns the actual most-recent assistant response on Codex follow-up turns. (#270)
- Pressing Enter at end of a tracker-item line on the last line of the file inserts a new paragraph instead of swallowing the keypress. (#263)
- OpenCode model picker finds `opencode.json` on Windows (`%APPDATA%\opencode\opencode.json`). (#284)
- Codex usage indicator no longer sits on a stale percentage after the 5h / 7d window resets. (#120)
- PGLite lock self-heals on Windows after PID reuse (60s grace window in the EPERM branch). (#272)
- "Thinking..." indicator no longer pins on extended-thinking Opus sessions where the workspacePath isn't yet known. (#116)
- Auto-update on macOS no longer fails with "command is disabled" after download; redundant pre-download `checkForUpdates()` removed so Squirrel.Mac proxy stays alive. (#245)
- Codex `thread/resume` re-forwards `mcp_servers`, `sandbox`, `approvalPolicy`, `developerInstructions`, `model`, and reasoning effort.
- Codex interactive widgets (`developer_git_commit_proposal`, `AskUserQuestion`) no longer deadlock; `tool_call_started` now fires on `item/started`.
- Claude sessions preserved across project moves via shared workspace path encoding.
- Blank-turn rendering for unknown slash commands fixed; result-text backfill bypasses the dedup gates when `num_turns` is 0.
- Codex chat attachments preserved in prompts and transcript across SDK and ACP sessions.
- Onboarding mode-picker no longer beach-balls on cold start; redundant dynamic imports converted to static; `onboarding:get` races a 3s timeout. (#260)
- Archived workstream children and archived worktrees stay out of session lists / history.
- Git commit failures surface instead of reporting fake success; pre-commit hook stderr preserved. (#202)
- Copilot ACP retains context between turns; "Session is already loaded" treated as success. (#251)
- Wrap toggle in transcript code blocks persists across `OverflowWrapper` remounts. (#274)
- Detached HEAD state handled in the git extension; pull/push disabled while detached.
- Git views refresh after `.gitignore` edits (root and nested).
- Session archive state propagates to iOS via the CollabV3 `metadata_updated` cache merge.
- `claude-code` no longer shadows OAuth login with empty `ANTHROPIC_API_KEY`.
- Copilot CLI resolves from `%APPDATA%\npm` on packaged Windows.
- Finder/Dock drag-and-drop into folders restored on Electron 32 via `webUtils.getPathForFile`. (#206)
- Finder drops on empty file-tree space copy into the workspace root. (NIM-584)
- Collab v3 Share-to-Team migrates pasted-image asset refs to `collab-asset://` URIs via a pre-seed pass.
- Collab v3 session titles encrypted to `encryptedTitle` / `titleIv` in `SessionRoom`; server strips plaintext title.

## [0.60.1] - 2026-05-12

### Added
- `chatShowToolCalls` user-facing setting (default `true`) to hide tool-call rows entirely in the AI chat; `showToolCalls` stays a developer-mode toggle. (#118)
- Editor extension API: extensions can ship Lexical extensions via `contributions.lexicalExtensions` + `module.lexicalExtensions`; editor shell switched to `LexicalExtensionComposer`; built-ins (Mermaid, Images, Kanban, Diff, Table, etc.) declared as LexicalExtensions; legacy `PluginPackage` / `PluginRegistry` retired.

### Changed
- Upgrade Lexical and `@lexical/*` to 0.44.0 across the runtime; stop forking `@lexical/markdown`'s importer (NCRs in place of backslash escapes); `LexicalMarkdownImport.ts` and forked text transformers deleted.
- Cut per-commit GitHub Actions runtime: macOS sim job gated to `packages/ios/**`, new Ubuntu Transcript Bundle job, `node_modules` and `packages/runtime/dist` caches.

### Fixed
- Markdown anchor links scroll to in-document headings via new headless `HeadingAnchorExtension` (GitHub-style slug ids). (#248)
- Marketplace install from a GitHub URL surfaces a clear error when the repo has no built `dist/` directory and cleans up the partial install. (#247)
- Commit-widget failure path renders the error state with the underlying error string instead of collapsing to "cancelled". (Partial fix for #202)
- Commit-widget proposal renders before the SDK chunk flush; `interactiveToolHandlers` writes an awaited synthetic `nimbalyst_tool_use` row keyed by the SDK toolUseId. (#265)
- Restore open workspaces after an auto-update relaunch (save session state before tearing listeners down). (#232)
- Workspace YAML tracker schemas load on every workspace-open path (session restore, UI open, file-open create), not just CLI-arg open.
- Agent-mode conflict dialogs no longer overflow short viewports; body scrolls, max-width widens.
- Triple-nested emphasis no longer corrupts on export when a whitespace-only text node sits between formatted siblings.
- Lexical collaboration context restored for Lexical 0.44 (upstream removed the implicit global context).
- In-tree `SelectionAlwaysOnDisplayPlugin` checked in; cold-clone / CI builds no longer fail with a missing-module error.
- Dark-mode logo asset rendered correctly in the editor shell after the Lexical upgrade.

## [0.60.0] - 2026-05-11

### Added
- Multi-project rail with keep-warm switching: opt-in Discord-style vertical rail lets one window host multiple workspace projects with `Cmd/Ctrl+1..9` switching; AI sessions, file watchers, tabs, and git status stay live in inactive projects. Refs #155.
- Streamlined feedback intake: `/feedback:bug-report` and `/feedback:feature-request` route through a single `FeedbackIntakeDialog` that prefills the GitHub issue.
- Orphan Durable Object cleanup endpoint and driver in collabv3; gated by Cloudflare Access (`Cf-Access-Jwt-Assertion`), no shared-bearer fallback.

### Fixed
- Workstream rows no longer get created inside worktrees (the worktree IS the workstream); one-time migration deletes accidental three-layer hierarchies. New `docs/SESSION_HIERARCHY.md`.
- Worktree child sessions stay in sync with the parent workspace; running / waiting indicators restored. (#231)
- Codex `workspace-write` sandbox can reach sibling worktrees via `additionalDirectories` (`OpenAICodexProvider.setAdditionalDirectoriesLoader`). (#230)
- `spawn_session` inherits the caller's worktree instead of creating the child in the project root. (#229, refs #37)
- Diff peek paths resolve against the worktree's own checkout for worktree files.
- Slash skills namespaced consistently with commands (`/excalidraw:excalidraw`, `/planning:design`, ...); `nimbalyst-` prefix dropped from bundled plugin names. (#234)
- Codex command instructions preserved when frontmatter is missing a description.
- `FeedbackIntakeDialog` `onLaunch` typed via `FeedbackIntakeLaunchOptions`.
- Commit proposal widget sorts files alphabetically by basename and subdirectories by displayPath. (#233)
- Open file links of the form `/abs/path/<real absolute path>` resolve on Windows and macOS. (#240)

## [0.59.4] - 2026-05-09

### Added
- New `PromptForUserInput` MCP tool: single structured-prompt widget with five field types (`multiSelect`, `singleSelect`, `reorder`, `editText`, `confirm`) so one prompt collects several inputs at once.
- `mcp__nimbalyst-tracker__tracker_update` can change a tracker item's `primaryType`; activity log records the change. (#79)
- Title-only mode (`searchField: 'title'`) for `list_recent_sessions` MCP tool. (#83)
- Allow renaming AI sessions; "Preferred Agent Language" global setting steers AI-generated session names. (#219)
- Voice agent can run "Commit with AI" via a new `propose_commit` voice tool; voice now reads the actual commit title and file count.
- Voice Mode settings panel surfaces microphone permission status with a deep link to macOS System Settings.
- Voice mode "Generate Project Summary" no longer requires an Anthropic API key; launches a new agent session in the configured agent. (#201)
- Codex slash command autocomplete: workspace Codex skills surface in the shared slash-command picker.
- Skills and commands compatibility layer for Claude Code and Codex; extension manifest gains `agentWorkflows` contributions.
- Map Codex reasoning items into transcript thinking blocks.
- MCP servers configured with `command: "node"` use Electron's bundled Node runtime, so MCP works without system Node. (Refs #197)

### Changed
- `[StartupSlow] {name} took {ms}ms` log when a startup phase crosses 2s (PGLite init, ProjectFileSync, SyncManager fetch, TrackerSync initial sync).
- Upgrade bundled Codex SDK and harden Claude packaged binary resolution (reject unusable `app.asar` paths).

### Fixed
- Legacy plan and decision tracker docs (top-level `planStatus` / `decisionStatus`) appear on the Tracker board again.
- Drag-and-drop on a multi-file selection moves or copies every selected item, not just one. (#31)
- Claude Chat Test Connection works against the default `claude-opus-4-7` model; `temperature` omitted for Opus 4.7+. (#199)
- `automationStatus` documents (created via `/automation`) appear as Tracker rows. (#67)
- Detect frontmatter on Windows files with CRLF line endings; all 13 frontmatter regex sites use `\r?\n`. (#68)
- Show the tray icon on Linux and Windows; macOS-only theme subscription guarded. (#39)
- User-visible error dialog when deleting a file from the workspace tree fails. (#195)
- `ErrorDialog` `details` prop accepts a plain string in addition to the structured `DiffErrorDetails` shape. (#216)
- Stop spamming `Update Error: net::ERR_NAME_NOT_RESOLVED` on the auto-update background poll; network errors during hourly check suppressed. (#56)
- `Ctrl+=`, `Shift+=`, and numpad `+/-` accelerators all zoom on Windows / Linux. (#205, #220)
- Honor `.gitignore` from nested git repos when watching a non-git workspace root; no more OOM on huge build-output trees. (#207)
- Files committed inside a nested git repo no longer report as untracked indefinitely. (#122)
- `customClaudeCodePath` read from the `ai-settings` store instead of `app-settings.json`. (#162)
- Drag-drop session merge initializes workstream state via `convertToWorkstreamAtom` (`skipSiblingCreation: true` path was skipping it). (#212)
- Live-update sub-session renames and add Rename to the workstream parent menu. (#211)
- Tracker "+ Launch Session" uses the workspace's default provider instead of hardcoded `claude-code`. (#176)
- Skip the hidden-editor mount for built-in file types in extension AI tool dispatch. (#217)
- Hide the Environment Variables section from the Project tab in Settings (it's a global file). (#185)
- Git extension panel persists active tab and selected commit (by hash) per workspace.
- Git extension Output log persists across panel close/open via a module-level `useSyncExternalStore`.
- Session list refresh no longer stampedes PGLite; `getSessionsForUncommittedFiles` filters by uncommitted paths and dedups in-flight promises.
- Shared Documents recover after laptop sleep/wake; reconnect path always tears down and reestablishes the WebSocket.
- Read-only Codex bash commands (`sed -n`, `nl`, `cat`) no longer attribute as edits; pre-edit snapshot captured at `item.started`. (NIM-475)
- Paste-as-Text shortcut reliable and visible in the keyboard shortcuts dialog.
- Voice mic stays open after the agent finishes a turn (15s listen window starts when audio playback drains).
- Bold spans containing inline code stay intact through approve-all diff round-trips.
- Shared mockup viewer rendering restored; mockup diff review re-enabled for `.mockup.html` editors.

### Removed
- Unused `MCPConfigBuilder` removed from runtime.

## [0.59.2] - 2026-05-07

### Changed
- Finish IPC listener centralization and lock it in via an eslint `no-restricted-syntax` rule banning `electronAPI.on()` outside `store/listeners` (with documented carve-outs). Last component-level callsites migrated.

### Fixed
- Codex `file_change` edits render as proper red/green diffs (not empty-baseline whole-file-green) for gitignored / never-snapshotted / post-boot-created files; `pre_edit_snapshot` StreamChunk captures the baseline at `item.started`.
- Markdown export to PDF includes the document title in metadata and generates outlines / tagged PDFs from headings.
- Open file tabs no longer disappear when switching tasks / sessions; `WorkstreamEditorTabs` restore effect waits on `workstreamStatesLoadedAtom`. (#169)
- Settings -> Claude Agent SDK panel reads the version correctly when `@anthropic-ai/claude-agent-sdk` is hoisted to the repo-root `node_modules`. (#60)

## [0.59.1] - 2026-05-06

### Added
- Codex `file_change` tool calls render as inline red/green edit cards in the transcript; new `nimtc|...` synthetic edit-group IDs and `CodexEditWindowRegistry` attribute writes without upstream hooks.
- Privileged `collab-asset://` scheme for E2E-encrypted attachments in collaborative documents; main fetches and decrypts asset bytes so CORS isn't in the renderer's path.
- Voice agent gets a `create_session` MCP tool to spin up a coding session on demand and link it as the active session.
- Delayed finish timestamp on completed transcript turn summaries (with prior-day dates).
- Tracker MCP tools expose schema introspection (`tracker_define_type` schema fields). (NIM-371)
- New `tracker_unlink_session` MCP tool.
- Existing-session tracker link flow: choose an existing session when linking a tracker item.

### Changed
- Upgrade bundled `@openai/codex-sdk` to 0.128.0 (via 0.124.0).
- Refine collabv3 metrics dashboard queries (`blob2` = DO id, `cpuTime` for DO compute, `durableObjectsSqlStorageGroups` for SQLite size, `responseBodySize` for subrequests).
- Restore optional email collection in analytics (onboarding / Stytch sign-in deliberately set it).
- Local-to-shared tracker upgrades require explicit confirmation. (NIM-364)
- `tracker_create` no longer auto-links the calling AI session; pass `linkSession: true` to link. (NIM-408)
- `tracker_link_session` MCP tool accepts an optional explicit `sessionId` arg with validation. (NIM-405)

### Fixed
- Default `CLAUDE_CODE_ENTRYPOINT` to `'cli'` so OAuth subscription traffic isn't deprioritized as third-party. (#174)
- Open a workspace with a zero-commit `.git` repo without spamming a stack trace into `main.log`.
- Refresh the editor on AI edits when the pre-edit IPC outruns the disk write (skip empty-diff session creation).
- Sub-bullet-with-link diffs render cleanly; tree-matcher dedup, URL wrapping on the target, reversed removals.
- Codex edit attribution stable: synthetic edit-group IDs reused in raw tool matching, watcher fallback delayed.
- Tracker session link visibility centralized through shared rules so MCP handlers behave the same as the UI.
- Meta-agent session history actions restored: context menus on meta-agent rows, archive and delete scoped to the full group.
- Collabv3 analytics tracks the real `sessionId` (DO id as `blob2`) instead of empty string.
- Auto-committed widgets stay visually committed when the auto-commit toggle flips off; success widget gains a proper "Disable auto-approve" checkbox.
- Shared tracker session links stay local-only (don't leak per-user links to team members). (NIM-368)
- Tracker session linking UI initializes on first load. (NIM-407)
- Meta-agent MCP tools restored for Codex sessions via the Codex SDK allowlist.
- `ai:messages-logged-batch` routed only to the window owning the session's workspace; stops cross-window "Rejecting session" warnings.
- Local tracker typing preserved during MCP refresh races.
- `@` mentions for `nimbalyst-local` plans surface in the mention picker again.
- MCP `tracker_update` no longer clobbers collab Y.Doc bodies for shared trackers; skipped writes reported back via `structured.skippedFields`. (NIM-436)
- Tracker reads / writes no longer corrupt `automationStatus` (nested block wins on overlap; caller updates route to top-level for un-owned fields). (NIM-324)
- Claude Code `[^a-zA-Z0-9]` path encoder applied to the importer so workspace paths with spaces / apostrophes resolve; `claude-code:sync-sessions` surfaces failures. (#170)
- Persisted `fieldUpdatedAt` threaded through tracker upload so batch / recovery uploads don't claim all fields were just edited. (NIM-246)
- Tracker detail editor refreshes on external content updates via a key-epoch remount. (NIM-433)
- Meta-agent `get_session_result` extracts Codex child output (event_msg, item.completed for agent_message + reasoning, task_complete). (#145)

### Removed
- Obsolete `AssetLinkPlugin` (superseded by `CollabAssetLinkPlugin`).

## [0.59.0] - 2026-05-05

### Added
- Peek file diffs from the git log commit detail panel: click a file to pin its unified diff in the existing peek popover; Up/Down steps, Esc closes.

### Changed
- Migrate alpha auto-updates from the legacy R2 feed to GitHub prereleases; adds cumulative public-release promotion commands.
- Centralize PGLite TIMESTAMPTZ handling to epoch-ms via `toMillis`. (#147)

### Fixed
- Workspace-filtered Claude session import resolves paths with spaces / apostrophes / accents via a shared `encodeWorkspaceDir()` helper matching upstream `[^a-zA-Z0-9]`.
- Parent's `childCount` bumps in the session registry when a child is added so the left-pane workstream tree reveals new children without a manual toggle. (NIM-435)
- `ai_agent_messages` writes coalesced through a single FIFO `AgentMessageWriteQueue` (200ms idle / 200-row batch); writer-lock p95 ~330ms -> ~1ms, unblocking `can_use_tool` audits. (#163, NIM-340 / NIM-431)
- Word-level inline diff no longer interleaves red/green fragments on near-complete paragraph rewrites; block-level fallback above 5 clusters, sentence-level pre-pass peels identical openers / closers.
- MCP `workspaceId` normalized for worktree callers at the meta-agent dispatch boundary so `spawn_session` doesn't fail with "Parent session not found in this workspace". (#157)
- Wide walkthrough callouts (`step.wide`) clamp to 420px to match the Tailwind rendered width. (Refs #148, #164)
- Claude session import falls back to all sessions when the workspace-filtered scan returns nothing, with a notice that scope was broadened.
- PGLite WAL growth managed: explicit CHECKPOINT after init / before close, periodic maintenance CHECKPOINT above 200 MB, `db.close()` timeout 2s -> 5s, WAL stats on the Database dashboard.
- Single-flight `refreshSession()` (and per-`personalOrgId` keyed variant) so cold-start no longer fires 4+ concurrent `/auth/refresh` requests racing for Stytch's single-use token. (NIM-430)
- Claude Code stdin stays open across late tool permission requests via a persistent `AsyncIterable` prompt and a `PromptStreamController` with 5s grace timer. (#160, NIM-340)
- Later-turn Codex tool calls render on iOS transcripts; dedup on `(id, toolName)` so reused per-turn item ids don't drop; `openai-codex-acp` and `copilot-cli` routed through their own mobile parsers.
- Git commit proposals stage deletes via `git add --all -- <paths>` (mobile, desktop, auto-commit paths). (NIM-428)
- Child `session:completed` only forwards to parent on terminal idle; between-turn idles suppressed by pending-queue check; signature dedup resets on `session:started` / `session:streaming`. (#142)
- Keyboard shortcuts render platform-correct glyphs on Windows / Linux via an `isMac` parameter; three hardcoded `⌘⇧X` literals replaced with helper calls. (#149)
- HEIC wasm decoder lazy-loaded so standard PNG / JPEG attachments don't pay the startup cost.

## [0.58.21] - 2026-05-04

### Changed
- CI: re-enable tag-triggered electron release builds (post-OSS-launch tag force-push finished); `/release` no longer needs a separate `gh workflow run` dispatch.

### Fixed
- Pasting images into markdown on Windows no longer fails with a `nim-asset` 403 (split on both separators, explicit `..`-segment traversal guard).
- "Stream closed" tool permission errors on multi-result Claude Code turns reduced via a 5s reset-on-activity grace timer.
- Restoring from history on a gitignored markdown file no longer leaves the editor showing stale content. (NIM-426)

## [0.58.20] - 2026-05-04

### Changed
- Bump claude-agent-sdk 0.2.117 -> 0.2.126 (MCP reconnection after transport abort, `SessionStore.append()` retry, `origin` field on result messages).

### Fixed
- Local images render after 0.58.19's `webSecurity: true` hardening; runtime `localAssetUrl` helper routes absolute paths through `nim-asset://`. (#146)

## [0.58.19] - 2026-05-04

### Fixed
- Harden Electron security: per-launch bearer token on the five internal MCP HTTP servers; drop `Access-Control-Allow-Origin: *` from MCP preflight; restore `webSecurity: true` via a registered `nim-asset://` custom protocol with an open-workspace allowlist. (#146)
- Invisible git log resize handle in the git extension.

## [0.58.18] - 2026-05-03


### Added
- Live-update kanban peek transcript while session is running so the AI transcript streams in real time without waiting for the turn to complete.
- Clear button on session history search input for quick filter resets.
- CollabV3 sync metrics dashboard for monitoring sync health and performance.

### Changed
- Update lodash-es for CVE fix.
- Reduce collabv3 observability sampling to 5%.
- Require workspacePath for Claude Code path loader, tightening the contract so workspace-scoped overrides resolve correctly.

### Fixed
- Route built-in editor saves through Layer D and sync diff resolution across sibling tabs so edits in one tab no longer silently overwrite concurrent changes in another.
- Smooth iOS session back navigation so the transition no longer stutters.
- Keep iOS transcript live during AI turns instead of freezing until the turn completes.
- Add settings shortcut to voice mode errors so users can quickly configure their provider when voice fails.
- Prevent autosave from overwriting AI-recreated deleted files by checking the recently-deleted set before writing.
- Use getTime() for TIMESTAMPTZ store timestamps so date comparisons work correctly across timezones (#140).

## [0.58.17] - 2026-05-01

### Added
- Auto-name Claude Code sessions via an SDK side-question on the first turn: two parallel SDK control requests set the title (~1s) and tags / phase early, with `phase: "planning"` fallback so every session lands on the kanban.
- `xhigh` effort level option in the Effort Level selector. (#133, closes #132)

### Changed
- Rename `spawn_sibling` MCP tool to `spawn_session` and add an `isolated` parameter for top-level fix-and-commit sessions; `/launch-new-session` picks the mode from the user's phrasing.
- Consolidate AI provider override normalization (`normalizeAIProviderOverrides` exported and reused in `AIService`). Follow-up to #128.
- Quiet noisy release-path logging in startup and document-service traces.

### Fixed
- Paste attachments now reach OpenCode (document text part + image / PDF `FilePart` with base64 data URL) instead of degrading to a phantom `@filename`. (#121)
- Codex ACP stderr buffer bounded to a 64 KB rolling tail to prevent main-process OOM after multi-hour sessions. (#119)
- Eliminate 15s waits on git status reads: pass `core.optionalLocks=false` and drop the `gitOperationLock` wrapper from read-only handlers.
- File tree refreshes when the agent creates a gitignored folder; workspace-tree watcher opts in to `add` / `unlink` events for gitignored paths. (#127)
- Worktree inherits the parent project's Claude path override.
- "Custom Claude Installation" override scoped per workspace via the existing override infrastructure (was leaking across projects). (#125, #128)
- Duplicate rows in `FilesEditedSidebar` tree collapsed; `SessionFileTracker.trackSingleFile` normalizes to absolute paths.

## [0.58.16] - 2026-05-01

### Added
- Agents can spawn sibling sessions via `/launch-new-session`; auto-promotes caller into a workstream with shared files/tabs/overview.
- Extensions can contribute themes via `contributions.themes`; manifest-only theme extensions supported with fallback to dark/light when disabled.
- Import Claude Code 2.1.x sessions via the File menu (no longer dev-mode-gated); correctly imports threaded prompts, subagents, persisted outputs, and extended-thinking blocks.

### Fixed
- Stop renderer freeze and OOM on long Claude Code streams; transcript now re-renders at most once per frame via `requestAnimationFrame` coalescing. (NIM-411)
- `spawn_sibling` now refreshes workstream UI without a manual toggle.
- Stop `HooklessAgentFileWatcher` warn-flood on Bash directory args; filter out directories from the path extractor.
- Reduce debug logging volume across services.

### Changed
- `@nimbalyst/extension-sdk` published as 0.1.5 with org rename alignment and npm Trusted Publishing (OIDC provenance).
- Correct iOS 1.1.0 changelog entries.

## [0.58.15] - 2026-04-30


### Added
- Full undo/redo for AI chat input (Cmd+Z/Cmd+Shift+Z) restoring text, attachments, and cursor position.
- Diff peek in AgentMode Files Edited sidebar: hover to reveal an inline unified-diff popover.
- File history dialog (Cmd+Y) works in agent mode.
- Surface archived sessions in `list_recent_sessions` MCP tool via new `includeArchived` parameter.
- `/social-response` slash command for drafting copy-paste-ready replies to user messages on Discord, GitHub, Twitter, etc.

### Changed
- Onboarding telemetry replaced with custom `onboarding_completed` PostHog event; fixed `user_role` property overwrite bug for 'Other' text.
- Coalesce streaming `assistant_message` chunks so Codex-ACP sessions don't persist one row per token; kanban peek tail bumped to 100.
- Bump `@nimbalyst/extension-sdk` to 0.1.1 and switch publish to npm Trusted Publishing (OIDC).
- CI: bump Node to 22 across workflows; raise the nested-lists diff test timeout to 20s.

### Fixed
- Keep AI diffs granular: LCS-based `diffWordsWithSpace` replaces prefix/suffix diff; in-flight edit races queued instead of dropped.
- Show row add/remove and in-cell content diffs in tables; LCS-based row alignment and visual diff for modified cells.
- Custom editors load for 3+ segment compound extensions (e.g. `*.reddit.watch.json`); use longest-suffix key match. (NIM-396)
- Resolve workspace-relative paths in `workspace:open-file` IPC.
- Track every file in a Codex ACP multi-file `apply_patch`.
- Stop context menus from flashing before positioning.
- Render OpenAI Codex icon for ACP transport in pickers.
- Render provider icons correctly in diff headers.
- Show child transcript in workstream/worktree kanban peek when the parent has no transcript of its own.
- Refresh kanban transcript peek on new events; cache now invalidates on `transcript:event`.
- Update opencode installation command to use `opencode-ai`.
- Reduce debug logging volume in DocumentSync.

### Removed
- Dead `DiffApprovalBar` plugin files removed (superseded by `UnifiedDiffHeader`).

## [0.58.14] - 2026-04-29


### Changed
- Final Stravu -> Nimbalyst rename: components, CSS class, path aliases, localStorage keys, and log paths aligned to `nimbalyst`.
- OSS prep: public repo assets, community health files (CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md), AGPL-3.0 on collabv3, gitignore generated outputs.
- GitHub Release promotion is now opt-in; tag pushes upload to R2 alpha channel only.
- Loud warning in extension SDK manifest reference: `supportsDiffMode` defaults to `false` and must be explicitly set to `true`.
- iOS: stop committing built `transcript-dist` and `editor-dist` bundles; Xcode pre-build script regenerates them.

### Fixed
- Restore inline screenshot preview in the agent transcript; `EditorScreenshotWidget` now parses `tool.result` via `parseToolResult()` instead of treating it as a structured object.
- Windows update download: retry on `EPERM`/`EBUSY` rename from antivirus-locked installer.
- ScheduleWakeup logic moved to a main-process static handler so vitest no longer crashes on Electron-only imports.

### Removed
- Unused `PostHogSurvey` component removed.

<!--
NOTE: v0.58.13 was tagged but never shipped to R2 -- the release build hit a
403 (Resource not accessible by integration) at electron-builder's GitHub
publish step because CI ran on nimbalyst-code with a token that can't write
to nimbalyst/nimbalyst. The "Make GitHub Release promotion opt-in" change
above (--publish never) is the fix; v0.58.14 bundles all of v0.58.13's
intended changes plus that fix.
-->


## [0.58.12] - 2026-04-29


### Fixed
- Fire `ScheduleWakeup` tool calls in Claude Code sessions by intercepting them in the `tool_use` stream.
- Spawn-safe paths for codex-acp and Copilot in packaged builds; rewrite `app.asar` to `app.asar.unpacked` and unify PATH detection via `enhancedPathLoader`.
- Cast `onerror` on MCP `Server` instances to satisfy `exactOptionalPropertyTypes` in ES2024 tsc.
- Bump CI mac runner runtime build heap to 8GB to fix OOM during `vite build`.

## [0.58.10] - 2026-04-28


### Added
- Recent file masks history in the git Changes tab (up to 10, deduped, dropdown picker).
- Guided agent bug-report flow (`FeedbackIntakeDialog`) replaces the PostHog feedback survey; Help > Send Feedback spawns a Claude Code session with anonymization and GitHub Issues posting.

### Changed
- `POSTHOG_EVENTS.md` and `FEATURE_INVENTORY.md` updated to reflect the new feedback flow.

### Fixed
- Ship `@opencode-ai/sdk` in packaged builds; add `validate-packaged-sdks` afterPack validator that tests real ESM imports from the packaged tree.
- Use latest session title in blocked-state OS notifications; fetch from repository at notify time instead of closing over stale reference.
- Pass platform/arch from electron-builder context to the packaged-SDK validator; no silent host-arch fallback.
- Install codex-acp cross-arch binary for Mac x64 builds; add `@zed-industries/codex-acp-darwin-${arch}` to `mac.extraResources`.
- Make the packaged-SDK validator work on Windows: use `pathToFileURL()` for prefix matching and `'junction'` for symlinks.

## [0.58.6] - 2026-04-28


### Added
- OpenCode provider: configurable models, LM Studio bridge, disable-auto-update toggle, and real error messages surfaced from `session.error`.
- Extension SDK declares app compatibility via `nimbalyst.minAppVersion`.

### Changed
- OSS prep: MIT license at root, AGPL-3.0 on collabv3, new `LICENSING.md`, Telemetry section in README.
- OSS prep: gitignore `nimbalyst-local/` and other local-only paths; untrack 67 previously-committed files.
- Loud warning in `TranscriptTransformer.CURRENT_VERSION` to never bump it for parser bugfixes.

### Fixed
- Keep AI red/green diff on open files; fix two races where `onFileChanged` could clobber the editor during diff apply or duplicate the same tag twice.
- Ship codex-acp native binary in packaged builds via `asarUnpack` and `build.files` wildcard. (NIM-388)

## [0.58.5] - 2026-04-28


### Added
- OpenAI Codex over ACP transport (alpha): `openai-codex-acp` provider via `@zed-industries/codex-acp` with native file-edit hooks, MCP passthrough, and `apply_patch` diff rendering.
- AI editing of shared collaborative documents via Yjs; new `readCollabDoc` and `applyCollabDocEdit` MCP tools using `collab://` URIs.
- Diff peek in the git commit proposal widget; shared `DiffPeekPopover` with the git extension, user-resizable with persisted size.
- Self-pacing session wakeups via `schedule_wakeup` MCP tool; persistent across restarts with OS notification on fire.
- Publish `@nimbalyst/extension-sdk` to npm on `extension-sdk-v*` tag push with npm provenance.

### Changed
- Consolidated tracker UI: `TrackerBottomPanel` removed, `TrackerMode` is now the single canonical tracker UI. (NIM-382)
- Alpha features open to all users; each is opt-in from its natural settings panel with an alpha badge. (NIM-380)
- Consolidated extensions Installed view into Settings > Extensions; Marketplace shows Discover only.
- Finish Tailwind migration: replace remaining `--surface-*`/`--text-*`/`--primary-color` CSS vars with `--nim-*` equivalents; drop backwards-compat aliases.
- Centralized renderer IPC listeners in `store/listeners/*`; components now read Jotai atoms instead of subscribing directly.
- Split `AIService.ts` into `aiServiceUtils.ts` (pure helpers) and `MessageStreamingHandler.ts` (send-message lifecycle).
- Extract `HooklessAgentFileWatcher` from `AIService` into its own class; add 100-test vitest suite for `aiServiceUtils`.

### Fixed
- Codex ACP `apply_patch` edits produce accurate `FilesEditedSidebar` entries and diff previews; force empty baseline for new-file adds.
- `@@` session typeahead shows real provider icons and phase badges matching the session list.
- Persist `FileGutter` collapsed state across remounts.
- Stabilize terminal bottom-panel restore across reloads.
- Remove blank space below the Claude Code Plugins panel.
- Render Monaco diff gutter glyphs correctly; fix codicon font 403 and restyle gutter to match peek layout.
- Unhang diff preview in `HistoryDialog`; add Rich/Raw toggle; fix `bg-transparent` conflicting with active-state bg color on buttons.
- Keep awaiting-input indicator after mode switch; strip `mcp__<server>__` prefix in `refreshPendingPromptsAtom` so MCP-routed prompts count as pending.
- Show real third-party authors in the Claude Plugins panel instead of defaulting to Anthropic.

## [0.58.4] - 2026-04-26


### Added
- GitHub Copilot CLI as a new AI agent provider (alpha) via ACP protocol with MCP passthrough and streaming.
- Inline diff peek and sessions pane in the git Changes tab.
- OpenCode sessions wire through Nimbalyst's MCP tools; tool calls render correctly during streaming.
- Recent files in the @ mention picker on empty query. (NIM-263)
- GPT-5.5 added to OpenAI Codex and Chat model catalogs.
- Subtle "alpha" badges on alpha-bounded features throughout the UI.

### Changed
- Redesigned Changes pane in the git panel: checkboxes, group-level Stage/Unstage/Discard, file mask filter, color-coded filenames.
- System reminder cards in the AI transcript now default to collapsed.

### Fixed
- Apply external file edits to extensions without a diff view; auto-accept diff for no-diff-mode custom editors. (NIM-379)
- Restore login widget for Claude Code auth errors; thread `isAuthError` through the canonical transcript pipeline. (NIM-377)
- Restore PATH so Claude Code stdio MCP servers can spawn npx/uvx/docker. (NIM-376)
- Require `workspacePath` on `HistoryManager.createTag` to fix NOT NULL constraint violations. (NIM-384)
- Preserve AskUserQuestion draft answers across unmount.
- Stop OpenCode transcripts from duplicating text and bleeding across sessions; add dedicated `OpenCodeRawParser`.
- Stop iOS draft sync from deleting characters during fast typing. (NIM-383)
- Show Files tab and file browsing in the iPad sidebar.
- Harden iOS webview error handling; skip transcript webview warmup on iPad.
- Give every tracker type consistent tag support. (NIM-370)
- Require custom editors to opt in to diff mode via `supportsDiffMode`.
- Stop over-counting `update_toast_shown` analytics events.
- Fix iOS CI failures from `@vscode/ripgrep` 403 rate limit.

## [0.58.3] - 2026-04-23


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Always pre-resolve the Claude Code binary path in packaged builds: the v0.58.2 "let SDK resolve" experiment (Workaround A for NIM-838) caused the SDK's `require.resolve` to return a path inside `app.asar` instead of `app.asar.unpacked`, producing `spawn ENOTDIR`. The SDK then silently fell back to the user's standalone Claude Code CLI, which ignores `--resume` and broke multi-turn sessions. Remove the `skipPreResolve` gate -- all platforms now pre-resolve via `resolveClaudeAgentCliPath()`, which correctly rewrites `app.asar` to `app.asar.unpacked`.
- Ignore transient hook session IDs that caused false resume mismatch (NIM-838 root cause): SessionStart hooks (`hook_started`, `hook_response`) emit a transient pre-resume UUID before the init frame arrives with the real session ID. `parseSystemChunk` captured `session_id` from all system chunks, so the resume-mismatch guard aborted on the hook UUID before the init frame ever arrived. Only emit `session_id` from system chunks with `subtype: "init"`; hook frames are now ignored for session ID capture.
- Hot-reload `customClaudeCodePath` without app restart: the custom Claude Code binary path was previously read once at startup and cached as a static string, so changing it in Settings had no effect until restart. Replace the static string with a loader function that reads fresh from the electron-store on each `sendMessage` call, and remove the redundant `setCustomClaudeCodePath` call from the save handler since the loader reads from the same store the save writes to. Follows the same lazy-loader pattern used by `mcpConfigLoader`, `claudeCodeSettingsLoader`, etc.
- Prevent duplicate transcript events from concurrent `ensureUpToDate` calls: concurrent `ensureUpToDate`/`processNewMessages` calls could race on the same watermark and write duplicate canonical events. Add a per-session promise-chain lock to `TranscriptTransformer` so calls serialize instead. Also log the effective binary path on each `buildSdkOptions` call to confirm `customClaudeCodePath` changes take effect without restart.
- Suppress result chunk text in resume batches to prevent duplicate assistant messages: the SDK's result chunk always echoes assistant text. When the assistant and result chunks land in separate transformer batches (observed 68ms apart, split by a throttled `ensureUpToDate`), the fresh parser's `processedTextMessageIds` is empty and the result text passes the guard. Add `suppressResultChunkText` flag to `ClaudeCodeRawParser`, set by the transformer on resume batches (`afterId > 0`) where prior batches already handled any assistant text. Slash-command-only turns still work because they're processed in the first batch.

### Removed
- NIM-838 diagnostic instrumentation: root cause (transient hook session IDs) has been found and fixed, so remove the temporary debugging infrastructure -- `DEBUG_CLAUDE_AGENT_SDK=1` env var injection on resume turns, `logResumeDiagnostic()`/`schedulePostTurn1Diagnostic()` methods, `RESUME_DIAGNOSTIC` filesystem/stderr dumps from the mismatch guard, and restore the stderr ring buffer from 200 back to 50 lines.

## [0.58.2] - 2026-04-23


### Added
<!-- New features go here -->

### Changed
- Remove Claude Code SDK prewarm end to end: prewarm was gated behind `PREWARM_ENABLED=false` after it was found to interfere with session resume and required a `canUseTool` shim to keep tool permissions working. Remove the dead path (provider fields, `prewarm`/`discardWarmQuery` methods, `ai:prewarm` IPC handler, preload bridge, type, and renderer `useEffect`), collapsing `sendMessage` to a single `query()` call and removing the warm-query shim entirely. Does not fix NIM-838 -- prewarm was already inert -- but shrinks the surface to reason about while chasing the real resume-mismatch bug.

### Fixed
- Restore Claude Code on packaged macOS/Linux (regression from v0.58.1): v0.58.1 shipped the NIM-838 workaround that passed `pathToClaudeCodeExecutable=undefined` in packaged mode so the SDK could resolve the binary itself. On packaged macOS arm64, the SDK's `require.resolve` returns a path inside `app.asar` where the binary only exists under `app.asar.unpacked`, producing `spawn ENOTDIR` on turn 1 and breaking Claude Code entirely for Mac users. Restore pre-resolution on every platform except packaged Windows, where the original NIM-838 resume-mismatch reports originated and the experiment remains open. `TeammateManager` now receives the same pre-resolved path so teammate spawns don't hit the same failure.

### Removed
<!-- Removed features go here -->

## [0.58.1] - 2026-04-23


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Diagnose and work around Claude Code session resume mismatch (NIM-838): follow-up messages in Claude Code sessions fail on v0.57.33+ with "Session resume mismatch" because the native SDK binary (0.2.114+) mints a fresh `session_id` on every `--resume` attempt. Two platform-targeted workarounds plus broad diagnostic instrumentation: stop overriding `pathToClaudeCodeExecutable` in packaged mode so the SDK's own `require.resolve` picks the binary (dev mode unchanged); force `HOME=USERPROFILE` on Windows so the binary's home resolution is deterministic across turn boundaries; enable `DEBUG_CLAUDE_AGENT_SDK=1` on resume turns and bump stderr capture to a 200-line tail-biased ring buffer for the session-lookup fingerprint; `logResumeDiagnostic` walks every plausible home root from subprocess env (HOME, USERPROFILE, APPDATA, CLAUDE_CONFIG_DIR, `os.homedir()`), locates the session jsonl if it exists, and dumps the head of any `.claude/debug/sdk-*.txt` the SDK wrote, firing at preQuery, postMismatch, and +500ms/+2000ms post-turn-1 so we can separate "turn 1 never wrote" from "turn 2 reads elsewhere"; `ai_stream_interrupted` now carries `errorCategory` and `ai_request_failed.errorType` gains the same buckets so `resume_mismatch` and `stream_closed` can be split from the generic error bucket in PostHog. Full evidence chain, bare-SDK repro results, and alpha-build readiness checklist in `nimbalyst-local/plans/claude-code-resume-mismatch-investigation.md`.

### Removed
<!-- Removed features go here -->

## [0.58.0] - 2026-04-22


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Stop tracker items leaking across open projects (NIM-346): MCP tracker change broadcasts went to every BrowserWindow, so items created in one project transiently showed up in other open projects' tracker lists. Scope MCP broadcasts via `findWindowByWorkspace` so events only reach the owning workspace's window, and add a defensive workspace filter in the renderer listener so stray cross-project events are dropped before they touch the atom map.
- Stop buggy tracker widget from white-screening the app (NIM-351): a malformed tracker result with non-array `tags` threw during `CreatedView`/`RetrievedView` render and unmounted the transcript. Guard both views against non-array `item.tags`, coerce `args.tags` to an array in `tracker_create`/`tracker_update` so bad shapes from the agent aren't persisted going forward, wrap custom tool widgets in `ToolWidgetErrorBoundary` so a crashing widget renders an inline fallback instead of bringing down the transcript, and wrap the renderer root in `ErrorBoundary` as a safety net so escaped errors show a recoverable screen instead of a white screen.
- Avoid `document-service` IPC calls outside workspace windows: gate tracker sync startup on workspace-backed window state and prevent non-workspace windows (settings, help, etc.) from invoking `document-service` handlers, which produced errors and log spam when those windows were open.
- Ship working `node-pty` in the Linux AppImage (NIM-354): the Linux AppImage crashed on launch because packaged `node_modules/node-pty` contained no loadable `pty.node` for `linux-x64` -- the upstream `node-pty@1.x` npm package ships prebuilds for darwin and win32 only, and electron-builder's `install-app-deps` runs `@electron/rebuild` with `buildFromSource=false` so the Linux job silently skipped rebuilding instead of falling back to node-gyp. Add a Linux-only CI step that runs `@electron/rebuild --force` against the target Electron version and verifies `build/Release/pty.node` actually landed, and extend `validate-extra-resources.js` with a `node-pty` binary check that fails the build when no `pty.node` exists for the current target (mirroring the existing ripgrep and claude-agent-sdk checks). Catches this class of silent-skip on any platform, not just Linux.
- Remove console error when dropping a session onto itself: the drop is already a no-op but logged a noisy console error on every self-drop; now returns early without logging.

### Removed
<!-- Removed features go here -->

## [0.57.42] - 2026-04-22


### Added
- Complete the marketplace extension deep link flow: queue install requests until the renderer is ready, then open Settings > Marketplace and focus the requested extension so users landing from an external link arrive on the matching detail view.

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Render custom tool widgets in Codex sessions: Codex reuses short per-turn item IDs (`item_1`, `item_2`, ...) across sessions, so the transcript transformer's `findByProviderToolCallId` queried globally and deduped a new session's `tool_call` against a same-named tool from a previous session, dropping the canonical event and hiding widgets like the git commit proposal. Scope the lookup to the current session by threading `sessionId` through the store interface, `processDescriptor`, the `ParseContext` wiring in `TranscriptTransformer` and `projectRawMessages`, and the `ToolCallMatcher` diff lookups. Adds a regression test covering two sessions that both call `mcp__nimbalyst-mcp__developer_git_commit_proposal` with `item_1`. Refs NIM-342.
- Detect Windows Claude Code installs correctly: the detector only looked for `claude.exe`/`claude` on PATH and missed the npm-installed `claude.cmd` shim, so users with a working Claude Code install still saw the false "Claude Code not detected" setup warning. Recognize `claude.cmd` and add regression coverage for the Windows installation check alongside the related app-startup change.
- Ship ripgrep on Windows ARM64 and the Claude Agent SDK native binary on Intel Mac: two silent `extraResources` failures caused broken release builds (ripgrep missing from Windows ARM64 installs with `spawn rg ENOENT`, and the `claude-agent-sdk` native binary missing from Intel Mac installs). Re-run `@vscode/ripgrep` postinstall explicitly after `npm ci --ignore-scripts` on `windows-11-arm` (the `--ignore-scripts` flag, added to dodge workerd's missing ARM64 prebuild, also skipped the rg.exe download); extend `validate-extra-resources` to walk `build.{mac,win,linux}.extraResources`, expand the `${arch}` macro via `BUILD_ARCH`, and assert the actual binary exists inside `@vscode/ripgrep/bin` and `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`; extend `normalize-extra-resources` to handle platform-specific entries and self-heal npm hoisting in both directions; wire `validate:extra-resources` into `build:win` scripts (was only running for mac/linux).
- Restore Electron typecheck for Windows Claude detection: remove the explicit `shell` option from the new Windows Claude version checks so the Electron package compiles cleanly again.
- Scope `validate-extra-resources` to the current build platform: the v0.57.40 validator walked every `build.{mac,win,linux}.extraResources` block on every runner, so the Linux release job failed validation on `@anthropic-ai/claude-agent-sdk-darwin-x64` -- a package that isn't installed on a Linux runner and isn't needed for the Linux build output. Limit platform-scoped walking to entries whose macro matches `process.platform` (with a `BUILD_PLATFORM` override for future cross-platform scenarios); top-level `extraResources` still validate everywhere. Root cause of v0.57.40 failing to ship.
- Combine cross-arch native binary installs into a single `npm install` invocation: v0.57.41's Intel Mac build ran two sequential `npm install --no-save --force` calls (one for `@anthropic-ai/claude-agent-sdk-darwin-x64`, then one for `@openai/codex-darwin-x64`). Because neither package is recorded in `package.json`, npm treated the SDK binary as extraneous on the second invocation and pruned it -- the Codex install logged `added 1 package, removed 1 package`, leaving only Codex on disk and tripping the new extraResources validator with a "missing `claude-agent-sdk-darwin-x64`" error. Pass both package specs to a single `npm install` so npm keeps both trees intact. Root cause of v0.57.41 failing to ship.

### Removed
<!-- Removed features go here -->

## [0.57.39] - 2026-04-22


### Changed
- Release collabv3 0.1.63.
- Increase maximum width for `TrackerMainView` component.
- Bump `claude-agent-sdk` to 0.2.117, which ships Claude Code native binary 2.1.117 (built 2026-04-21). Picked up after observing a `hook_0 "Stream closed"` cascade on 2.1.116 in a non-Unknown-tool path (plain Bash, long turn, no user-facing hook configured) -- the cascade is binary-side, so the only lever on our side is the binary version. Also aligns `packages/electron/package.json` from `^0.2.114` to `^0.2.117` so all three declarations match (previously drifted during the 0.2.116 bump). Refs NIM-340.

### Fixed
- Normalize hoisted `extraResources` before Mac packaging: the previous normalize step ran inline with validation but, on Mac cross-arch builds, the packaging invocation sidestepped the normalization and the validator still saw missing `@openai/codex-sdk` paths. Run the normalize step as a dedicated pre-step in the Electron mac build flow so symlinks are in place before `validate-extra-resources` and electron-builder start, preventing CI packaging failures when workspace dependencies are hoisted. Root cause of v0.57.38 failing to ship.
- Normalize `extraResources` paths across npm hoisting layouts: npm's workspace hoisting isn't stable across platforms -- the same lockfile can place `@openai/codex-sdk` in `packages/electron/node_modules/` on one machine and in the repo root `node_modules/` on another. The electron-builder `extraResources` entries use literal paths, so when npm hoists differently the Linux CI build failed `validate-extra-resources`. Added a pre-validate normalize step that, for any entry whose electron-local path is missing but whose root-level equivalent exists, creates a symlink at the expected location. Entries are processed shallowest-first so one symlink (e.g. `@openai`) covers any nested entries (e.g. `@openai/codex-sdk`). No-op when hoisting already matches. Root cause of v0.57.37 failing to ship.
- Restore bundled ripgrep via `@vscode/ripgrep`: the claude-agent-sdk upgrade to a native binary package stopped shipping the vendored ripgrep binary at `vendor/ripgrep/<arch>/rg`. `getRipgrepPath()` fell back to system `rg`, which most users don't have, so `findWorkspaceFiles` threw `spawn rg ENOENT`, the QuickOpen cache never built, and the `@` file-mention typeahead in AIInput had no options. Added `@vscode/ripgrep` as a direct dep (postinstall fetches the host-arch rg), rewrote `getRipgrepPath()` to resolve the binary in dev and packaged builds, bundled via `extraResources` into `app.asar.unpacked/node_modules/@vscode/ripgrep`, and extended the CI cross-arch install step to re-run postinstall with `npm_config_arch` so cross-compile jobs pack the correct binary.
- Lock `@vscode/ripgrep` in package-lock.json so CI installs the same version used to bundle rg.
- Pass `GITHUB_TOKEN` to the `@vscode/ripgrep` postinstall on CI: `@vscode/ripgrep` downloads its rg binary from `ripgrep-prebuilt` GitHub releases during postinstall. Unauthenticated CI runners hit the 403 rate limit, breaking `npm ci`. Expose `secrets.GITHUB_TOKEN` on both the initial install step and the cross-arch re-download step so the postinstall authenticates its fetch. This was the root cause of v0.57.36 failing to ship.
- Stop `hook_0 Stream closed` cascade on Claude Code 2.1.116: long agent turns hit repeated `Error in hook callback hook_0` / `Tool permission request failed: Error: Stream closed` failures as soon as the agent invoked one of the CLI's new built-in tools (`Monitor`, `ExitWorktree`, crons, etc.). The old `SDK_NATIVE_TOOLS` whitelist missed those tools, so Nimbalyst tried to execute them locally, threw `Unknown tool`, and destabilized the CLI<->host control stream for the rest of the turn -- the agent then retried blindly for minutes. Added `Monitor`, `ExitWorktree`, `PushNotification`, `RemoteTrigger`, `CronCreate/Delete/List`, `ListMcpResources(Tool)`, `ReadMcpResource(Tool)`, `Config`, `Mcp` to `SDK_NATIVE_TOOLS`; replaced the unknown-tool throw with a warn-and-skip that assumes CLI-native so future tool additions log one line instead of breaking the stream. Refs NIM-340.
- Narrow `STREAM_CLOSED_RAW_CHUNK` diagnostic to real errors: was matching any chunk whose JSON contained the string "Stream closed", firing on successful tool results that legitimately mentioned the phrase (e.g., `git log` echoing a commit message about the stream-close fix). Narrowed to only match user/tool_result chunks with `is_error=true` and "Stream closed" in the content string. Verified against archived cascades: every real stream-close event still matches; the commit-message false positive no longer does.
- Silence `TreeMatcher` guidepost error on unchanged subtrees: when a list subtree is diffed and its children have identical text, the synthetic source/target markdown blobs match exactly and `createTwoFilesPatch` returns a patch with zero hunks, which `parseUnifiedDiff` rejects as invalid. The caller already swallows the error but logged noisily. Short-circuit `buildTextBasedGuidePosts` when the blobs are identical so the diff library is never invoked in this case.

## [0.57.35] - 2026-04-22


### Fixed
- Shared/hybrid tracker types rendering blank in workspaces with no team: routed through the collaborative editor path which couldn't resolve a DocumentRoom, leaving the detail panel stuck on "No content". Now detects team membership as a tri-state (pending/no-team/team) in `TrackerItemDetail`, skips the document-sync IPC when no team exists (falls back to the local PGLite Lexical editor that already backs collab content), and holds the loading state while team detection is in flight so the editor doesn't briefly mount in the wrong mode.
- electron-store failing to load in packaged builds with `Cannot find module 'p-try'`: the allowlist-style `build.files` array was missing `p-try`, which `pkg-up`'s nested `p-limit@2.3.0` requires. Broke the project move feature. Added `p-try` to the allowlist.
- Unrelated SDK errors misreported as "session expired": the post-error fallback was using `~/.claude/history.jsonl` as authority for whether a resumed session still existed. When the lookup missed (write-timing races, programmatic sessions the SDK never logs to history), any unrelated SDK error was swapped for a "session expired" message and the session mapping deleted, forcing the user onto a fresh conversation. Demoted the check to a soft diagnostic and preserve the session mapping -- real expiry is still caught upstream via the SDK's own error signature.

## [0.57.34] - 2026-04-22


### Added
- Collaborative tracker content editing via DocumentRoom: team-synced tracker items using Yjs with review gate, awareness cursors, and PGLite persistence. TrackerItemDetail now supports three content paths (file-backed, local-pglite, collaborative); review banner shows pending remote changes with accept/reject; server auto-repairs corrupt tracker items by re-encrypting from local PGLite data when decryption fails. 1MB content size limit enforced. Configurable TTL on DocumentRoom (tracker content rooms use 90-day TTL).
- Extension marketplace update flow: auto-updates installed marketplace extensions silently on app launch, update indicators in Discover tab (cards + detail modal), per-extension Update button and Update All in Installed tab, new `/release-extension` command, bundled registry updated with mindmap v1.0.1.
- Pre-fetch commit context to eliminate agent discovery latency: new `git:get-commit-context` IPC handler cross-references session-edited files with git status before sending to the agent. `handleSmartCommit` injects the pre-fetched file list into the prompt so the agent calls `developer_git_commit_proposal` immediately. New `CommitRequestCard` widget renders commit-request user messages as a collapsible card instead of raw prompt text.
- Capture `cpu_arch` as PostHog person property so user base can be segmented by CPU architecture (arm64, x64) -- GitHub download counts lose this fidelity once pre-split generic assets are in the mix.

### Fixed
- Session resume failing in packaged builds: `setupClaudeCodeEnvironment()` was overlaying a synthetic env on top of the carefully sanitized `process.env`, clobbering it. Designed for the old Node.js execution path but the native binary doesn't need NODE_PATH/PATH rewrites -- just HOME. Removed the overlay so dev and packaged mode launch the binary with the same environment. Also: `checkSessionExists` fails open when `~/.claude/history.jsonl` is missing (fixes Windows where the CLI may store data elsewhere), stopping real SDK errors from being misdiagnosed as "session expired".
- MIME type resolution for chat attachments: `.log`, `.ts`, `.py`, `.yaml`, and other text-based files were rejected as "unsupported file type" because browsers report empty or `application/octet-stream` MIME for those extensions. Added extension-to-MIME fallback map (~70 extensions), passed filename through to validation, and broadened supported document MIME list (html, xml, yaml, js, ts, etc.).
- iOS compose bar clearing dictated text after keyboard voice input: dismiss focus before clearing the text binding on send/queue so any in-flight keyboard dictation commits first. Otherwise UIKit's pending dictation buffer re-inserted text after the clear, leaving the dictated message stuck.
- Tracker content editor destroying/remounting on every save by removing `updatedAt` dependency from content load effect.
- Model picker showing raw variant ID for pinned opus-4-6 on initial load: use `CLAUDE_CODE_MODEL_LABELS` map instead of naive first-char capitalization so `opus-4-6` displays as `Opus` not `Opus-4-6`. Matches server-side label format (dot separator).
- `scheduleAIProviderPersist` re-sending stale debug settings: provider saves fetched `currentSettings` via `aiGetSettings()` and re-sent `showToolCalls`/`aiDebugLogging` alongside `apiKeys`/`providerSettings`. If a debug toggle changed while a provider save was in the 500ms debounce window, the older debug values were re-saved over the fresh ones. The `ai:saveSettings` handler guards every field with `!== undefined`, so dropping those keys preserves existing values. Last remaining holdout of the NIM-801 spread pattern.
- Dropping advanced settings when debounce timer resets: toggling Extension Dev Tools (or any `changedKeys`-driven advanced setting) silently failed to persist when another setting mutated within the 500ms debounce window. The scheduler captured `changedKeys` in a `setTimeout` closure and cleared the pending timer on each call, losing the first call's keys entirely. Accumulate `changedKeys` into a module-level Set and capture the latest settings snapshot so the flushed timer sees every queued change. Same fix applied to `scheduleDeveloperFeaturePersist`.

### Removed
- Failing mermaid import exploration test (debugging artifact with `console.log` diagnostics whose subgraph case asserted on the `mermaid-to-excalidraw` library's internal fallback for inputs it throws on; consistently failing CI with no production code relying on the assertion).

## [0.57.33] - 2026-04-21


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Intel Mac packaged build was missing the Claude Code x64 SDK binary due to three compounding issues:
  - `afterPack.js` used `packager.arch` which was falsy for some arch values, falling through to `process.arch` (arm64 on the build machine). Pruning kept the arm64 binary and deleted the x64 one. Now uses `context.arch`.
  - electron-builder's `files` patterns only include packages in the npm dependency tree. The `--no-save` cross-arch install isn't in the lock file, so `files` globs silently skipped it. Added `mac.extraResources` with the `${arch}` macro to copy the binary from root `node_modules` regardless of lock-file state.
  - Simplified the CI cross-arch install to put the binary in root `node_modules/`, where `extraResources` reads from.
- Added diagnostic logging and improved error messages when Claude Code binary resolution fails at runtime (shows which package and arch were expected).

### Removed
<!-- Removed features go here -->

## [0.57.32] - 2026-04-21


### Added
<!-- New features go here -->

### Changed
- Upgrade Claude Agent SDK 0.2.114 -> 0.2.116 (permission dialog crash fix, session resume perf, API 400 race condition fix) and `@anthropic-ai/sdk` 0.71.2 -> 0.81.0 (deduped with the agent SDK dependency)
- Address 36 npm audit vulnerabilities including 2 critical: upgrade `simple-git` 3.30.0 -> 3.36.0 (command execution RCE fix), `mcp-remote` 0.1.37 -> 0.1.38, plus high-severity fixes in `vite`, `rollup`, `tar`, `picomatch`, `path-to-regexp`, `@hono/node-server`, `@xmldom/xmldom`, `undici`, and others. Remaining 30 are upstream/transitive with no fix available.

### Fixed
- Cross-arch SDK install step hitting `ERR_PACKAGE_PATH_NOT_EXPORTED`: `@anthropic-ai/claude-agent-sdk` and `@openai/codex` both have an `exports` field in `package.json` that doesn't expose `./package.json`, so `require.resolve('<pkg>/package.json', { paths: [...] })` fails regardless of the `paths` option. Probe the known `node_modules` locations with bash file existence, then `require()` the absolute path -- absolute paths bypass `exports` resolution and just read the file.
- Restore typecheck after the `@types/node` bump pulled in by the npm audit fix: TypeScript 5.7+'s newer `Uint8Array<ArrayBufferLike>` / `Buffer<ArrayBufferLike>` definitions narrow `SharedArrayBuffer` out of `ArrayBuffer`, breaking ~13 `crypto.subtle.*`, `fetch`, and `new Blob()` call sites. Added `as BufferSource` / `as BodyInit` / `as BlobPart` casts at the boundaries in `ShareHandlers.ts`, `KeyRotationService.ts`, `OrgKeyService.ts`, `CollabAssetService.ts`, and the runtime sync providers (`DocumentSync.ts`, `ECDHKeyManager.ts`, `ProjectSyncProvider.ts`, `TeamSync.ts`, `TrackerSync.ts`). All heap-allocated `Uint8Array`s, so the casts are safe at runtime.
- Intel Mac "spawn ENOTDIR" reproduced after the v0.57.29 attempt: running `npm install --prefix packages/electron/` makes npm read that workspace's `package.json`, which lists `@nimbalyst/runtime` and other workspace siblings as dependencies. Without workspace context npm tries to resolve those from the public registry and 404s. Install into a temp directory that has no workspace neighbors, then copy the binary into `packages/electron/node_modules/` where electron-builder can find it.
- Tool permission prompts lost after renderer reload: `safeSend` silently dropped events when the original `webContents` was destroyed (e.g., HMR reload), so the pending permission promise never resolved and the SDK stream timed out with "Stream closed". Now falls back to any live `BrowserWindow`.
- Always include subprocess stderr in error messages: previously stderr was only appended to errors containing "exited with code", losing diagnostic context for native binary crashes producing "Stream closed" or other errors.

### Removed
<!-- Removed features go here -->

## [0.57.31] - 2026-04-21


### Added
<!-- New features go here -->

### Changed
- Upgrade Claude Agent SDK 0.2.114 -> 0.2.116 (permission dialog crash fix, session resume perf, API 400 race condition fix) and `@anthropic-ai/sdk` 0.71.2 -> 0.81.0 (deduped with the agent SDK dependency)
- Address 36 npm audit vulnerabilities including 2 critical: upgrade `simple-git` 3.30.0 -> 3.36.0 (command execution RCE fix), `mcp-remote` 0.1.37 -> 0.1.38, plus high-severity fixes in `vite`, `rollup`, `tar`, `picomatch`, `path-to-regexp`, `@hono/node-server`, `@xmldom/xmldom`, `undici`, and others. Remaining 30 are upstream/transitive with no fix available.

### Fixed
- Cross-arch SDK install step on CI now uses `require.resolve(..., { paths: ['./packages/electron'] })` to look up the Claude Agent SDK and Codex versions: the previous hardcoded `./packages/electron/node_modules/...` path didn't exist when npm workspaces hoisted the SDK to the root `node_modules/`, which broke the Intel Mac cross-arch install and cascaded into fail-fast cancellations for the whole matrix.
- Restore typecheck after the `@types/node` bump pulled in by the npm audit fix: TypeScript 5.7+'s newer `Uint8Array<ArrayBufferLike>` / `Buffer<ArrayBufferLike>` definitions narrow `SharedArrayBuffer` out of `ArrayBuffer`, breaking ~13 `crypto.subtle.*`, `fetch`, and `new Blob()` call sites. Added `as BufferSource` / `as BodyInit` / `as BlobPart` casts at the boundaries in `ShareHandlers.ts`, `KeyRotationService.ts`, `OrgKeyService.ts`, `CollabAssetService.ts`, and the runtime sync providers (`DocumentSync.ts`, `ECDHKeyManager.ts`, `ProjectSyncProvider.ts`, `TeamSync.ts`, `TrackerSync.ts`). All heap-allocated `Uint8Array`s, so the casts are safe at runtime.
- Intel Mac "spawn ENOTDIR" reproduced after the v0.57.29 attempt: running `npm install --prefix packages/electron/` makes npm read that workspace's `package.json`, which lists `@nimbalyst/runtime` and other workspace siblings as dependencies. Without workspace context npm tries to resolve those from the public registry and 404s, aborting the install before any native binary lands on disk. Install into a temp directory that has no workspace neighbors, then copy the binary into `packages/electron/node_modules/` where electron-builder can find it. Same pattern for the Codex binary.
- Tool permission prompts lost after renderer reload: `safeSend` silently dropped events when the original `webContents` was destroyed (e.g., HMR reload), so the pending permission promise never resolved and the SDK stream timed out with "Stream closed". Now falls back to any live `BrowserWindow` so the permission UI still appears after a renderer reload.
- Always include subprocess stderr in error messages: previously stderr was only appended to errors containing "exited with code", so native binary crashes producing "Stream closed" or other errors had their stderr silently dropped, losing diagnostic context needed to debug intermittent binary deaths.

### Removed
<!-- Removed features go here -->

## [0.57.30] - 2026-04-21


### Added
<!-- New features go here -->

### Changed
- Upgrade Claude Agent SDK 0.2.114 -> 0.2.116 (permission dialog crash fix, session resume perf, API 400 race condition fix) and `@anthropic-ai/sdk` 0.71.2 -> 0.81.0 (deduped with the agent SDK dependency)
- Address 36 npm audit vulnerabilities including 2 critical: upgrade `simple-git` 3.30.0 -> 3.36.0 (command execution RCE fix), `mcp-remote` 0.1.37 -> 0.1.38, plus high-severity fixes in `vite`, `rollup`, `tar`, `picomatch`, `path-to-regexp`, `@hono/node-server`, `@xmldom/xmldom`, `undici`, and others. Remaining 30 are upstream/transitive with no fix available.

### Fixed
- Restore typecheck after the `@types/node` bump pulled in by the npm audit fix: TypeScript 5.7+'s newer `Uint8Array<ArrayBufferLike>` / `Buffer<ArrayBufferLike>` definitions narrow `SharedArrayBuffer` out of `ArrayBuffer`, breaking ~13 `crypto.subtle.*`, `fetch`, and `new Blob()` call sites. Added `as BufferSource` / `as BodyInit` / `as BlobPart` casts at the boundaries in `ShareHandlers.ts`, `KeyRotationService.ts`, `OrgKeyService.ts`, `CollabAssetService.ts`, and the runtime sync providers (`DocumentSync.ts`, `ECDHKeyManager.ts`, `ProjectSyncProvider.ts`, `TeamSync.ts`, `TrackerSync.ts`). All heap-allocated `Uint8Array`s, so the casts are safe at runtime.
- Intel Mac "spawn ENOTDIR" still reproduced after the v0.57.29 attempt: running `npm install --prefix packages/electron/` makes npm read that workspace's `package.json`, which lists `@nimbalyst/runtime` and other workspace siblings as dependencies. Without workspace context npm tries to resolve those from the public registry and 404s, aborting the install before any native binary lands on disk. Install into a temp directory that has no workspace neighbors, then copy the binary into `packages/electron/node_modules/` where electron-builder can find it. Same pattern for the Codex binary.
- Tool permission prompts lost after renderer reload: `safeSend` silently dropped events when the original `webContents` was destroyed (e.g., HMR reload), so the pending permission promise never resolved and the SDK stream timed out with "Stream closed". Now falls back to any live `BrowserWindow` so the permission UI still appears after a renderer reload.
- Always include subprocess stderr in error messages: previously stderr was only appended to errors containing "exited with code", so native binary crashes producing "Stream closed" or other errors had their stderr silently dropped, losing diagnostic context needed to debug intermittent binary deaths.

### Removed
<!-- Removed features go here -->

## [0.57.29] - 2026-04-21


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Intel Mac "spawn ENOTDIR" still reproduced after v0.57.28: npm workspaces hoist packages to the root `node_modules/` even when `npm install` is run from a child directory, so the darwin-x64 SDK binaries kept landing where electron-builder couldn't find them. Use `--install-strategy=nested --prefix` to bypass workspace hoisting and force the binaries into `packages/electron/node_modules/`. Added a post-install verification step that fails the CI job immediately if the binary is missing at the expected path.

### Removed
<!-- Removed features go here -->

## [0.57.28] - 2026-04-20


### Added
<!-- New features go here -->

### Changed
- Gate SDK prewarm behind `PREWARM_ENABLED=false` temporarily while the session resume and canUseTool plumbing bakes

### Fixed
- Intel Mac "spawn ENOTDIR" on launch: run the cross-arch npm install from `packages/electron/` (not the monorepo root) so the darwin-x64 Claude Agent SDK and Codex binaries land in `packages/electron/node_modules/` where electron-builder's `files` patterns can resolve them. Keeps `macos-latest` as the runner since GitHub is phasing out Intel runners.
- Session resume silently starting fresh conversations after a Nimbalyst restart: `ai:prewarm` cached the Claude Code provider without calling `setProviderSessionData`, so `sessions.getSessionId()` returned undefined and the SDK spawned a brand-new session with no visible error. `setProviderSessionData` now runs on every `sendMessage`, the prewarm IPC handler also restores session data, and the restore is asserted against the DB. The stream now compares the SDK-reported `session_id` against `options.resume` for Claude Code, Codex threads, and managed teammates, throwing on mismatch so silent resume failures surface loudly.
- canUseTool Zod errors on every tool call after prewarm: the prewarm stub returned `true`, which spread into `{toolUseID: ...}` with no `behavior`/`updatedInput`/`message` and failed the CLI's Zod schema. Replaced with a delegating shim backed by `warmCanUseToolRef`; the real session-bound handler is installed before the warm query is reused.

### Removed
<!-- Removed features go here -->

## [0.57.27] - 2026-04-20


### Added
<!-- New features go here -->

### Changed
- Gate SDK prewarm behind `PREWARM_ENABLED=false` temporarily while the session resume and canUseTool plumbing bakes

### Fixed
- Mac x64 build switched to a native macos-13 Intel runner instead of cross-compiling on ARM64: SDK native binaries were landing in root `node_modules/` where electron-builder couldn't find them, causing "spawn ENOTDIR" on Intel Macs. The cross-arch install step is no longer needed.
- Session resume silently starting fresh conversations after a Nimbalyst restart: `ai:prewarm` cached the Claude Code provider without calling `setProviderSessionData`, so `sessions.getSessionId()` returned undefined and the SDK spawned a brand-new session with no visible error. `setProviderSessionData` now runs on every `sendMessage`, the prewarm IPC handler also restores session data, and the restore is asserted against the DB. The stream now compares the SDK-reported `session_id` against `options.resume` for Claude Code, Codex threads, and managed teammates, throwing on mismatch so silent resume failures surface loudly.
- canUseTool Zod errors on every tool call after prewarm: the prewarm stub returned `true`, which spread into `{toolUseID: ...}` with no `behavior`/`updatedInput`/`message` and failed the CLI's Zod schema. Replaced with a delegating shim backed by `warmCanUseToolRef`; the real session-bound handler is installed before the warm query is reused.

### Removed
<!-- Removed features go here -->

## [0.57.26] - 2026-04-20


### Added
- canUseTool Zod schema compliance tests (43 tests) covering immediateToolDecision trust modes / team tools / MCP tools / delegation, toolAuthorization service and fallback permission flows, askUserQuestion answer/cancel/abort paths, and the canUseToolNormalization safety net

### Changed
- Opt GitHub Actions workflows into the Node.js 24 runtime (FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true) to silence deprecation warnings ahead of the forced default in June 2026

### Fixed
- Use `npm install --force` for the cross-arch native binary step so npm accepts platform-specific optional dependencies on the arm64 CI runner (was failing the CPU check and blocking the Intel Mac build fix from actually shipping)
- Intel Mac builds now ship with the correct native binaries: CI installs target-arch Claude Agent SDK and OpenAI Codex packages when cross-compiling macOS x64 on an arm64 runner, resolving "CLI not found" errors
- Windows agent mode input is focusable on the first session: guard auto-focus with an offsetParent visibility check and use IntersectionObserver to retry when the panel becomes visible
- Windows auto-update relaunches the app after silent install (flip NSIS runAfterFinish to true) so the update flow matches macOS
- Race condition in ElectronDocumentService where refreshWorkspaceData didn't set initializationPromise, letting listDocumentMetadata start a competing background scan that blocked subsequent refreshes via the isScanning guard
- Remove stale ELECTRON_RUN_AS_NODE assertion in the claudeCodeEnvironment test (env var was intentionally removed during the native binary SDK upgrade)

### Removed
<!-- Removed features go here -->

## [0.57.25] - 2026-04-20


### Added
- canUseTool Zod schema compliance tests (43 tests) covering immediateToolDecision trust modes / team tools / MCP tools / delegation, toolAuthorization service and fallback permission flows, askUserQuestion answer/cancel/abort paths, and the canUseToolNormalization safety net

### Changed
- Opt GitHub Actions workflows into the Node.js 24 runtime (FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true) to silence deprecation warnings ahead of the forced default in June 2026

### Fixed
- Intel Mac builds now ship with the correct native binaries: CI installs target-arch Claude Agent SDK and OpenAI Codex packages when cross-compiling macOS x64 on an arm64 runner, resolving "CLI not found" errors
- Windows agent mode input is focusable on the first session: guard auto-focus with an offsetParent visibility check and use IntersectionObserver to retry when the panel becomes visible
- Windows auto-update relaunches the app after silent install (flip NSIS runAfterFinish to true) so the update flow matches macOS
- Race condition in ElectronDocumentService where refreshWorkspaceData didn't set initializationPromise, letting listDocumentMetadata start a competing background scan that blocked subsequent refreshes via the isScanning guard
- Remove stale ELECTRON_RUN_AS_NODE assertion in the claudeCodeEnvironment test (env var was intentionally removed during the native binary SDK upgrade)

### Removed
<!-- Removed features go here -->

## [0.57.24] - 2026-04-20


### Added
<!-- New features go here -->

### Changed
- Consolidate iOS CI from 3 sequential macOS jobs to 1, cutting roughly two-thirds of runner time by removing redundant npm ci/simulator boot/Xcode setup and no-op UI test plan check

### Fixed
- Restore login/logout after the Claude Agent SDK upgrade to native binary packaging: resolve the platform-specific binary path instead of the removed cli.js, run the binary directly instead of via ELECTRON_RUN_AS_NODE, and fall back to system-installed claude.exe on Windows
- Normalize canUseTool response shape (updatedInput on allow, message on deny) in the ClaudeCodeProvider wrapper to satisfy the SDK native binary's Zod schema validation
- Silence noisy auth/sync logs for unauthenticated users in collabDocuments, SyncManager, and iOS SyncManager/DocumentSyncManager so startup logs stay clean when signed out

### Removed
<!-- Removed features go here -->

## [0.57.23] - 2026-04-20


### Added
<!-- New features go here -->

### Changed
- Upgrade Claude Agent SDK to 0.2.114 for Zod 4 compatibility; bump zod to ^4.0.0 across the workspace
- Expanded MCP error logging: onerror handler and top-level try/catch with tool name/args in all 7 MCP servers, prefixed `[MCP:server-name]` for easy grepping
- Log canUseTool return values in ClaudeCodeProvider to diagnose SDK validation failures

### Fixed
- Silent Windows auto-updates so users no longer see the NSIS installer wizard
- Prevent duplicate tool call entries in agent provider transcripts (claude-code, codex, opencode) by gating the legacy addMessage path to chat providers only
- Migrate existing users' persisted Claude Code model list to include the Opus 4.6 variant so upgrading Windows users see it again in the Agent picker
- Default Claude Code model list now includes Opus 4.6 for fresh installs
- Restore actual release notes (from CHANGELOG.md) on internal GitHub Releases instead of the hardcoded boilerplate that had been used since Sep 2025
- Restore package-lock.json optional flags that were stripped by npm install during the SDK upgrade, unblocking CI on Linux x64

### Removed
<!-- Removed features go here -->

## [0.57.22] - 2026-04-20


### Added
<!-- New features go here -->

### Changed
- Upgrade Claude Agent SDK to 0.2.114 for Zod 4 compatibility; bump zod to ^4.0.0 across the workspace
- Expanded MCP error logging: onerror handler and top-level try/catch with tool name/args in all 7 MCP servers, prefixed `[MCP:server-name]` for easy grepping
- Log canUseTool return values in ClaudeCodeProvider to diagnose SDK validation failures

### Fixed
- Silent Windows auto-updates so users no longer see the NSIS installer wizard
- Prevent duplicate tool call entries in agent provider transcripts (claude-code, codex, opencode) by gating the legacy addMessage path to chat providers only
- Migrate existing users' persisted Claude Code model list to include the Opus 4.6 variant so upgrading Windows users see it again in the Agent picker
- Default Claude Code model list now includes Opus 4.6 for fresh installs

### Removed
<!-- Removed features go here -->

## [0.57.21] - 2026-04-20


### Added
- Delete custom tracker types from Settings > Trackers (built-in types remain protected)
- Prewarm Claude Code SDK subprocess while user types for near-instant first-query response

### Changed
- Upgrade Claude Agent SDK to 0.2.114 with native per-platform binaries; remove Electron-as-Node launch chain, standalone binary toggle, and Bun/claude-helper CI steps
- Prune non-target SDK binaries in afterPack to shrink installer by ~500MB
- Runtime tsconfig upgraded to ES2024 for AsyncDisposable support; zod pinned to v3.23 for claude-agent-sdk compatibility

### Fixed
- TrackerPlugin no longer destroys automationStatus frontmatter, fixing stale lastRun, "[object Object]" schedule, and mismatched runCount in the automations UI (NIM-324)
- Manual "Check for Updates" works after previously dismissing an update with "remind me later"
- Windows Claude Code subprocess "exit code 1" failures resolved via native binary architecture; stderr is now captured for diagnostics

### Removed
<!-- Removed features go here -->

## [0.57.20] - 2026-04-20


### Added
- Opus 4.6 remains selectable in the Claude Code model picker via a pinned variant

### Changed
- Validate extraResources paths before building

### Fixed
- Recover sync quickly after network change or laptop sleep
- Yield tool_call chunks from claude-code so lastTextSection resets between text sections
- Codex SDK missing from packaged builds after upgrade

## [0.57.19] - 2026-04-17


### Changed
- Temporarily disabled Windows ARM64 build in CI while winCodeSign/DigiCert tooling gaps are sorted out

## [0.57.18] - 2026-04-17


### Added
- Windows ARM64 build alongside x64
- Extension marketplace and Claude Plugins now open to all users

### Changed
- Single source of truth for Claude Code variant versions and labels
- Rebuilt iOS transcript bundle

### Fixed
- Unblock Windows ARM64 Electron build by resolving missing signtool.exe
- Skip workerd postinstall on Windows ARM64 CI
- Marketplace extension install on Windows
- iOS: stopped stale SwiftUI teardown from stranding the next session
- Render Codex transcripts on iOS and Android via canonical projection
- Prevent main-process OOM from release-artifact file storms
- Align Codex/OpenCode provider tests with text chunk yields

## [0.57.17] - 2026-04-17


### Fixed
- Marketplace extension install on Windows

## [0.57.16] - 2026-04-17


### Added
- Windows ARM64 build alongside x64
- Extension marketplace and Claude Plugins now open to all users

### Changed
- Single source of truth for Claude Code variant versions and labels
- Rebuilt iOS transcript bundle

### Fixed
- Skip workerd postinstall on Windows ARM64 CI (unblocks ARM64 build)
- iOS: stopped stale SwiftUI teardown from stranding the next session
- Render Codex transcripts on iOS and Android via canonical projection
- Prevent main-process OOM from release-artifact file storms

## [0.57.15] - 2026-04-16


### Added
- Windows ARM64 build alongside x64
- Extension marketplace and Claude Plugins now open to all users

### Changed
- Single source of truth for Claude Code variant versions and labels
- Rebuilt iOS transcript bundle

### Fixed
- iOS: stopped stale SwiftUI teardown from stranding the next session
- Render Codex transcripts on iOS and Android via canonical projection
- Prevent main-process OOM from release-artifact file storms

## [0.57.14] - 2026-04-16


### Added
- Claude Opus 4.7 with the full 1M-token context window as the default Claude model (`claude:claude-opus-4-7`). Opus 4.7 uses 1M context natively on the Messages API — no `context-1m-2025-08-07` beta header required, unlike Opus 4.6. Previous default (Sonnet 4.6) remains selectable.
- Commit-tracker item linking with opt-in automation settings
- Session phase badges shown in agent mode history panel

### Changed
- Upgraded `@anthropic-ai/claude-agent-sdk` from 0.2.87 to 0.2.111 (Opus 4.7 support, task management, agent teams, plan-mode refinements)
- Upgraded `@openai/codex-sdk` from 0.117.0 to 0.121.0
- Upgraded `@modelcontextprotocol/sdk` to 1.29.0
- Claude Agent variant label now reports Opus 4.7 (was Opus 4.6)
- Simplified tracker automation to 2 toggles with CLAUDE.md hint
- Lowered tool-search threshold to 2%
- Local config for trackers: added blog, bug, and task metadata configurations

### Fixed
- Unconditionally strip `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from `process.env` at main-process startup; explicitly clear them in `options.env` for the Claude Code SDK and in the Codex child-process env so the 0.2.111 overlay behavior (which no longer replaces `process.env`) cannot silently re-introduce a shell-inherited key
- Deduplicate claude-code notification text between assistant and result chunks
- Correct Opus 4.7 context window reporting to 1M
- Defer React root.unmount() to avoid render race condition
- iOS transcript loading deadlock and unified iPad/iPhone session list
- Awaiting-input indicator visibility and priority in session history
- Tracker comments now appear immediately after posting

## [0.57.13] - 2026-04-15


### Added
- Main-process commit event subscription API in GitRefWatcher

### Changed
- Updated About window copy to reflect current product positioning

### Fixed
- OS notifications now show actual response text and session title instead of text before trailing tool calls
- Tracker sync: content refetch retry, nullish checks, and dbRowToRecord improvements
- Prevent aiSaveSettings callers from clobbering unrelated fields via read-modify-write
- Wire tracker comments, activity, and content through sync pipeline
- Tracker items created via MCP now get local issue keys and proper content formatting
- Unified shift/cmd-click selection across all session group types
- Persist fieldUpdatedAt timestamps for correct tracker sync last-write-wins
- Render system errors as errors instead of system reminders
- @@session reference links now navigate to the referenced session
- Auto-open workspace when mobile sends prompts to a closed project
- Unified tracker kanban and list view data sources to eliminate ghost entries

## [0.57.12] - 2026-04-14


### Added
- Configurable issue key prefix per project in tracker settings

### Fixed
- Session list shift-select range and bulk archive from context menu
- ExitPlanMode auto-accepted without showing confirmation widget
- Editor overflow menu clipped by diff header in agent mode
- Cursor hijacking and sibling editor sync in DocumentModel
- Full tracker item context now included when launching sessions from tracker
- Hardened E2EE security boundaries for key rotation, room deletion, and member removal
- Hardened E2EE key rotation to prevent data loss on member removal
- Markdown Document roles now include rank property
- Session input placeholder text updated to include navigation commands

## [0.57.11] - 2026-04-13


### Added
- Column header click-to-select and right-click context menu in session kanban
- Drag-to-sort manual card ordering in tracker kanban board
- "Unassigned" filter for tracker items
- Owner avatar display on tracker kanban cards

### Changed
- Renamed /plan extension command to /design
- Redesigned tracker table as Linear-style list layout

### Fixed
- Stale session:waiting event no longer overrides running status
- Account and sync settings page now reflects current working state
- Remote MCP OAuth no longer prompts on startup
- VisualDisplayWidget guards against non-array items argument
- Tracker "Mine" filter now correctly matches authenticated user identity
- Tracker document header displays for legacy planStatus frontmatter
- Tracker item counts on settings screen now show real data
- Sibling editor save-overwrite cycle prevented in DocumentModel

### Removed
- Dead createTrackerDocument code from OnboardingService

## [0.57.10] - 2026-04-10


### Added
- DocumentModel coordination layer for multi-editor file sync
- "Install Chrome Extension" option in Help menu
- Shift-click range selection on tracker kanban board

### Changed
- Tracker system refactored to be fully schema-driven via TrackerRecord and roles
- Input placeholders updated to include session mention syntax

### Fixed
- Codex OAuth no longer opens at session start; requires mcp-remote auth cache before injecting native OAuth remotes
- Deduplicated Codex tool call events with recycled item IDs
- Hardened OAuth MCP server flows to prevent unauthorized remote servers from triggering login on startup
- TeamSync doc index messages now queued while offline instead of silently dropped
- Tracker authorIdentity preserved when document indexer re-indexes items
- Windows terminal shell selection made reliable
- Local images inlined as base64 in shared file links
- Duplicate AskUserQuestion events in transcript prevented
- Synthetic assistant messages that echo errors now skipped
- Extension-sdk alias added to transcript vite configs for CI

## [0.57.9] - 2026-04-08


### Fixed
- Tool call file edit FK violation and Codex duplicate tool call widgets
- Files scope dropdown now stays above transcript actions
- Tracker sync reconnects indefinitely instead of giving up after 10 attempts
- Org key split-brain encryption and tracker sync reliability
- Tracker panel, sync timestamps, and Durable Object migration
- Duplicate user messages in transcript during streaming

## [0.57.8] - 2026-04-03


### Added
- Tracker user identity system with configurable table columns and resizable panels
- Multi-type tracker items with type tags and feature type support
- Rich tracker transcript widgets with structured data and click-to-navigate
- Linked tracker items moved from transcript banner to dedicated sidebar panel
- Tracker sync identity hardening and issue-key workflows
- Complete tracker field exposure, archive sync, and reconnect support
- Dev-only background task tracker shell
- Meta-agent session type for orchestrating multiple AI coding sessions

### Changed
- Unified transcript write path through single TranscriptTransformer
- Extracted shared SettingsToggle component and consolidated Advanced Settings layout
- Kanban dynamically discovers status columns from actual items

### Fixed
- TrackerToolWidget uses toolName from canonical transcript type
- Stale draft sync echoes on iOS rejected to prevent text jumbling
- Tracker sync not working between users (three bugs)
- PDF viewer extension fails to load due to code splitting
- TrackerSync reconnects through JWT expiration instead of giving up
- Splash screen no longer sets alwaysOnTop
- Kanban context menu archive now acts on multiselected sessions
- Tracker MCP notifications, duplicate search, and Mine filter
- Auth deep link login on secondary dev instances and tracker sync reconnect loop
- TranscriptPeek on session kanban board failing due to dynamic imports
- Persisted hidden gutter buttons and removed dead projectState blob
- Workerd process group killed on test teardown to prevent orphaned processes
- Git commit proposal no longer hangs on transport drop
- MCP config lookup uses parent project path for worktree sessions

## [0.57.7] - 2026-04-02


### Added
- Meta-agent session type for orchestrating multiple AI coding sessions

### Fixed
- Git commit proposal no longer hangs when transport drops during commit
- MCP config lookup now uses parent project path in worktree sessions
- Codex session meta widget and duplicate AskUserQuestion prompt

## [0.57.6] - 2026-04-02


### Changed
- Transcript UI now consumes TranscriptViewMessage directly, removing intermediate mapping layer

### Fixed
- Duplicate "yes" messages no longer incorrectly deduplicated in transcript
- TypeScript errors in transcript projector InteractivePromptPayload cast
- BashWidget and FileChangeWidget elapsed time display using correct timestamp field

## [0.57.5] - 2026-04-01


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Codex SDK missing from packaged builds

### Removed
<!-- Removed features go here -->

## [0.57.4] - 2026-04-01


### Fixed
- CI unit tests broken by canonical transcript migration

## [0.57.3] - 2026-04-01


### Added
- Running tool calls now show elapsed time indicator
- Queued prompts now bundle into a single prompt instead of running sequentially
- Queued prompts can be sent immediately via SDK interrupt
- Clean screenshot export for extensions via exportToPngBlob convention
- GIF images in transcript now have play/pause and frame scrub controls

### Changed
- Single write path for transcript canonical events (refactored dual-write to unified pipeline)

### Fixed
- Elapsed timer no longer runs indefinitely after tool completes
- EditorScreenshotWidget now displays images correctly in transcript
- Excalidraw tools no longer fail on valid file paths
- Default model no longer resets from Opus 4.6 1M to Opus 4.6
- Session metadata widget now displays in Claude Code sessions
- Pending/error sessions no longer re-query indefinitely
- Codex sessions now produce canonical transcript events
- Added gifuct-js type declaration to fix pre-push typecheck

## [0.57.2] - 2026-03-30


### Changed
- Renamed MockupScreenshotWidget to EditorScreenshotWidget for clarity

### Fixed
- API keys from user's environment variables (e.g. .env files) are no longer silently used for provider authentication
- Excalidraw MCP tools no longer fail when no file is active in the editor
- Dotfiles like .env are now visible in the file tree

## [0.57.1] - 2026-03-30


### Added
- Canonical transcript storage: all transcript rendering now uses ai_transcript_events table for consistent, provider-agnostic display
- Database browser: inline cell editing for viewing and modifying data

### Changed
- Updated claude-agent-sdk 0.2.81->0.2.87, mcp-sdk 1.27.1->1.28.0, codex-sdk 0.114.0->0.117.0

### Fixed
- Canonical transcript handlers (list-user-prompts, get-tail-messages) were unreachable due to misplaced closing brace
- TypeScript errors in transcript event store and converter
- Improved Figma MCP OAuth error messaging with clearer user guidance

## [0.57.0] - 2026-03-27


### Added
- Git extension: Changes tab with staged/unstaged file lists and Output tab for git command logs
- Clipboard helpers (`readClipboard`/`writeClipboard`) added to extension SDK

### Changed
- Upgraded Electron 37 to 41.0.4 (Chromium 146, Node 24)
- Browser extension cleaned up for public release

### Fixed
- Prevent iOS initial sync from deleting all server files
- Improve web clipper content extraction for JS-heavy sites
- Align desktop and iOS notification opt-in flow

## [0.56.17] - 2026-03-26


### Changed
- Remove alpha flag gate from tracker kanban view
- Remove alpha limit on automations extension

### Fixed
- Prevent stale PID lock from blocking app launch after reboot or auto-update

## [0.56.16] - 2026-03-25


### Fixed
- Fix extension-sdk build failing with TS5055 when dist/ already exists from prior build

### Removed
<!-- Removed features go here -->

## [0.56.15] - 2026-03-25


### Fixed
- Fix CI build failure: externalize extension-sdk from runtime vite build to prevent circular package resolution

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.56.14] - 2026-03-25


### Added
- Hidden editor mounting for agent MCP tool execution
- Cloudflare Analytics Engine integration in collabv3 for product usage metrics
- Bidirectional linking between tracker items and AI sessions
- Read-only web viewer for shared extension files
- MarkdownEditor and MonacoEditor exposed to extensions via SDK
- Custom editors can opt out of diff and header chrome
- Model status page links in usage popovers
- Download-as-markdown button for shared file viewer
- MarkdownEditor wrapped with platform features for extensions

### Changed
- Renamed /plan command to /design to avoid conflict with Claude built-in
- Updated extension SDK package and version numbers

### Fixed
- Session sort timestamp no longer bumped by draftInput sync or metadata-only updates
- Improved iPad session list layout density
- WebSocket reconnects when JWT is refreshed during session room sync
- iOS sync failures now detected and surfaced instead of silently failing
- Bundle Claude SDK image binaries in packaged app
- Prevent creating automation items via tracker; fix schedule display
- Extension host helpers routed through the SDK correctly
- Hardened Windows auto-update signing checks
- OffscreenEditorManager tests fixed for incomplete electron mock

## [0.56.13] - 2026-03-25


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Error toasts fired before app mount now correctly display on startup
- Figma MCP migration toast now detects HTTP transport configs in addition to stdio

### Removed
<!-- Removed features go here -->

## [0.56.12] - 2026-03-25


### Added
- Figma MCP server available as a built-in template for easy setup
- Startup warning when Figma MCP OAuth config is broken, with action to open MCP settings
- MCP server disconnection detection and logging during sessions

### Fixed
- New workstream sessions now appear in the session list immediately
- Added missing `action` option to `showWarning` notification type signature

## [0.56.11] - 2026-03-25


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Update errors now direct users to manual download instead of showing a broken auto-update flow
- Codex test connection now shows clear error messages instead of failing silently
- Resolve TypeScript variance error in atomFamilyRegistry

### Removed
<!-- Removed features go here -->

## [0.56.10] - 2026-03-24


### Fixed
- Removing Codex API key now takes effect immediately instead of persisting until restart
- All AI providers now refresh credentials every turn so settings changes apply to existing sessions

## [0.56.9] - 2026-03-24


### Added
- Setting to disable system spellchecker
- Double-click tracker rows with a file to open it in the editor
- Browser extension web clipper with local HTTP clip endpoint

### Fixed
- Resolve EditorContext typecheck errors
- New worktrees no longer show false rebase count
- Keep Claude Agent setting toggles from collapsing
- Update @anthropic-ai/claude-agent-sdk to version 0.2.81
- Extension test infrastructure for multi-window and external projects
- extension_test_run MCP tool now targets the correct CDP window
- Marketplace-installed extensions load immediately without refresh
- Restore Windows auto-update publisherName in signtoolOptions

## [0.56.8] - 2026-03-23


### Added
- OpenCode open source coding agent integration
- Route OS file opens to frontmost workspace window
- MockupLM interactive mode with theme toggle, drag-and-drop, project system, and editor context API
- Automation execution history and tracker integration
- Clickable links in iOS session transcript
- Multi-config support in Playwright panel for extension tests
- Project quick open dialog and Window menu discoverability
- Extension live integration test infrastructure
- Extension marketplace deployment with live registry connection
- Plugin.json validation before passing to Claude Code SDK
- Native screenshot capture with dark/light theme support
- Sleep prevention mode selector (off/always/when plugged in)
- Feature usage tracking system for local UX decisions
- Contextual tips system with mobile keep-awake tip
- Extension marketplace screenshots with dark/light theme support
- Default new users to Opus 4.6 (1M context) and auto-migrate existing Opus users

### Changed
- Commented out noisy debug logs in renderer

### Fixed
- Respect Codex API key without breaking CLI auth
- Restore Claude Code image attachments in dev
- Keep new markdown files syncing and expand tracker detection
- Context usage indicator shows 1M for extended context models
- ExitPlanMode now blocks for user confirmation instead of auto-allowing
- Extensions can now override built-in editors for compound file types
- "All Uncommitted Files" mode no longer shows committed session files
- Extension project intro dialog Continue button not working
- Android UX alignment with iOS navigation model and session sync fix
- Docker E2E setup aborts instead of corrupting host binaries
- Tracker dates no longer show Updated before Created
- Tracker detail panel clears on type switch; existing items now save
- Context window shows correct /1M instead of /200k when subagents are used
- Display "1M" instead of "1000k" for million-token context windows
- Hardened plan tracking defaults, settings merge, and test selectors

## [0.56.7] - 2026-03-20


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Hardened plan tracking defaults so unconfigured callers don't silently inject plan tracking instructions
- Settings merge in sdkOptionsBuilder is now safe against future key overwrites
- Added data-testid to plan tracking toggle for E2E testability

### Removed
<!-- Removed features go here -->

## [0.56.6] - 2026-03-19


### Fixed
- Codex CLI binaries now bundle correctly in packaged builds (extraResources path pointed to monorepo root instead of local node_modules)

## [0.56.5] - 2026-03-19


### Added
- Developer Dashboard with atomFamily instance tracking, live time-series charts for memory/watchers/atoms, DB query performance monitoring, IPC handler stats, and renderer memory tracking
- Tracked atomFamily wrapper for debug monitoring in Developer menu

## [0.56.4] - 2026-03-19


### Added
- Codex todo_list items now render as checklists in transcript
- Slash command menu sections appear in logical order

### Changed
- Replaced correlated subqueries with pre-aggregated LEFT JOIN for better query performance

### Fixed
- Codex provider no longer silently drops unrecognized event types
- Symlinked skills and commands now discovered in slash menu

## [0.56.3] - 2026-03-18


### Added
- Opus 4.6 and Sonnet 4.6 1M context models in model selector

### Changed
- Updated claude-agent-sdk 0.2.69 to 0.2.76, codex-sdk 0.110.0 to 0.114.0
- Plan mode tool restrictions now delegated to SDK natively

### Fixed
- Remove extensionFileTypesLoader not in AgentToolHooksOptions interface
- Require plan path when exiting planning mode
- Keep started agent sessions on their original provider
- Prevent agent response text from appearing twice in transcript

## [0.56.2] - 2026-03-18


### Added
- Marketplace Cloudflare Worker, packaging pipeline, and CDN redirects
- Packaged third-party notices and license audit report

### Fixed
- Tracker items with source=native are now always editable
- Docker E2E tests no longer corrupt host platform-specific binaries
- PromptQuickOpen now scrolls transcript to the selected prompt
- Infinite reconnect loop on collab doc decryption failure with auto-recovery for lost org keys
- preventSleepWhenSyncing setting no longer lost on app restart
- Deleting inline tracker items now removes the line from the source file
- Tracker table multi-select and double-click to open file
- Git panel no longer loops refreshing in empty repos
- Tracker and workspace summary header alignment

### Removed
<!-- Removed features go here -->

## [0.56.1] - 2026-03-17


### Added
- Tracker MVP: drag-and-drop reordering, inline editing, multi-select, delete/archive all items, multi-select filters, frontmatter editing

### Changed
- useEditorLifecycle hook moved to extension-sdk package
- Floating-ui positioning rule extracted to dedicated rules file

### Fixed
- Context menus and kanban scroll use floating-ui for correct positioning
- Queued messages not firing when SessionStateManager.endSession did not emit session:completed
- Queued prompts not continuing after guarded turn completion
- Missing build script for editor configuration
- Duplicate last message appearing when loading session transcript
- iOS background SQLite crash from full index sync on every reconnect

### Removed
<!-- Removed features go here -->

## [0.56.0] - 2026-03-16


### Added
- Session recovery system: survive app restart with pending questions
- Extension marketplace with security warning and alpha gate
- Keep Awake option to prevent Mac sleep while syncing
- E2E encrypted document sync between desktop and iOS
- Native Android client with mobile sync parity
- Extension project intro modal with simplified creation flow (neutral starter scaffold)
- Extension examples in intro modal
- Richer documentation scaffolding for new extension projects
- CLAUDE.md and .agents.md generation in new extension projects
- useEditorLifecycle hook with migration of all extensions
- Extension API for direct AI chat completions with responseFormat support
- Extension contribution points for commands, keybindings, and panel tooltips
- Context menu to hide/show navigation gutter buttons
- Collaborative cursors that scroll with content and fade on inactivity
- Per-table database query stats with blocked time tracking
- Git extension improvements: hover card positioning, branch submenus, pull rebase, auto-refresh
- Created/updated timestamps in tracker document header
- Cmd+Shift+V to force-paste text without attachment conversion
- Android/iOS parity improvements and PostHog analytics

### Changed
- Sync identity uses path-based SHA-256 instead of YAML frontmatter syncId
- DataModelLM auto-layout replaced with ELK layout engine
- OpenAI model defaults refreshed to current GPT-5.x and GPT-4.1 IDs
- ClaudeCodeProvider static DI and SDK options extracted into focused modules
- MCP tool schemas colocated with handler implementations
- httpServer.ts (4,258 lines) split into focused modules

### Fixed
- SSE keepalive pings prevent MCP connection death during long tool waits
- Orphaned UUID-keyed files purged on server during sync handshake
- Single app activation on launch instead of per-window focus steal
- Skip writing remote sync files when local content already matches
- New projects no longer open with terminal panel visible
- Extensions can no longer hijack keyboard input in text fields
- AskUserQuestion no longer hangs when routed through MCP server path
- Sessions no longer stuck as 'running' after git commit proposal with dead subprocess
- SDK result messages now render correctly in agent transcript
- Theme type consistency across extension APIs (string type)
- PDF-viewer extension fileIcons format causing manifest validation failure
- Mobile AskUserQuestion answers not reaching MCP server
- Extension chat completion API: skip DB logging, simplify ResponseFormat, reduce noise
- Virtual refs in floating-ui cast for TypeScript strict checks
- Windows publisherName set to prevent auto-update rejection on cert change
- Claude-code user-agent set on usage API requests
- E2E session-management tests passing with proper data-testid selectors
- TypeScript strict null errors blocking git push

## [0.55.31] - 2026-03-12


### Added
- PostHog DAU tracking via app_foregrounded event
- Mobile and desktop PostHog users now merge on QR pairing

### Changed
- Convert file tree scanning from synchronous to async fs operations
- Narrow extensions find-files scan root using glob literal prefix
- Eliminate main-process blocking when opening large non-git projects
- Git remote lookups no longer block the main process on startup
- Opening large projects no longer freezes the UI

### Fixed
- File tree loading spinner no longer spins forever on empty workspaces
- Community dialog logo now shows in packaged builds
- TypeScript errors in playwright extension

## [0.55.30] - 2026-03-12


### Changed
- Centralize WalkthroughProvider IPC listeners into store
- Centralize UpdateToast IPC listeners into store

### Fixed
- Mobile sync initial setup not syncing and pairing without projects
- Thinking indicator hidden and waiting state not restored after session switch
- AskUserQuestion widget stays pending after session abort
- Automations extension incorrectly on stable channel (reverted to alpha)
- TypeScript errors across electron and playwright packages

## [0.55.29] - 2026-03-12


### Added
- PostHog analytics tracking for session kanban board interactions

### Changed
- Adopted @floating-ui/react for all dropdown and popover positioning (replaces custom positioning logic)
- Consolidated E2E test suite to reduce Electron launches from ~83 to 29 files

### Fixed
- Guard against pending-cleared reload race condition during diff tag clearing
- Sessions stuck in 'running' state after completion
- Opening files from the file tree now uses IPC instead of scrolling the virtualized tree
- Preserve Keep All content in chained diff replacements when applying sequential markdown changes
- Prevent false diff markers on list items with bold text
- Kanban peek panel and context menu rendered transparent in the Complete column

## [0.55.25] - 2026-03-07


### Changed
- CollabV3 updated to 0.1.36

### Fixed
- Suppress mobile push notifications when desktop app is active
- Mobile session creation fails after sync reconnection

## [0.55.24] - 2026-03-06


### Added
- "Other" freetext option in AskUserQuestion widget for custom responses

### Changed
- CollabV3 updated to 0.1.35

### Fixed
- Prevent sign-out on network errors and persist sync identity across restarts

## [0.55.23] - 2026-03-06


### Changed
- CollabV3 updated to 0.1.34

### Fixed
- Prevent sync echoes from overwriting active typing in AIInput
- Mobile session sync broken by multi-org auth changes

## [0.55.22] - 2026-03-06


### Added
- Folder-based navigation for shared collab docs with create folder/document flows, drag-and-drop reordering, and persisted tree UI state

### Changed
- CollabV3 0.1.32 with improved team vs personal org tracking

### Fixed
- Restore shared link ownership and labels by classifying Stytch orgs with explicit personal/team metadata
- Keep AI input typeahead selection in sync
- Show Codex web search calls in session transcripts
- Restore Codex image attachments in session transcripts
- Deduplicate repeated transcript edit previews
- Render Codex session reminders as system cards instead of raw text
- Restore AI session creation tracking in modern flows (PostHog `create_ai_session` events)

## [0.55.21] - 2026-03-05


### Fixed
- Replace emoji with Material Symbols icon in session mention typeahead
- Git commit proposal widget disabled when model sends filesToStage as string instead of array
- Update Claude Haiku version label from 3.5 to 4.5 in model picker
- CI test failures on Linux

## [0.55.20] - 2026-03-05


### Added
- Configurable thinking level for OpenAI Codex sessions
- `nimbalyst_version` super property added to all PostHog events
- Open transcript file links directly in the editor instead of the browser
- AskUserQuestion support in Codex agent flow
- First-turn reminder for Codex session metadata tool usage

### Changed
- Split ClaudeCodeProvider into focused workflow modules

### Fixed
- Harden Codex MCP prompt routing, server config, and broken startup
- Isolate git commit proposal responses per session
- Sanitize dotted MCP server names for Codex TOML config (e.g., `@scope/name` no longer produces invalid TOML keys)
- Restore Configure Models navigation from model selector
- Restore Monaco background for Monokai theme with built-in theme ID mapping
- Prevent table resizer crash on stale cell refs

## [0.55.18] - 2026-03-05


### Fixed
- Correct GPT-5.4 model ID (renamed from gpt-5.4-codex to gpt-5.4) with migration alias for existing users
- Remove silent model fallback that masked invalid model errors by switching to a different model

## [0.55.17] - 2026-03-05


### Added
- GPT-5.4 Codex model support

### Changed
- Update @openai/codex-sdk 0.107.0 -> 0.110.0
- Update iOS App Store link with correct Apple ID and remove Coming Soon badge

### Fixed
- Show archive confirmation dialog after clean worktree merge
- Regenerate lock file to fix corrupted Codex binary integrity hashes
- Session HTML export typecheck failure on ES2020 target
- Bulk archive now correctly archives all selected sessions

## [0.55.16] - 2026-03-05


### Added
- Unified tracker system with database-first storage, file import, and MCP tools
- @@ session mention typeahead in chat input
- Drag-and-drop session mentions onto chat input
- MCP servers can be enabled per-provider (Claude/Codex)
- Auto-compare blitz sessions when all sessions finish
- Codex usage indicator re-enable toggle

### Changed
- Update claude-agent-sdk 0.2.63 -> 0.2.69, codex-sdk 0.106.0 -> 0.107.0
- Remove beta label and warning from OpenAI Codex

### Fixed
- Checkbox state changes silently lost in diff mode
- Session provider icon uses correct provider and updates on model change
- Keep session history metadata in sync (provider, model, title changes broadcast to renderer)
- Prevent session export/share from freezing on large sessions
- Deduplicate concurrent usage API refresh calls to prevent redundant network requests
- Reduce usage API polling frequency to prevent 429 rate limiting
- Add ToolSearch to SDK_NATIVE_TOOLS to prevent tool execution failure
- Correct Codex token accounting and context usage display (treat turn usage as cumulative snapshots)
- Scope AI session-state updates to the owning workspace window to prevent cross-workspace interference
- Resolve claude-agent-sdk path for non-hoisted npm workspace layout
- Stabilize unit test execution and CI coverage with deterministic vitest run mode
- Consolidate E2E tests to minimize app launches for CI

## [0.55.12] - 2026-03-04


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Claude Agent API key test no longer returns 404 (updated discontinued model ID)

### Removed
<!-- Removed features go here -->

## [0.55.11] - 2026-03-04


### Added
- Voice agent session navigation and activation sound
- Drag files from file tree into AI input as @-mentions
- Drag files from edited sidebar into AI input as @-mentions

### Changed
- Densified AI sessions dropdown into single-row menu items
- Removed click-to-copy on inline code blocks in transcripts

### Fixed
- Enforced Claude Agent key separation and refresh auth config
- Gitignore bypass only registers for write tools, not Bash
- AI file edits in gitignored directories now detected
- AI file edits now detected regardless of path format
- Persisted unread=false to database when tray session is clicked
- Matched FileGutter vertical spacing to FileEditsSidebar
- Workstream parents inherit phase from children on kanban board

## [0.55.10] - 2026-03-04


### Added
- Track new user creation with user_created analytics event
- Button to open memory file from memory prompt indicator
- Worktree archiving auto-skips confirmation dialog when branch is clean and merged
- Session meta tool shows tag/phase/name transitions in rich widget
- Kanban drag-to-archive cleans up worktree on last session
- Windows code signing via DigiCert KeyLocker

### Changed
- Densified AI sessions dropdown in editor header bar
- Merged name_session and update_tags into single update_session_meta tool
- Split test signing into fast credential check and full build steps

### Fixed
- Removed broken message count from document session history display
- Fixed history dialog session link click target
- Tracker sidebar counts now include frontmatter-based items
- Restored selected session on app restart and page refresh
- Prevented error toast flooding from repeated identical errors
- Prevented tracker items from leaking across workspaces
- Restored runtime prompt build parsing
- Persisted selected workstream immediately to survive app restart
- Used config.userId for sync room routing instead of JWT sub claim
- Fixed signtool.exe discovery by searching Windows SDK directory
- Merged duplicate "overrides" keys in root package.json
- Fixed electron-builder invocation in test signing workflow
- Prevented test signing workflow from publishing to GitHub Releases

## [0.55.9] - 2026-03-03


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Worktree archive from kanban board updates UI immediately without requiring refresh
- Resolved false Codex workspace trust warning by using actual workspace path for connection tests

### Removed
<!-- Removed features go here -->

## [0.55.8] - 2026-03-03


### Added
- Resizable panels, keyboard shortcut, and help tooltip for CollabMode
- Sharing discovery callout on Account & Sync page
- Multi-select and batch drag-drop on session kanban board
- Tracker kanban view (gated behind alpha release channel)

### Changed
- Session context menu reordered into logical groups with dividers

### Fixed
- Worktree sessions load instantly instead of spawning hundreds of git processes
- Single-instance lock so Windows OAuth deep links route to existing app on Windows
- Transcript peek widget no longer flashes at top-left on keyboard navigation
- Terminal panel visibility persists per-workspace instead of globally
- Tray icon included in packaged builds via extraResources
- Team name no longer leaks to Stytch org metadata
- File scope walkthrough delayed until sidebar has actual files

## [0.55.7] - 2026-03-03


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Toggling auto-commit ON in commit widget now actually triggers a commit
- Commit widget shows real progress indicator when toggling auto-commit on

### Removed
<!-- Removed features go here -->

## [0.55.6] - 2026-03-03


### Added
- Collaboration features gated behind alpha release channel flag
- Slack notifications for alpha release builds
- Developer mode users routed to agent mode after onboarding

### Changed
- Unified session context menu across sidebar, kanban, and tabs (shared SessionContextMenu component)
- Paired devices persist across disconnects with online/offline status and "last seen" time

### Fixed
- QuickOpen reveals folders in file tree instead of failing to open them
- iOS CI builds against iOS SDK instead of macOS (xcodebuild targeting iOS Simulator)
- iOS test fixtures aligned with camelCase wire protocol
- iOS transcript bundle tests skip gracefully instead of failing when bundle is absent

## [0.55.5] - 2026-03-02


### Added
- @ mention shows files immediately on typing "@" and supports directory mentions with folder icon
- Context-aware walkthrough guides: agent-mode-intro in Files mode, files-mode-intro in Agent mode
- Hide collab UI when no team configured; show gear icon for disconnected projects

### Changed
- Cmd+1-9 now exclusively switches tabs (removed conflicting window switching shortcuts)
- Sessions Board removed from tracker panel (lives in AgentMode now)

### Fixed
- iOS mobile prompt send failures now show user-visible error alerts and restore draft text
- Draft text no longer bounces back after mobile prompt submit (draftUpdatedAt timestamp for stale rejection)
- Secondary account JWTs auto-refresh on 401 in TeamService instead of failing
- "Share to Team" menu hidden when project has no team
- Tray menu no longer shows stale "blocked" status for completed sessions
- Skip YAML parsing for .astro files whose --- blocks contain JavaScript
- Gutter popover placement fixed to open right instead of above

## [0.55.4] - 2026-03-02


### Added
- Bidirectional draft sync and queued prompts between desktop and iOS
- Multi-account team management with admin role editing and account picker for team creation
- Editable tag rollup in workstream headers with inline autocomplete
- Cmd+Shift+N shortcut to create new AI session from any mode
- New agent sessions pre-populated with @file reference to currently open document
- Kanban board walkthrough and PostHog analytics for session view mode switching

### Changed
- Reduced verbose logging across CollabV3Sync, TeamService, SyncManager, AIService, TrackerSyncManager
- Skip model fetching for disabled AI providers (fixes LM Studio fetch error when not in use)

### Fixed
- Kanban view auto-exits when navigating to a specific session (tray, quick open, double-click)
- Session token corruption when exchanging for secondary accounts
- Undecryptable project entries cleaned up during sync instead of logging errors
- Tray icon uses macOS template images for correct dark/light menu bar rendering
- Tray icon uses system appearance instead of app theme for foreground color
- Tray BGRA byte order fix (blue dots were rendering as orange)
- Unread sessions now seeded from database on tray init
- Key envelope overwrite vulnerability closed in DocumentRoom (empty sender_user_id truthiness check)
- Sub-agent transcript truncation and tool name mismatch (Agent vs Task rename)
- Stale session data when navigating to completed sessions with cached mid-stream snapshots

## [0.55.3] - 2026-03-02


### Added
- Custom Claude executable path setting for corporate SSO wrappers (Browse file picker in Claude Agent settings)
- iOS AI model picker synced from desktop with provider/model fields in CreateSessionRequest
- iOS cancel button for running AI sessions via control messages
- Session archive/unarchive control messages from mobile
- Pre-rendered logo template assets for system tray icon (crisp splat silhouette with hash cutout)
- Uncommitted/committed tag tracking in agent session naming prompt
- /ios-release command for iOS App Store releases with platform-prefixed tags

### Fixed
- Child sessions of worktree-group parents now visible in session list
- Team JWT refresh before personal session exchange to prevent stale token 401s after idle/sleep
- iOS session creation menu shows on single tap instead of requiring long press
- Diff stats color toned down in agent turn summary (opacity-60 to match surrounding text)
- TypeScript error for openFileDialog in ClaudeCodePanel (missing ElectronAPI type)

## [0.55.2] - 2026-03-01


### Added
- System tray menu showing AI session status with click-to-navigate, dock badge for sessions needing attention
- Session kanban board as right-panel view in AgentMode (Cmd+Shift+K toggle)
- Live sub-agent progress tracking in teammate panel (status, elapsed time, tool count)
- Multi-account support: user avatar menu, add/remove accounts, per-project account binding
- Click/tap-to-copy on inline code blocks in transcripts with green flash feedback
- iOS jump-to-prompt bottom sheet in session detail view
- iOS hierarchical session navigation with worktree/workstream sync (6 new metadata fields)
- Log rotation on startup (keeps 2 previous sessions) and Developer menu "Rotate Logs" option
- Rate limit warning/blocked widgets with amber/red styling

### Changed
- Updated claude-agent-sdk to 0.2.63
- SDK now handles background sub-agents natively instead of TeammateManager interception

### Fixed
- Voice agent answering interactive prompts (prompt forwarding race, IPC channels, widget display)
- iOS transcript blank screen caused by React hooks ordering violation
- iOS compact button now sends /compact command through native bridge
- iOS voice playback routed through VPIO bus 0 for proper echo cancellation
- Auto-delete undecryptable session index entries so they re-sync with correct key
- Rate limit events from Claude Code SDK now handled instead of dumped as unhandled messages
- Git commit widget shows committed state when reloading sessions (missing tool_result)
- Tracker items now load automatically on startup via deferred workspace scan
- Scroll-to-bottom button is now a proper circle
- Rate limit reset times use Unix timestamps to prevent timezone parsing bugs

## [0.55.1] - 2026-02-27


### Added
- Voice mode: interactive prompt support (answer AskUserQuestion, ExitPlanMode, GitCommitProposal verbally)
- Voice mode: OpenAI API key input directly on Voice Mode settings panel
- Maximize button in chat sidebar to open current session in agent mode
- File count and +/- line stats in agent turn summary ("Finished in 6m 57s · 3 files +45 -12")
- Session kanban board: keyboard navigation (arrows, Enter, Space), Cmd+arrows to move cards between phases, collapsible columns

### Changed
- Updated claude-agent-sdk 0.2.45 -> 0.2.62, mcp-sdk 1.26.0 -> 1.27.1, codex-sdk 0.104.0 -> 0.106.0
- Auto-commit toggle moved from Claude Agent settings to Advanced panel
- Reduced log noise for worktree operations

### Fixed
- Mobile sync broken after team session exchange (personal JWT now preserved across org switches)
- Team panel showing wrong project when multiple teams exist
- Team key envelope distribution: new members now receive shared documents via broadcast + polling
- Voice mode: idle timer running during assistant speech, wake-from-sleep, voice drift, echo cancellation
- Voice agent now receives coding agent results and recent conversation context
- Auto-commit toggle not persisting across app restarts (atom never hydrated from store)
- Zombie WebSocket preventing mobile session sync after network changes
- CI TypeScript check failure for collabv3 test files

## [0.55.0] - 2026-02-26


### Added
- E2E encrypted collaborative document editing via Lexical + yJS through Cloudflare Workers
- E2E encrypted tracker sync with team-scoped Durable Objects
- Team trust model with ECDH key exchange, key envelopes, and Stytch B2B org discovery
- CollabMode for real-time document collaboration with team members
- TrackerMode with kanban board, item detail panel, and sidebar
- Team setup UI: TeamPanel, TrackerConfigPanel, team invite/join dialogs
- Session kanban board atoms and E2E tests
- "Remove from workstream" context menu for child sessions
- WebSocket proxy (IPC-bridged) for document sync to bypass Cloudflare browser blocks
- Lazy batch message loading for session sync (3 sessions at a time)

### Changed
- Consolidated file watchers into single ref-counted WorkspaceEventBus per workspace
- Merged rexical package into runtime (all editor code now in packages/runtime/src/editor/)
- Project rename uses atomic fs.rename() instead of copy+delete to prevent data loss
- Project move no longer auto-deletes original directory; user verifies before deleting
- Session drag-drop onto standalone session now creates proper workstream parent
- Worktree sessions blocked from drag-drop in both directions
- Throttle uncaught exception dialogs (dedup within 5s, max 3/min)
- Multiple dev instances now fully isolated with per-instance outDir and userData

### Fixed
- Shared document list and document sync failures (migration, reconnect, cross-mode handoff)
- Session list not refreshing after importing Claude Code sessions
- Session sync instability across org switches (personalOrgId for consistent room IDs)
- Team collaboration security: sender_user_id tracking, P-256 key validation, JWKS cache-miss refresh
- Session invalidation on team deletion and auth token persistence after session exchange
- OS notification click now switches to agent mode to show the session
- Flush pending DB writes before session completion to prevent stale transcript after /compact
- Clipboard copy silently failing in Electron renderer
- Session context MCP server startup and workstream-aware commit prompts
- All TypeScript compilation errors resolved (38 -> 0)
- Session drag-drop creating broken parent-child relationships

### Removed
- Capacitor package (will build native Android app instead)
- Playground package (no longer needed after rexical merge)
- ChokidarFileWatcher, SimpleFileWatcher, SimpleWorkspaceWatcher (replaced by WorkspaceEventBus)

## [0.54.20] - 2026-02-26


### Added
- Agent prompt now includes multi-session awareness and commit tool guidance
- App update restart is deferred until all active AI sessions finish

### Fixed
- Blitz archive now recursively archives child worktrees
- Built-in terminal now has same PATH as Claude Code sessions

## [0.54.19] - 2026-02-25


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Raised file descriptor limit to prevent silent watcher failures

### Removed
<!-- Removed features go here -->

## [0.54.18] - 2026-02-25


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Fixed Bash edits on gitignored files showing the entire file as green instead of just the changed lines

### Removed
<!-- Removed features go here -->

## [0.54.17] - 2026-02-25


### Added
<!-- New features go here -->

### Changed
- Consolidated file watchers into single WorkspaceEventBus per workspace, halving file descriptor usage
- Added .gitignore-aware filtering and circuit breaker protection against event flooding

### Fixed
- Fixed Bash diff baseline advancing per tracked change
- Fixed Nimbalyst hanging when workspace has thousands of dirty files

### Removed
<!-- Removed features go here -->

## [0.54.16] - 2026-02-25


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Shared links can no longer be created without expiration
- Stable baseline used for Bash file diffs
- Pending AI diffs now apply without manual refresh
- Pending-review diffs preserved for ignored file updates
- Unified files-mode pending review and edited file sync
- Stabilized Codex file baseline and Bash edit visibility

### Removed
<!-- Removed features go here -->

## [0.54.15] - 2026-02-25


### Added
- Share dialog shows inline sign-in (Google/magic-link) when not authenticated instead of redirecting to Settings

### Changed
- Share link expiration capped at 30 days; "No expiration" option removed
- Legacy null (no-expiration) share preferences convert to 7-day default
- Codex API key field labeled as optional with explanation of account-based vs API key pricing

### Fixed
- External file edits no longer dropped when they arrive immediately after a save
- Pre-edit baseline preserved correctly when watcher tag starts empty
- Codex commit widget completion state persists across tab navigation
- Vendored ripgrep now available in enhanced PATH for search functionality
- Community modal social icons restyled to match design (transparent background, blue icons, larger text)
- Community modal stays open when clicking social links; "Accept Invite" renamed to "Join Discord"

## [0.54.14] - 2026-02-25


### Added
- Share modal with expiration options (1/7/30 days or none) and end-to-end encryption notice
- Community channels popup replacing Discord-only popup, with links to Discord, YouTube, LinkedIn, X, TikTok, Instagram
- Persistent Community submenu in Help menu with all social channels
- Smarter community popup timing: triggers after 3 completed AI sessions instead of on app launch

### Changed
- Share link button moved to header bar; removed duplicate from editor dropdown menu

### Fixed
- Share TTL defaults normalized to prevent bad expiration values
- Codex diff baselines preserved correctly for existing files (path normalization, empty-baseline skip)
- Restored dialogRef export from dialogs index (fixes SessionListItem module loading)
- Removed redundant service error modal for Claude outages (error already shown inline)
- Codex no longer inherits OPENAI_API_KEY env variable (must be set explicitly)

## [0.54.13] - 2026-02-25


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Hardened diff tracking security with path validation and size limits
- Same-session multi-edits now show cumulative diffs instead of only the last edit
- Per-tool-call diff tracking correctly isolates diffs for multi-edit files
- Codex diff tracking hardened for async safety, deduplication, and edge cases
- Per-tool diffs preserved correctly for Codex file_change edits
- Codex Bash edits now consistently produce viewable diffs

### Removed
<!-- Removed features go here -->

## [0.54.12] - 2026-02-24


### Added
<!-- New features go here -->

### Changed
- Codex moved back behind beta feature flag (reverted public visibility)

### Fixed
- Settings sidebar widened to fit "OpenAI Codex (BETA)" label without truncation

### Removed
<!-- Removed features go here -->

## [0.54.11] - 2026-02-24


### Added
<!-- New features go here -->

### Changed
- Codex moved back behind beta feature flag

### Fixed
- AI file diffs now show only changed lines instead of entire file
- AI diffs route to the visible editor instance instead of potentially targeting a hidden one
- Database schema creation order fixed so ai_agent_messages precedes ai_tool_call_file_edits
- AI agents more reliably name sessions on their first turn
- Clicking a teammate in the sidebar scrolls to its spawn message in the transcript

### Removed
<!-- Removed features go here -->

## [0.54.10] - 2026-02-24


### Added
- Teammate sidebar shows elapsed time, tool count, and click-to-scroll navigation

### Fixed
- Lead agent no longer hangs waiting for a teammate that already finished
- All sub-agent cards now visible in transcript

## [0.54.9] - 2026-02-24


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Teammate messages no longer hang when lead agent is mid-turn

### Removed
<!-- Removed features go here -->

## [0.54.8] - 2026-02-23


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Codex file_change (apply_patch) diffs no longer missing from tool output
- Session file watcher no longer exhausts file descriptors on macOS/Windows
- Workspace watcher no longer exhausts file descriptors on macOS/Windows
- Super loop progress MCP no longer appears in regular sessions
- Active session now correctly initialized for worktree selections

### Removed
<!-- Removed features go here -->

## [0.54.7] - 2026-02-23


### Added
- Session file watcher now respects project .gitignore rules

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Subagent permission bypass prevented by isolating settings per agent
- Diagnostic logging added to HistoryManager.createTag error path
- Bash pre-tag race condition that dropped red/green diffs in tool output
- Restart indicator no longer shown on brand new sessions
- Cross-session file edit misattribution prevented
- Non-git projects no longer watch node_modules and build directories

### Removed
<!-- Removed features go here -->

## [0.54.6] - 2026-02-23


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- File descriptor exhaustion from workspace watcher opening per-file FDs (2500+ per workspace), causing spawn EBADF with default ulimit
- File descriptor leak from session file watchers causing spawn EBADF errors
- Sub-agents now spawn correctly in packaged builds
- Worktree timestamps no longer shift by local timezone offset

### Removed
<!-- Removed features go here -->

## [0.54.5] - 2026-02-23


### Fixed
- Codex file change diffs now match the correct tool call across machines
- Worktree and workstream session tabs now stay in their creation order
- Bash file changes now detected on Windows
- Codex bash commands now unwrap correctly on Windows
- Claude usage API forbidden responses now log full details for diagnostics

## [0.54.4] - 2026-02-23


### Added
- Codex is now available without enabling beta features

### Fixed
- Usage indicators remain visible when load errors occur
- Grouped session context menus now align with plain session menus
- Improved Claude usage diagnostics with explicit auth failure logging
- Session share links no longer gated behind alpha flag
- Codex bash commands no longer show /bin/zsh -lc wrapper

## [0.54.3] - 2026-02-21


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Tool call diffs now appear for Codex sessions
- File change diffs use history snapshots and exclude human edits
- Shell-wrapped bash commands properly unwrapped for file tracking
- Claude Code no longer leaks or uses the Claude Chat API key
- @ mention file search fixed in dev mode
- Claude usage indicator no longer hidden when utilization is at 0%

### Removed
<!-- Removed features go here -->

## [0.54.2] - 2026-02-21


### Added
- File change diffs shown per tool call in agent transcripts (ToolCallMatcher)
- Share markdown files from editor overflow menu
- Codex local file history diffs with dirty/untracked baseline snapshots
- Agent model choice for git conflict resolution

### Changed
- Codex API key separated from OpenAI API key
- Usage indicators remain visible when usage data is present

### Fixed
- Bash command diffs now display as attachments in tool call widgets
- Tool call file matching stabilized with time cutoff and filename-based scoring
- Failed MCP database queries no longer break subsequent DB operations
- Auto-commit widget now shows success state instead of broken interactive form
- Clearing API key in settings now actually removes it
- EBADF errors no longer break all process spawning including sessions
- Auto-commit no longer shows "No files were staged" error
- Commit widget prefers tool result content

## [0.54.1] - 2026-02-20


### Added
- Voice mode overhaul with persistent button, session tracking, and listen window
- Automations extension for scheduled AI-powered tasks
- Session context MCP server with session awareness tools
- Extensions can now contribute document headers above any editor
- Marketing screenshots work with packaged app, no dev server required

### Fixed
- Session read state now syncs properly between desktop and iOS
- Marketing screenshots fail when launched from packaged Nimbalyst
- Exclude automation documents from frontmatter header processing

## [0.54.0] - 2026-02-20


### Added
- Clicking links in terminal opens them in default browser
- Configurable document history retention in Advanced Settings
- Custom tracker types fully supported in bottom panel and document header
- Account deletion for Apple App Store compliance (5.1.1)
- App Store compliance: privacy manifest and in-app privacy policy link
- Tracker creation writes canonical frontmatter format
- Playwright-based marketing screenshot and video capture system
- Show restart indicator line in AI session transcripts (dev mode)

### Changed
- Unified file actions across context menus

### Fixed
- Share link fails until logout/login due to missing server URL
- Improve session loading performance for large transcripts
- Terminal cursor polish: bar style, focus-aware color, ghost cursor fix
- Terminal cursor only blinks when terminal has focus
- Terminal panel keeps terminals alive when hidden, fixing cursor position bug
- Skip re-uploading TTL-expired sessions to sync server
- Add optional chaining for terminal renderer setTheme call
- Mobile chat input now clears immediately after sending
- Model selector dropdown no longer clipped by agent panel overflow

## [0.53.13] - 2026-02-19


### Changed
- Moved Blitz from beta to alpha feature flag

## [0.53.12] - 2026-02-18


### Added
- QR code opens Nimbalyst iOS app when scanned with Camera
- Extended context settings toggle for 1M context models

### Fixed
- Blitz sessions now show full worktree UI (git ops, terminal, merge)
- Codex usage indicator shown without requiring provider to be enabled
- Folder collapse state preserved in files-edited sidebar
- iOS sessions reorder to top of list when viewed
- iOS shows correct connection status dot when desktop is connected
- Use SDK [1m] suffix for 1M context models

## [0.53.11] - 2026-02-18


### Added
- Sonnet 4.6 support with effort slider, pin 1M context to Sonnet 4.5
- Prompt for push notifications after iOS pairing
- Redesigned Account & Sync settings panel, removed alpha gate

### Changed
- Migrate from Stytch B2C to B2B Discovery OAuth

### Fixed
- iOS push notifications suppressed because device always reported as active
- Stale "waiting for response" indicator after git commit proposal
- Stytch auth deep link now opens Nimbalyst instead of bare Electron
- Codex 401 errors now show the OpenAI auth setup widget

## [0.53.10] - 2026-02-18


### Added
- iOS slash command typeahead and image attachments
- Session search walkthrough with HelpTooltip
- PostHog analytics for sync account flows
- Version tracking for collabv3 deploys

### Fixed
- Context window usage tracking from SDK per-step usage
- Show compaction summary in transcript instead of hiding it
- Collabv3 deploy script version parsing and wrangler define inheritance
- Revert claude-agent-sdk downgrade (restore 0.2.45)

## [0.53.9] - 2026-02-18


### Added
- Track sharing, export, and feature toggle usage in PostHog
- OpenAI Codex 401 errors now show setup instructions
- Teammates now require user approval for tool use
- Queued prompts now show attachment indicators
- Session open buttons now appear in agent mode file headers
- File paths in FILE CHANGES widget are clickable

### Changed
- Unify session types and sync sessionType to iOS
- Revert claude-agent-sdk 0.2.45 to 0.2.42
- Update codex-sdk 0.101.0 to 0.104.0

### Fixed
- Codex beta toggle now enables the provider automatically
- Teammate permission widgets no longer hidden by noise filter
- Worktree file paths now persist correctly when navigating away and back
- AI Sessions popover now groups worktree sessions correctly
- Second queued prompt no longer gets empty response
- Deny button in tool permission widget is now clearly visible
- File-session links now work correctly for agent mode in worktrees
- Hide system-generated user messages from transcript view
- Exclude system-generated user messages from prompt history
- Prevent tool calls from being hidden after teammate notifications
- iOS session list shows model info and readable timestamps
- Show file path as chip in session quick open to prevent text overlap
- Restore horizontal scrolling in database browser tables
- Resolve iOS test runtime crash from Int16 overflow and static var
- Resolve Swift 6 strict concurrency errors in iOS tests

## [0.53.8] - 2026-02-17


### Added
- Super Loop iterations now enforce progress reporting via MCP tool
- Blocked Super Loop sessions show inline feedback widget
- Onboarding survey asks AI referrals what model/prompt they used
- Blitz sessions show model names instead of AI-chosen titles
- Track Codex session starts in PostHog
- Sync pending prompt state to iOS and show indicator

### Changed
- Model blitzes stored as ai_sessions instead of separate table

### Fixed
- Fix packaged Codex SDK loading in Electron
- Resolve TypeScript errors in Super Loop blocked feedback
- Clear stale isExecuting flags on startup and prevent sync overlap
- Add missed files for FileTreeRow tree keyboard handler

## [0.53.7] - 2026-02-17


### Added
- Brand iOS projects list with app icon and Nimbalyst name
- Sync AI session context usage to iOS via encrypted client metadata
- Agent-readable decryption instructions and session keep-alive

### Fixed
- iOS scroll to top functionality in session detail view
- Reduce sync spam by increasing message sync debounce to 10s
- Enable horizontal scrolling in database browser table rows
- Mobile-created sessions now use user's default model preference
- Breadcrumb filename click now clears file tree filter

## [0.53.6] - 2026-02-17


### Added
- Error detection, reporting, and retry for iOS session detail view

### Changed
- Replaced old file tree with new virtualized implementation
- Centralized file tree IPC listener to follow project patterns

### Fixed
- iOS voice mode crash when starting audio capture
- Index WebSocket reconnection loop stops permanently after failed retry
- File tree no longer jumps scroll when expanding directories

## [0.53.5] - 2026-02-16


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Codex models now appear without an OpenAI API key
- Sub-agent messages no longer lost when session ends early

### Removed
<!-- Removed features go here -->

## [0.53.4] - 2026-02-16


### Added
- Show "Waiting for N agents to finish" instead of generic "Thinking..." during multi-agent sessions
- Codex usage indicator in sidebar for subscription users
- Codex CLI prerequisites section in settings panel
- Teammate spawn cards now show live status instead of error icon
- Teammate messages now show as distinct notifications in chat
- Share markdown files as encrypted links
- Show expiry date in share link toast notifications

### Changed
- Move Super Loops from beta to alpha channel
- Make Codex beta status notice more prominent in settings

### Fixed
- Alpha features now properly hide when switching off alpha channel
- Fix endSession race when lead completes inside generator loop
- Fix sub-agent output nesting and session lifecycle
- Prevent BlitzDialog from overflowing viewport
- OpenAI Codex provider now loads in packaged builds
- Fix handleShutdownResult so it emits teammates:allCompleted when last teammate removed
- Cancelled parallel agent spawns no longer show in transcript
- Teammate messages no longer get dropped or stuck
- Always attempt interrupt() for teammate messages instead of queueing
- Cancelling rebase/merge no longer leaves conflict markers in files
- Disable development environment toggle in SyncPanel
- Prevent share operations from signing user out on JWT refresh failure
- QR scanner reliability in release builds
- Show provider icon and name in assistant transcript avatar
- Make transcript avatar icons perfectly round
- Skip TestFlight encryption compliance questions on upload

## [0.53.3] - 2026-02-16


### Added
- Client-side encryption for shared sessions

### Fixed
- Reduce macOS build size from 1.5GB to 631MB by excluding unused node_modules
- Auto-enable alpha features when switching to alpha release channel
- Add macOS platform to NimbalystNative Package.swift
- Update iOS CI to macos-15 runner with Xcode 26.2

## [0.53.2] - 2026-02-16


### Added
- 30-day TTL for synced sessions to automatically clean up old data
- Email magic link login for iOS app (alternative to QR code pairing)
- Screenshot mode for App Store submission

### Fixed
- Cmd+F find routing in Agent Mode split screen now correctly targets the active editor
- Unified iOS splash screen to simple logo on both iPhone and iPad
- Session sharing no longer requires sync config to be set up
- Project sync now triggers immediately and iOS re-pairing works correctly
- Prevent QR scanner from setting invalid rectOfInterest
- Update Xcode scheme and project settings for compatibility

## [0.53.1] - 2026-02-16


### Added
- Sub-agents now appear in sidebar alongside teammates
- Codex reasoning blocks expanded by default for better visibility
- Codex sessions now show "Finished in" duration reflecting actual session time
- AI sessions button shows cross-worktree file history
- "Clear Gitignored Files" context menu action for worktrees
- Shell environment and enhanced PATH passed to Codex SDK

### Fixed
- Auto-commit no longer blocks session when not viewing it
- Fixed text[] cast in getMany query to match ai_sessions.id column type
- Resolved race conditions and reliability issues in teammate management
- Sequential teammate spawning instructions moved to deny responses
- Codex reasoning blocks render inline instead of grouped at top
- Escaped SQL LIKE wildcards and added clean gitignored feedback
- Git clean exclude approach and trim preserve list
- AI sessions button visible in agent mode file viewer
- Resolved Codex CLI in packaged builds

## [0.53.0] - 2026-02-16


### Added
- Native iOS app with SwiftUI navigation and encrypted sync
- Voice mode for native iOS app with OpenAI Realtime API

### Changed
- Standardized wire protocol on camelCase across all sync layers
- Removed deprecated tool packages system
- Removed window title file tracking and IPC overhead

### Fixed
- Prevent bulk sync from clobbering isExecuting and lastReadAt state
- Debounce session data reload during active streaming to prevent flickering
- Enable drag-and-drop of standalone sessions into workstreams
- Resolve TypeScript errors in AI protocol and UI components

## [0.52.70] - 2026-02-15


### Added
- Super Loop iterations now carry learnings forward via progress.json
- Super Loop progress.json snapshots visible in chat transcript with dedicated widget
- Super Loop progress panel in files sidebar showing phase, iteration count, learnings, and blockers
- Super Loop auto-commits .superloop to .gitignore in worktrees
- Super Loop state hardening: startup recovery, session completion signaling, progress file resilience, force-resume for completed/failed/blocked loops
- Force-resume dropdown with configurable iteration options (0/5/10/20)
- Auto-approve commits option for git commit proposals with toggle in settings and widget
- Virtualized session list for faster startup with many sessions
- Codex file changes now show a rich widget with content preview

### Changed
- Renamed Ralph Loops to Super Loops (files, types, IPC channels, DB tables, UI)

### Fixed
- Restored Virtuoso virtualization in SessionHistory after accidental removal
- Super Loop review fixes: pauseResolvers memory leak, forceResumeLoop atomicity
- Codex blocking widgets no longer time out (removed MCP tool timeout for interactive widgets)
- Session list items no longer re-render unnecessarily (React.memo + memoized date formatting)
- Session list no longer slows down with many sessions (O(1) parent-to-children index)
- Super Loop icon alignment in new menu
- Added detailed logging to git commit staging for debugging

## [0.52.69] - 2026-02-14


### Added
- Super Loops - autonomous AI agent iteration system (inspired by Ralph Loops)

### Changed
- Polish blitz creation dialog UI

### Fixed
- Command execution bash widget

## [0.52.68] - 2026-02-13


### Added
- Blitz mode for parallel AI worktree sessions
- Beta features configuration system with user-facing settings

### Changed
- Codex now gated behind beta flag only (no longer requires alpha channel)
- Updated claude-agent-sdk 0.2.39 to 0.2.42 and codex-sdk 0.98.0 to 0.101.0

### Fixed
- Codex packaged binary path resolution
- App icon path in packaged builds using app.getAppPath()
- Blocking prompt icon now clears after commit and shows correctly in groups
- TypeScript errors after SDK dependency update
- Clarified beta features and Blitz descriptions

### Removed
- Activity History panel (reverted)

## [0.52.67] - 2026-02-13


### Added
- Codex file changes now appear in "all session edits" sidebar
- Show elapsed time at end of completed agent turns

### Fixed
- Extension MCP tools now load in worktree sessions
- Prevent double-handling of teammate shutdown requests
- Multi-agent teammate message delivery and session hang
- Teammate/background agent output no longer leaks into main transcript
- Background sub-agents now defer session end like teammates
- Defer session end while teammates are still active
- Codex provider crashes in production builds

## [0.52.66] - 2026-02-13


### Added
- MCP support to OpenAI Codex provider
- Codex SDK to update-libs command

### Changed
- Improved code quality in MCP servers and OpenAI Codex provider
- Improved Codex model discovery security and performance
- Restricted Codex to Allow Edits mode and use permission-based sandbox
- Made shutdownHttpServer async to await transport cleanup

### Fixed
- Claude Code model selection not respected when initializing provider
- Exclude hidden messages from activity history
- Use proper Codex SDK system prompt configuration
- Capture Codex thread IDs from thread.started events for proper session resumption
- Persist all SDK events as raw_event for audit trail
- Remove incorrect documentStateBySession cleanup on disconnect

### Removed
<!-- Removed features go here -->

## [0.52.65] - 2026-02-12


### Added
- Codex raw event storage and grouping in database
- Codex tool calls now render with same widget as Claude Code

### Changed
- Improved Codex provider code quality and performance

### Fixed
- Global-scoped extension tools now visible without active file
- Edit tool now shows red/green diffs after agent refactoring
- Codex text extraction from item.text field
- Codex output saving to database
- TypeScript type errors in AgentToolHooks integration

## [0.52.64] - 2026-02-12


### Added
- Enhanced quick open dialogs with cross-dialog navigation and file search
- Binary path resolution for Codex SDK in packaged builds

### Changed
- Extracted shared agent infrastructure for multi-platform support

### Fixed
- @ mention file search now finds all workspace files
- Transcript scroll-to-bottom button not clickable
- Ctrl+` terminal shortcut not working on macOS and missing tracker tooltip shortcut
- Git commit widget shows actual commit date instead of render time
- TypeScript errors for Claude Agent SDK and Codex test
- Video recording for E2E tests in Docker
- Query type not exported by claude-agent-sdk

## [0.52.63] - 2026-02-11


### Added
- OpenAI Codex provider rewritten from CLI spawning to SDK integration
- Activity History panel (behind alpha flag)
- Managed teammates for agent teams
- Auto-continue AI sessions after restart

### Changed
- Bumped claude-agent-sdk from 0.2.37 to 0.2.39

### Fixed
- Improved rebase instructions to verify correct stash before restore
- Sessions with more than 5000 messages now load fully
- Worktree path used correctly for git commit operations in worktree sessions
- CRLF line endings normalized in markdown import to fix mermaid/code block parsing

## [0.52.62] - 2026-02-10


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Resolved all TypeScript typecheck errors across monorepo
- Fixed per-package typecheck errors matching CI configuration
- Fixed dark mode variants not applying to descendant elements
- Added typecheck scripts to all CI-checked extension packages

### Removed
<!-- Removed features go here -->

## [0.52.61] - 2026-02-09


### Added
- Shareable session links via Cloudflare R2
- Session HTML export and clipboard copy IPC handlers
- Mobile-to-desktop git commit proposal sync
- Syntax-highlighted JSON in database browser cell popup
- New file creation rendered as syntax-highlighted preview instead of all-green diff

### Changed
- Updated @anthropic-ai/claude-agent-sdk to 0.2.37

### Fixed
- Claude Code subprocess now receives full shell environment
- Database browser cell modal closes on Escape key
- Frontmatter UI now appears immediately after Set Document Type
- Nimbalyst mockup Style Guide updated with correct color palette and typography
- Scroll button visibility and behavior in RichTranscriptView
- "Already has a parent" error when selecting workstream child sessions
- Excalidraw MCP tools now always visible to Claude Code agents
- YAML frontmatter stripped from markdown new-file previews; fixed code syntax colors
- Devcontainer npm install no longer overwrites host node_modules

## [0.52.60] - 2026-02-06


### Added
- Splash screen displayed during app startup

### Changed
- Updated @anthropic-ai/claude-agent-sdk 0.2.32 to 0.2.34

### Fixed
- Normalized file paths in git commit handler for cross-platform compatibility
- Resolved TypeScript errors breaking CI typecheck

## [0.52.59] - 2026-02-06


### Added
<!-- New features go here -->

### Changed
- Reverted parallel initialization startup optimization

### Fixed
- Worktree merge errors now show a dialog instead of failing silently
- Prevented bash heredoc content from creating false file tracking entries
- Prevented open_workspace MCP tool from creating duplicate windows

### Removed
<!-- Removed features go here -->

## [0.52.58] - 2026-02-06


### Added
<!-- New features go here -->

### Changed
- Restored 'Use Standalone Binary' option for bun runtime

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.52.57] - 2026-02-06


### Added
<!-- New features go here -->

### Changed
- Faster app startup via parallel initialization

### Fixed
- Pinned PGLite to 0.3.14 to prevent regression from 0.3.15

### Removed
<!-- Removed features go here -->

## [0.52.56] - 2026-02-06


### Added
- Warning dialog when running x64 build on Apple Silicon via Rosetta

### Fixed
- Image generation now respects aspect ratio setting via Gemini API
- Git index.lock race condition between status and commit operations
- ToolPermissionWidget not rendering for compound Bash commands
- Skip redundant permission prompts for built-in MCP tools
- Handle EMFILE errors gracefully in file watchers
- Suppress git errors when opening non-git workspaces
- Updated mobile splash screen

## [0.52.55] - 2026-02-06


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
<!-- Bug fixes go here -->

### Removed
- Removed experimental 'Use Standalone Binary' bun runtime feature for spawning Claude Code sessions

## [0.52.54] - 2026-02-06


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Fixed clicks being blocked after Claude Code login by properly passing auth error flag through IPC error handler and clearing pointer-events overlay

### Removed
<!-- Removed features go here -->

## [0.52.53] - 2026-02-06


### Added
- Agent Teams support for Claude Code sessions with UI toggle in Settings, teammate metadata parsing, and distinct teammate rendering with progress indicators

### Fixed
- Terminal no longer crashes when stored CWD points to a deleted directory (e.g., from a removed worktree)

## [0.52.52] - 2026-02-06


### Added
- Onboarding "Other" referral source now includes a write-in text field
- Effort level selector for Opus 4.6 sessions

### Fixed
- Prevent duplicate error dialog when database lock is detected

## [0.52.51] - 2026-02-05


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Worktree git commits now target the correct directory
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.52.50] - 2026-02-05


### Added
- Diff/Full view toggle in history dialog
- Pending-review dot indicator replaces Keep All banner in git repos
- Claude Usage indicator enabled by default with disable button
- Include executing state for mobile sync in session metadata
- Interactive prompts generalized for Capacitor mobile app

### Changed
- Centralized git operation locking to prevent concurrent state corruption

### Fixed
- File rename now updates open tabs correctly
- Prevent autosave from recreating deleted or renamed files
- Git commit proposal now commits only selected files
- Verify staged files match selection before committing
- Stop Ctrl+ shortcuts from intercepting terminal input on macOS
- Resolve ExitPlanMode SDK promise when approved from mobile
- Remove window.focus() calls that steal foreground on startup
- Increase minimum width of files scope dropdown
- Files scope dropdown click-outside behavior
- Destructure getClaudeCodeExecutableOptions correctly in check-login handler

## [0.52.49] - 2026-02-05


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Restore code accidentally reverted by refactoring commit (Bun signature stripping, session pin transfer, ExitPlanMode null check)

### Removed
<!-- Removed features go here -->

## [0.52.48] - 2026-02-05


### Added
- Claude Opus 4.6 model support

### Changed
- Update claude-agent-sdk to 0.2.32 and mcp-sdk to 1.26.0

### Fixed
- Prevent duplicate ELECTRON_LOG handler registration

### Removed
<!-- Removed features go here -->

## [0.52.45] - 2026-02-05


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Strip Bun binary signature before macOS codesign to fix notarization

### Removed
<!-- Removed features go here -->

## [0.52.44] - 2026-02-05


### Added
<!-- New features go here -->

### Changed
- Use bash explicitly for claude-helper build scripts on Windows

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.52.43] - 2026-02-05


### Added
- Standalone Claude helper binary setting (experimental) for improved performance

### Changed
- CI now pins Bun version to 1.1.43 for deterministic builds
- Claude helper binary build extended to support all platforms

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.52.42] - 2026-02-05


### Added
- Durable interactive prompts architecture for session persistence
- Database dashboard in database browser extension
- Support for reference images in image generation
- PostHog analytics tracking for auto-update system
- Startup delay for walkthrough triggers to improve UX

### Changed
- Git commit widget now renders from tool call data directly

### Fixed
- Header row pinning and column freezing disabled due to UX issues in spreadsheets

### Removed
- Unused git commit proposal atoms

## [0.52.41] - 2026-02-04


### Added
- Claude usage indicator with pace tracking for monitoring API costs
- CLI `--file` flag to open a specific file when launching a workspace
- Project move/rename feature with automatic data migration
- Worktree merge now allows uncommitted changes

### Changed
- Large text attachments now written to /tmp instead of sent inline
- Worktree rebases use file-level conflict detection
- Transcript search rewritten to use CSS Custom Highlight API
- GitHub MCP template updated to use official remote server

### Fixed
- Session cancellation now properly stops SDK and rejects pending interactions
- Attachment previews now center on screen instead of in scroll panel
- Archived sessions toggle race condition
- Session draft input displays correctly when creating sessions from rebase
- Cross-platform path handling for worktree names
- "Resolve with Agent" button now works for bad git state in worktrees
- Hide dock icon when spawning Claude Code subprocess on macOS
- Persist showUsageIndicator setting in AI settings
- Hide redundant CODE provider badge for claude-code sessions
- Register confirm-dialog with DialogProvider
- Only show context window walkthrough after /context runs
- Batch git log calls for performance

### Removed
<!-- Removed features go here -->

## [0.52.40] - 2026-02-04


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- ExitPlanMode now requires planFilePath parameter with cross-platform path support

### Removed
<!-- Removed features go here -->

## [0.52.39] - 2026-02-03


### Added
- OS notifications when AI sessions are blocked waiting for user input

### Changed
- Reduced verbose logging output

### Fixed
- Git commit widget only triggers on explicit "smart commit" requests

## [0.52.38] - 2026-02-03


### Added
- Model picker for image generation with Gemini 2.5 Flash and Gemini 3 Pro options

### Changed
- Default to group-by-directory view in Files Edited sidebar

### Fixed
- Prevent duplicate git commit widgets from showing as active
- Prevent HelpTooltip from appearing when returning to app window
- Hide prompt additions feature in packaged builds
- Show commit checkboxes for files in non-git directories
- Show uncommitted files link when session has edits
- Add run-name to CI workflow to distinguish from release runs

## [0.52.37] - 2026-02-03


### Changed
- Reduced verbose logging in CustomTrackerLoader and agentMode atoms

### Fixed
- Build rexical before runtime in CI workflow to fix build dependency order
- Include package-lock.json in version control

## [0.52.36] - 2026-02-03


### Changed
- Default file scope mode now shows all session edits instead of just the current session

### Fixed
- Built-in themes now included in CI packaged builds

## [0.52.35] - 2026-02-03


### Added
- HelpTooltip system for contextual UI help with hover tooltips
- Status indicator on workstream/worktree parent headers showing active sessions
- Plan status check integrated into prepare-commit command
- Claude 500 error detection with link to Anthropic status page
- Allow editing extension-registered file types in planning mode
- Persist file scope mode at workspace level
- Added status values, plan types, and best practices to plan mode prompt

### Changed
- Migrated crystal-dark theme to file-based theming system
- Extracted plan mode prompts to shared module for reuse
- Consolidated getAllFilesInDirectory into shared utility
- Code cleanup and DRY improvements for worktree support

### Fixed
- Cross-platform path compatibility in httpServer.ts
- Worktree path handling for mockups and document service
- Properly count and display files in untracked directories
- Scope 'all uncommitted files' to worktree when in worktree session
- Include worktreeId in sessionStoreAtom when adding sessions
- Path resolution now worktree-aware throughout the codebase
- Remove premature git staging from commit command
- Derive missing theme colors from base colors for custom themes
- Clear unread indicator when selecting child session in SessionHistory
- TypeScript type errors in electron package
- Document header updates when file is externally modified
- Prevent document header from losing content on field changes
- Prevent tracker panel empty state flash during loading
- Rename postcss.config.js to .mjs to eliminate module type warning
- Convert sessionArchivedAtom to derived atom, restore draft persistence
- Stack empty state links vertically in Files Edited sidebar
- Prevent session mode/model atoms from diverging during reloads
- Use user's default model when creating child sessions
- Respect sort order for sub-sessions in workstreams and worktrees
- Build all extensions in crystal-run.sh
- Terminal cursor position corruption when switching tabs
- Handle system/auto theme and Claude plugin-only extensions
- Persist Claude SDK session ID immediately on init

### Removed
- Removed unused agent-mode-toggle help content

## [0.52.33] - 2026-02-02


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->
- Expanded visual communication guidance in Claude Code prompt
- Refactored worktree file state to use centralized IPC listener architecture

### Fixed
<!-- Bug fixes go here -->
- Fixed crash when loading tool permission dialogs from database

### Removed
<!-- Removed features go here -->

## [0.52.32] - 2026-02-02


### Changed
- ExitPlanMode migrated to durable DB-backed prompts
- Interactive prompts (git commit proposals) now persist across app restarts

### Fixed
- Transcript no longer flashes when switching sessions
- Transcript auto-scroll now uses per-session state to prevent scroll position bleeding between sessions

## [0.52.31] - 2026-02-02


### Added
- "Copy Session ID" option to session context menu
- Redesigned Files Edited sidebar with clearer scope modes

### Changed
- Simplified session scope filter to binary choice (This Session / All Sessions)
- Centralized IPC listeners for file state and session list to prevent race conditions
- Reduced verbose logging in main process

### Fixed
- Session model atom now initialized on add to prevent flash of default value
- Restored data-session-id attributes to session components

## [0.52.30] - 2026-02-02


### Added
- Support for .mdc files as markdown

### Changed
- Updated @anthropic-ai/claude-agent-sdk to 0.2.29
- Mockup annotation prompt now uses capture_editor_screenshot

### Fixed
- Clear mockup annotation indicator when switching tabs
- Include mockup annotations in capture_editor_screenshot tool
- Theme variable for text selection indicator corrected
- Theme variable for mockup annotation indicator text corrected
- Mockup annotation data now properly passes through IPC serialization
- Tailwind theme classes corrected for dark mode compatibility
- ExtensionDevIndicator now updates reactively when setting changes
- Built-in themes included in production build extraResources
- Tracker bottom panel tab and icon behavior improved

## [0.52.29] - 2026-02-01


### Added
- Flash animation when focusing existing worktree terminal
- Smart commit detection for worktree rebase using git cherry
- Support for deleted and renamed files in uncommitted files list
- Inline rename for worktrees and sessions
- Git panel refresh on session completion and visibility
- E2E runner agent for containerized test execution

### Changed
- Session naming improved to put descriptive part first
- Claude Code system prompt unified for all session types

### Fixed
- Running session no longer steals tab focus in worktrees
- Linux terminal startup error resolved (bash args reorder)
- Checkboxes now shown for all uncommitted files in Files Edited sidebar
- Terminal scrollback corruption in Ghostty prevented
- Stale stash corruption in worktree rebase/merge operations prevented
- Rebase enabled for worktrees that are behind main even when merged
- System message additions stripped from prompt history recall
- Microphone entitlement removed to prevent unwanted permission prompts
- Test database cleared on each Playwright test launch
- Walkthroughs blocked when dialogs/overlays are visible
- Sessions auto-unarchive when new message is sent
- Copyright year updated to 2025-2026 in about page

## [0.52.27] - 2026-02-01


### Added
- PDF attachment support for Claude providers

### Fixed
- Auto-update YML files now generated correctly for Windows and Linux

## [0.52.26] - 2026-01-31


### Added
- AI session tabs and input now visible in FILES layout mode

### Changed
- Tracker panel shortcut changed to Cmd+T
- Extension command namespaces standardized with nimbalyst- prefix
- Tracker panel state migrated to Jotai atoms

### Fixed
- Empty screenshots no longer cause API errors
- MCP tools now use session-specific document state
- Document content read from disk for AI context
- Auto-switch to agent mode when /implement command is used
- Find-previous stack overflow in search

## [0.52.25] - 2026-01-31


### Added
- File context and text selection support in agent mode (including worktrees)

### Fixed
- MCP tools (like git commit proposal) now work correctly in worktree sessions
- Removed deprecated "no document open" warning from system prompt

## [0.52.24] - 2026-01-31


### Added
- Optional email field to feedback survey
- Diagnostic logging for theme and preload path debugging
- Renderer eval MCP tool for debugging
- Rebuild Extensions submenu to Extension Dev Mode
- Git commit mode walkthrough
- Fuzzy file search and content search shortcut to QuickOpen
- Walkthrough system improvements and new walkthroughs
- Layout controls walkthrough with markdown support

### Changed
- Unified document context handling across all AI providers
- Eliminated hardcoded colors in favor of theme variables
- Improved Prompt Additions widget for all AI providers
- Reduced context usage for Claude Code by truncating long documents

### Fixed
- Email format validation in feedback survey
- Onboarding dialog not showing for new users
- Todo panel error on truthyness
- Reverted bad user-select CSS changes

### Removed
<!-- Removed features go here -->

## [0.52.23] - 2026-01-31


### Added
- Terminal tab indicator showing when a command is running
- Session tabs now wrap to multiple rows when overflowing
- Text selection context included in AI chat messages
- Enhanced prompt additions widget with document context, attachments, and persistence
- Archive/unarchive functionality for individual sessions in worktrees

### Changed
- Moved document context from system prompt to user message for better context handling
- Simplified text selection to just the selected text string
- Optimized document content by omitting unchanged content between messages

### Fixed
- Suppressed error logs when user aborts Claude Code request
- Prevented terminal display corruption from interleaved writes
- Plan mode implementation now creates new session in worktree instead of workstream
- Fixed worktree session tabs showing 'Untitled' after restart
- Fixed new sessions in worktrees using 'New Session' instead of worktree name

### Removed
<!-- Removed features go here -->

## [0.52.22] - 2026-01-30


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Improved error handling for AskUserQuestion tool resolution in Claude Code sessions
- Added comprehensive analytics diagnostics with fail-open error handling for better reliability
- Fixed Intel Mac terminal support by enabling npmRebuild in Electron build configuration
- Fixed text selection styling using correct CSS layer utilities

### Removed
<!-- Removed features go here -->

## [0.52.21] - 2026-01-30


### Added
- "No uncommitted changes" message when session has committed all its files
- File scope filter and root checkbox to Files Edited sidebar
- Cmd+Alt+W keyboard shortcut to create new worktree
- Environment variables UI in Claude Code settings
- Helpful error dialog for Bedrock MCP tool incompatibility
- Analytics tracking for configured AI provider in claude_code_session_started event

### Fixed
- Text selection now enabled in AI session transcripts
- Dropdown positioning, keyboard shortcuts, and IPC type safety improvements
- New session dropdown menu no longer hidden behind search input
- Login popup formatting improved with line breaks

## [0.52.20] - 2026-01-30


### Changed
- Disabled text selection on UI chrome elements, opt-in for content areas

### Fixed
- Auto-updater now selects correct architecture on arm64 Macs
- Block message send while image attachments are still processing

## [0.52.19] - 2026-01-30


### Added
- Plan mode indicator displayed on user messages in transcript
- Shift+Tab keyboard shortcut to toggle plan mode in Claude Code
- `/clear` command now creates a new session in current context

### Changed
- Plan mode instructions moved from system prompt to user message for better visibility
- AskUserQuestion state persisted using Jotai atoms for improved state management

### Fixed
- AskUserQuestion state now persists across session navigation
- Object destroyed errors prevented when window refreshes during AI requests

## [0.52.18] - 2026-01-30


### Added
- Offscreen editor mounting system for MCP tools
- Session import dialog in Developer menu

### Changed
- GitCommitConfirmationWidget styling aligned with FileEditsSidebar

### Fixed
- FTS indexing now includes user prompts and assistant text for better search
- Session content search now works reliably with time/direction filters
- Optimized session list query to prevent redundant loading
- WebSocket "Sent before connected" error in announceDevice
- Improved performance by caching session files query and preventing extension double-load
- Extension 'main' field now optional for Claude plugin-only extensions

## [0.52.17] - 2026-01-29


### Added
- "Open in External Editor" context menu option with configurable editor path
- License attribution for third-party themes

### Changed
- Themes separated from extension system for faster loading
- Improved installed extensions panel layout and organization
- Built-in commands and mockup editor migrated to extension system

### Fixed
- PID-based database locking to prevent corruption when multiple instances attempt to open
- Slash command menu now responds to clicks and shows no duplicates
- Extension MCP tools now register correctly when workspace path is set
- Prevent extension initialization crash when aiTools is not an array
- Prevent infinite render loop in GitCommitConfirmationWidget
- Stop EISDIR errors when scanning .nimbalyst directories
- Smart commit prompt now correctly references developer_git_commit_proposal tool
- "Reveal in Finder" context menu now works correctly

### Removed
- Redundant database queries at startup

## [0.52.16] - 2026-01-29


### Added
- Terms of Service and Privacy Policy links in onboarding flow
- Single-session worktrees now display as flat items with worktree icon for better visibility
- Current PATH shown in Advanced Settings for debugging environment issues
- Terminal tab context menu with Clear option and list refresh listener
- Analytics tracking for worktrees, plan mode, and git commits
- Warning when archiving worktree with uncommitted changes

### Changed
- Review-branch command now supports flexible review scopes and parallel sub-agent processing
- Archive worktree dialog logic extracted into reusable hook

### Fixed
- Alpha features toggle crash and auto-enable for upgrading users
- Database init failure now shows recovery options instead of crashing
- Terminal cleanup improved to prevent stale closures during auto-restart
- Terminals associated with archived worktrees are now properly deleted
- Terminal scrollback restoration and error handling improved
- Worktree deletion now ensures disk cleanup before marking as archived
- Sessions losing messages (speculative fix)
- Terminal crash from corrupted scrollback with invalid code points

## [0.52.14] - 2026-01-28


### Added
- Display worktree name in terminal tabs for better identification
- YAML frontmatter instructions in plan mode prompt for structured plan metadata
- ExitPlanMode now supports options: new session, approve, or continue with feedback

### Changed
- Plan mode agent now chooses plan name with validation on exit
- Plan implementation uses natural prompt instead of /implement command
- AskUserQuestion widget now uses 90% width for better display
- Plan mode workflow now works more like the CLI

### Fixed
- Plan file link now opens correctly in workstream editor tabs
- Developer mode selection from onboarding now properly updates Jotai atom

### Removed
- /plan slash command removed from Nimbalyst (plan mode is now internal)

## [0.52.13] - 2026-01-28


### Added
- Collapsible "Other Uncommitted Files" section in git commit panel with persisted state

### Fixed
- Session list refresh handling and increased slow query threshold
- Timezone handling in AI Usage Report graph
- Dialog overlay issues by extracting DialogProvider
- "Open in Files Mode" context menu now correctly switches to Files mode

## [0.52.12] - 2026-01-28


### Added
- `/update-libs` command to update Anthropic Agent SDK and MCP library to latest versions

### Fixed
- Git operations (commit, status, diff) now work correctly in worktree sessions
- Module import issue with store module in build

## [0.52.11] - 2026-01-28


### Added
- Folder @ mentions in AI chat input with delimiter-separated fuzzy matching
- Project-focused File menu items replacing generic Open Folder and Recent Files

### Changed
- Cmd+E and Cmd+K now toggle left panel when already in that mode
- Files-edited sidebar title now reflects session type (Workstream vs Worktree)
- Image generation feature gated behind alpha flag

### Fixed
- Auto-updater spinner no longer gets stuck after clicking "Remind me later"
- Git commit panel sync issues when staging/unstaging files
- Git commit proposal now properly rejects when no files to commit
- Diff highlighting broken after theme changes

## [0.52.10] - 2026-01-27


### Added
- Custom PATH configuration in Advanced Settings for managing shell environment variables

### Changed
- Unified git operations UI for both regular and worktree sessions
- Made PATH detection async to avoid blocking startup
- Gated card view mode behind alpha feature flag
- Made "Enable All Alpha Features" a stored state with migration for existing users

### Fixed
- Improved PATH detection for homebrew and nvm installations
- Treat missing lastKnownVersion as upgrade from <=0.52.10

## [0.52.9] - 2026-01-27


### Added
- Unified cross-mode navigation history for seamless back/forward navigation across files
- Enhanced keyboard shortcuts dialog with tabs and improved formatting
- Unified onboarding flow with developer mode selection
- Developer feature flags for worktrees and terminal

### Changed
- Remove developer section from keyboard shortcuts dialog

### Fixed
- Users with old databases can now start the app without errors
- Make all onboarding fields optional except mode selection
- Use standard --nim-* CSS variables in onboarding screens
- Prevent race condition in navigation history restore
- Make Cmd+Shift+A toggle AI chat panel correctly
- Handle missing history array in navigation state restore
- Restore list bullet and number visibility broken by Tailwind Preflight reset
- Resolve remaining typecheck errors in session files, agent mode, and todo panel
- Fix show archived sessions

## [0.52.7] - 2026-01-26


### Added
- Collapsible todo panel in agent mode sidebar for tracking task progress
- Collapsible left panel toggle for Files and Agent modes
- Terminal integration with theme system for consistent styling

### Fixed
- Fallback to dark theme when configured theme ID is not found
- Correct timezone handling for TIMESTAMPTZ session timestamps
- Keep smart mode when AI proposes commit, show proposal UI inline
- Restore processing state on renderer refresh
- Handle WASM memory errors when restoring terminal scrollback

## [0.52.6] - 2026-01-26


### Added
- Restore session unread state with database persistence
- Developer option to show prompt additions
- Confirmation dialog when archiving worktrees
- Persist user-resized column widths in CSV spreadsheet
- Checkbox file selection in FilesEditedSidebar for Manual/Worktree commit modes
- Slow query diagnostics to PGLite database layer
- Dialog for untracked files conflict during worktree rebase

### Changed
- Replace xterm.js with ghostty-web for terminal emulation
- Improve archive button labels in session history

### Fixed
- Restore visibility of ChatSidebar New button
- Clicking on a session under a worktree/workstream now behaves consistently
- Prevent text wrapping in session history new menu
- Scope git commit proposals to workstream instead of workspace
- Improve checkbox selection and auto-clear committed files in GitOperationsPanel
- Apply theme colors to file tree resize handle
- Reduce vertical padding in AI input panel
- Populate GitOperationsPanel commit message from MCP git_commit_proposal
- Ensure state persistence handles missing fields from old data
- Correct disabled state styling for Generate button in image-generation
- Use correct theme variables and Tailwind classes in image-generation lightbox
- Image generation lightbox uses correct theme colors and closes on Escape
- Optimize smart commit prompt to reduce unnecessary analysis
- Show ModelSelector for sessions without model and process mobile prompts
- Strip whitespace padding from terminal scrollback restoration
- Process queued prompts when user cancels AskUserQuestion
- Aggregate session status for worktrees/workstreams in card view
- Archived sessions disappear immediately from agent sessions panel
- Correct text color classes in dark mode

### Refactored
- Complete Tailwind migration across all packages

## [0.52.5] - 2026-01-25


### Added
- Show AI errors in transcript instead of silent failures
- Add refresh button to worktree tab in git operations panel
- Enable auto-restart for dev server via loop mode
- Add context menu support to session history card view
- Enable worktree rebase with uncommitted changes via auto-stashing
- Migrate to Tailwind CSS with unified theming system

### Changed
- Session names now reflect user's request, not agent's solution
- ChatSidebar now uses user's default model for new sessions
- Model switching, persistence, and defaults improved for AI sessions

### Fixed
- Remove redundant type comparison in extractModelForProvider
- Correct CSS typo in SessionHistory.css
- Restore card view toggle and styling for session history
- Correct Tailwind CSS for worktree view and restore card view toggle
- Display (1M) suffix for extended context Claude Code models
- Use ModelIdentifier as single source of truth for default models
- Resolve TypeScript strict mode errors across codebase

### Refactored
- Migrate extensions to unified --nim-* CSS variables
- Migrate components from inline styles to Tailwind CSS
- Remove unused CSS import from ChatSidebar

## [0.52.4] - 2026-01-25


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Fixed AI provider field not syncing when model ID contains provider prefix

### Removed
- Removed deprecated DiffMode and WorktreeMode components

## [0.52.3] - 2026-01-25


### Added
- Right-click context menu for workstreams
- Allow adding new sessions to existing worktrees

### Removed
- Alternative Claude Code provider (alpha feature reverted)

## [0.52.2] - 2026-01-24


### Added
- Card view display mode for session history
- Real-time worktree display name sync across UI
- Dynamic alpha feature registry system
- Alternative Claude Code provider support (alpha)
- Worktree terminal button and improved terminal switching

### Fixed
- Pasted text starting with '#' no longer incorrectly activates memory mode
- Alpha feature settings now persist across sessions
- New Worktree button now enabled in agent mode for git repos
- Enter key no longer sends message during IME composition

## [0.52.1] - 2026-01-23


### Added
- Update session uncommitted badges on git commit

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Prevent state bleeding between concurrent AI sessions
- Skip unnecessary database lookups for non-worktree paths

### Removed
<!-- Removed features go here -->

## [0.52.0] - 2026-01-23


### Added
- Terminal bottom panel with dedicated storage for terminal sessions
- Full commit details display in git commit widget (expanded commit info)
- Auto-reconnect sync when network becomes available
- Auto-approve pending reviews on git commit
- Show uncommitted files count on workstream session items
- Inline session renaming with improved session state management
- Track Bash command file edits in session files and local history
- File status colors in git commit widget
- Prompt history quick-open dialog
- Comprehensive log access tools for AI agents
- Interactive git commit proposals with directory tree file picker
- Session status indicators to quick open dialog
- AI sessions now organize into workstreams for multi-file work
- Image generation extension with Google Imagen API
- Agent mode sessions now manage their own document context
- Agent mode sessions now have embedded editor tabs
- Custom editors can register menu items in header bar

### Changed
- Git status now uses event-driven updates instead of polling
- Simplified normalizeWorkspaceState with deepMerge pattern
- Improved session list icon system and alignment
- Files Edited sidebar now shows only edited files
- Deprecated React state-based AI session components removed
- Extension get_logs disabled in favor of file-based log tools
- Performance monitoring interval increased from 5 seconds to 10 seconds
- Reduced verbose dev console logging

### Fixed
- Persist workstream selection and child sessions across reload
- Chat button now opens sessions in Files mode instead of Agent mode
- TypeScript configuration excludes collabv3 and electron/release from root
- Restore prompt history navigation with up/down arrows
- Voice commands now execute when AI is idle
- Workstream headers now highlight when child session is active
- Slash command typeahead no longer shows duplicate menus
- Keyboard shortcuts now route to focused component in agent mode
- Session timestamps now display correctly in workstream list
- Queued prompts now auto-execute when AI finishes responding
- Workstream child sessions show timestamps and affect sort order
- Render single typeahead menu element to prevent duplicates
- Workstream session selection and new session content bugs
- Workstream child sessions appear and update immediately
- Inherit session name when converting to workstream
- Unify session state into single registry to fix sync bugs
- Route git commit requests to active session instead of workstream
- Prevent duplicate typeahead menu rendering during position calculation
- TypeScript compilation errors resolved
- Route CMD+F to focused component in agent workstream panel
- Wire up compact button to send /compact command
- Prevent AgentWorkstreamPanel rerenders on message updates
- Prevent ChatSidebar from creating duplicate sessions on mount
- Correct indentation for files inside folders in git commit widget
- Parse array-format tool results in git commit widget
- Restore AI session processing indicators and optimize transcript rendering
- Persist MCP tool calls so git commit widget shows correct state after HMR
- Git commit widget correctly shows success/cancelled state after HMR
- Remove stale session processing state initialization
- Sessions no longer incorrectly show as running after errors
- Files Edited sidebar now shows Keep All for pending changes
- Shrink agent session header and improve dark mode icon visibility
- iPad split view session list no longer overlaps status bar

### Removed
<!-- Removed features go here -->

## [0.51.24] - 2026-01-22


### Added
- Custom Bash tool widget for terminal-style display
- MCP tool search for Claude Code sessions
- Visual feedback for attachment processing
- Timing instrumentation to diagnose Windows hang issues
- PowerShell script for Windows development (crystal-run.ps1)

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Infinite render loop and UI freeze in DiffMode on Windows
- Windows backslashes in Files sidebar filename display
- Path module usage for cross-platform workspace detection
- Worktree session button disabled in non-git workspaces
- MCP config migration incorrectly restoring deleted servers
- TypeScript errors in CI checks

### Removed
<!-- Removed features go here -->

## [0.51.23] - 2026-01-21


### Added
- Send-time image compression for Claude API 5MB limit
- Proprietary license file
- Blockmap files included in public releases

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Shell detection and error handling in TerminalSessionManager
- Packaged app crashes when processing HEIC images
- ModelSelector dropdown closing when clicking help tooltips
- /context parsing for Claude Agent SDK 0.2.x
- TypeScript errors in ImageCompressor

### Removed
<!-- Removed features go here -->

## [0.51.22] - 2026-01-21


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- macOS build signing now uses correct target architecture for ripgrep
- macOS CI builds now properly import certificates on both Apple Silicon and Intel runners
- macOS artifacts maintain backwards compatibility with arm64 naming convention

### Removed
<!-- Removed features go here -->

## [0.51.21] - 2026-01-21


### Added
<!-- New features go here -->

### Changed
- macOS artifacts now use user-friendly architecture names (Apple Silicon, Intel)
- Updated Claude Agent SDK to 0.2.14

### Fixed
- ClaudeCodeProvider now properly cleans up resources on destroy
- Home directory resolution now uses os.homedir() for reliability
- Chat image attachments now automatically compressed for better performance

### Removed
<!-- Removed features go here -->

## [0.51.20] - 2026-01-21


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Claude Code login flow now uses interactive /login instead of setup-token
- Linux node-pty packaging fixed by moving to extraResources
- Session creation error handling and provider validation improved

### Removed
<!-- Removed features go here -->

## [0.51.19] - 2026-01-20


### Added
- Session branching for AI conversations
- Worktree rename functionality to agentic coding UI
- HTTP headers support and workspace MCP server detection
- HTTP header support for MCP server configuration
- Commands to open files and workspaces in new windows
- Mobile voice mode with synced settings from desktop
- Mobile voice mode UI and capture services
- Mobile voice mode receives OpenAI API key from desktop
- Smarter notification suppression for both desktop and mobile

### Changed
- MCP config migration and file watching
- Bundled mcp-remote as dependency instead of downloading via npx
- Agent mode state now uses Jotai atoms instead of prop drilling
- Window mode and settings navigation state moved to Jotai atoms
- Settings panels now self-contained with Jotai atoms
- Tab editor content state refactored to avoid redundancy

### Fixed
- Provider fallback logic in session creation
- LM Studio configuration storage and error handling
- Session naming tool can only be called once
- MCP server OAuth detection for HTTP servers with API key auth
- New worktrees now default to the last used model
- Workspace MCP server deletion by syncing both config locations
- MCP config file watcher robustness and error handling
- MCP analytics event naming and tracking
- OAuth status warning icons to MCP server list
- Visual indicator for project-specific MCP servers in global settings
- Agent now sees why tool calls are denied in planning mode
- Skip sync when server connection fails instead of full resync
- OOM crashes during session sync with large histories prevented
- Mobile session list now updates turn counts in real-time
- Mobile push notifications now show session name as title
- Mobile session creation works after app sits idle
- Microphone permission only prompts when enabling voice mode

### Removed
<!-- Removed features go here -->

## [0.51.10] - 2026-01-16


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Windows Claude auth now uses 'login' command instead of deprecated 'setup-token'

### Removed
<!-- Removed features go here -->

## [0.51.9] - 2026-01-16


### Added
- SQLite extension as custom editor with query history and AI tools
- Export markdown documents as PDF
- Extension panels system with SQLite browser demo
- Voice commands show countdown before submitting to agent
- Voice mode live transcription streaming and token usage tracking
- AI-generated project summary for voice mode context
- AI chat panel receives context from extension panels
- Manual pairing for devices that can't scan QR codes
- Error bar support to visual display widget
- Mobile push notifications for agent completion
- Clearer mobile sync setup with encryption explanation
- Faster AI session search with GIN index
- Comprehensive Node.js version manager support for PATH detection (nvm, fnm, asdf, volta, n, nodenv, mise)
- Enhanced font smoothing for Monaco code editor

### Changed
- Updated Claude Agent SDK to 0.2.7 for MCP tool search
- Diff tree grouping setting persists per project

### Fixed
- Packaged builds no longer crash with 'process is not defined'
- Prevent database corruption when restarting from Extension Dev panel
- Voice agent now passes user requests verbatim to coding agent
- Fullscreen shortcut no longer conflicts with Find on Windows
- Voice commands no longer create duplicate queued prompts
- iOS simulator builds without Rosetta on Apple Silicon
- Normalized file tree row heights and simplified indentation
- Reduced excessive indentation in grouped file-edits sidebar
- iPad AI input safe area

### Removed
<!-- Removed features go here -->

## [0.51.5] - 2026-01-14


### Added
- Pre-flight conflict detection for worktree rebases
- Claude Code Sonnet 1M context variant support

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.51.4] - 2026-01-14


### Added
- Archive worktree dialog after successful merge
- Automatic terminal process cleanup when archiving worktrees
- Worktree merge workflow now offers archive option
- Pinned sessions appear at top of session list
- Worktree system prompt instructions to keep agent in worktree context

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- `/context` command now works correctly in worktrees
- Terminal no longer gets cut off at the bottom
- Merge conflict detection and resolution with Claude Agent for worktrees

### Removed
<!-- Removed features go here -->

## [0.51.3] - 2026-01-14


### Added
- Commit squashing feature to git worktree DiffMode
- Auto-stash functionality for merge operations
- Fast-forward merges for git worktrees
- Improved collapsed right panel UI in worktree mode

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- TypeScript compilation errors

### Removed
<!-- Removed features go here -->

## [0.51.2] - 2026-01-13


### Added
- Maximize button to worktree files mode

### Changed
- Folder nesting in diff screen now more IntelliJ-like
- Strengthen wording around session naming tool call to ensure it's called before ending turn

### Fixed
- Terminal spawn failing in packaged app (posix_spawnp failed)
- Session history now uses worktree creation time for 'created' sort

### Removed
<!-- Removed features go here -->

## [0.51.1] - 2026-01-13


### Added
- Git worktree integration for isolated AI coding sessions (alpha)
- Worktree archiving with background cleanup queue
- Multiple sessions per worktree support
- Terminal session support for git worktrees
- Session and worktree pinning in agent view
- File mode layout for worktree sessions
- Git rebase support for worktree branches
- Worktree permission inheritance
- Inline rename for sessions and terminals
- Claude Code plugin marketplace GUI (alpha)
- Walkthrough guide system for feature discovery
- Voice mode settings UI with reactive state management
- Voice agent tools and system prompt customization
- PostHog analytics for voice mode, mobile app, and AI message queuing
- Diff tree grouping preference persists per project
- Directory grouping in file edits panels
- Error detection and analytics for database initialization failures

### Changed
- Worktree mode changed from per-session to per-worktree
- Worktree comparisons now relative to repo root branch
- Expanded worktree name pool to 16,384 combinations
- Softer database recovery dialog messaging
- MCP server manual add option moved to top of templates
- Removed broken GitLab and Slack MCP servers

### Fixed
- Prevent crash when archive API unavailable during hot reload
- Voice transcription display now visible and no longer duplicates text
- Diff viewer text no longer overlaps on long lines
- Mobile back button now returns to session list instead of projects
- Prevent incorrect "behind base" indicator after worktree merge
- Use stored base branch for worktree git comparisons
- Restore terminal working directory in worktree sessions
- Resizable chat panel in file view
- Improved worktree file opening robustness and error handling

### Removed
<!-- Removed features go here -->

## [0.51.0] - 2026-01-12


### Added
<!-- New features go here -->

### Changed
- Updated extension release channel restrictions

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.50.31] - 2026-01-12


### Added
- Clicking breadcrumb folders navigates to them in file tree

### Changed
- Pre-bundle Lexical and other deps to reduce Vite reloads during development

### Fixed
- DataModelLM files no longer show dirty state immediately on open
- Markdown files no longer show dirty state immediately on open
- Agent transcript diffs now show full context lines
- Editors now correctly save dirty content on tab close and window close

### Removed
<!-- Removed features go here -->

## [0.50.30] - 2026-01-12


### Added
- Load Claude CLI plugins into Agent SDK provider for extended functionality

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.50.29] - 2026-01-11


### Added
- PostHog analytics for voice mode usage

### Changed
- Disabled Excalidraw relayout tool due to poor layout performance

### Fixed
- Mockup editor now shows updated content after accepting diff
- CSV deleted rows now properly disappear after accepting diff
- Resolved TypeScript errors in voice mode and MaterialSymbol

### Removed
<!-- Removed features go here -->

## [0.50.28] - 2026-01-11


### Added
- Voice control for coding agent via OpenAI Realtime API
- Mobile now shows AI session context usage
- Excalidraw diagrams create faster with batch tools

### Changed
- Lazy-initialize electron-store for custom user-data-dir support

### Fixed
- Excalidraw dark mode flash on load
- Suppress Claude Agent SDK stream error dialog on session abort
- Eliminate dynamic import to prevent electron-log duplication
- Prevent duplicate IPC handler crashes on startup
- Session back button returns to correct project on mobile
- Question prompts remain accessible on mobile
- Mobile session creation now uses correct project

### Removed
<!-- Removed features go here -->

## [0.50.27] - 2026-01-10


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- CSV files no longer save trailing empty columns
- AI session lookups work across multiple windows
- Built-in extensions now load in E2E tests

### Removed
<!-- Removed features go here -->

## [0.50.26] - 2026-01-09


### Changed
- Image and chart display MCP tool moved from alpha to general availability
- Consolidated visual display functionality into unified display_to_user tool

### Fixed
- Improved error handling and validation messages for display_to_user tool
- Resolved path shadowing in display_to_user MCP tool
- Fixed validateDOMNesting warning by replacing nested button with span in VisualDisplayWidget
- Improved single image display in VisualDisplayWidget

## [0.50.25] - 2026-01-09


### Added
<!-- New features go here -->

### Changed
- Fixed all high and moderate npm audit vulnerabilities

### Fixed
- Packaged build works with Vite code splitting
- Session naming tool uses correct MCP server prefix
- Playwright tests work with dev server, screenshot tool finds correct editor
- CSV select-all now selects only data columns, range delete works
- CSV spreadsheet extension passes CI typecheck

### Removed
<!-- Removed features go here -->

## [0.50.24] - 2026-01-09


### Added
- Unified header bar for all editor types with breadcrumb navigation
- Document type management for markdown files with submenu options
- Mobile app now has dedicated project selection screen
- Database Browser now handles large datasets smoothly
- Claude can now detect when running against packaged build
- Docker dev container support for E2E testing

### Changed
- Upgraded claude-agent-sdk to 0.2.2

### Fixed
- Excalidraw no longer saves on tab switch
- Typing in AI input no longer causes lag from SessionHistory re-renders
- DatamodelLM extension passes CI typecheck
- Toggle Debug Tree menu item now works in header bar
- Context usage display now shows correct /context data
- Set Document Type submenu now visible in header bar menu
- File tree auto-scroll now works when switching tabs
- Consecutive AI edits now correctly update diff mode
- Incorrect clickable links in agent transcript tool arguments
- npm run dev -- user-data-dir=<dir> now works correctly

### Removed
<!-- Removed features go here -->

## [0.50.23] - 2026-01-08


### Added
- Excalidraw extension for AI-driven diagram editing with colors and viewport persistence
- CSV spreadsheet cell-level diff highlighting for AI edits
- CSV spreadsheet Cmd+A select-all and auto-expand on paste
- CSV spreadsheet Tab key navigation while editing
- Excalidraw layout tools and improved arrow binding
- Feedback survey dark mode support

### Changed
- Improved state management with Jotai to eliminate unnecessary re-renders

### Fixed
- Auto-updater no longer flickers when starting download
- Diff approval bar now appears for markdown, Monaco, and mockup files
- Cmd+Y no longer opens document history when in agent mode
- Claude Code now sees file-scoped extension tools
- Sync connections no longer fail silently when limit reached
- AI Usage Report graph now shows Claude Code token usage
- CSV spreadsheet row operations now persist across re-renders
- Agent now uses correct screenshot tool for all editors
- CSV spreadsheet now preserves empty rows in the middle of data
- CSV spreadsheet no longer adds metadata comment to plain CSV files
- CSV spreadsheet Delete key now clears selected range
- Session cancel now requires sessionId, preventing silent failures
- TypeScript compiles cleanly with zero errors

### Removed
<!-- Removed features go here -->

## [0.50.22] - 2026-01-08


### Added
- Added clickable file paths to agent transcript UI
- Added display_chart MCP tool for inline chart visualization

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Fixed OAuth EADDRINUSE error with stale lock file cleanup

### Removed
<!-- Removed features go here -->

## [0.50.21] - 2026-01-07


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- MCP server environment variable expansion now works correctly
- MCP server argument quoting fixed on Windows

### Removed
- Removed unofficial MCP servers from templates
- Updated deprecated MCP server configurations

## [0.50.20] - 2026-01-07


### Added
<!-- New features go here -->

### Changed
- Improved MCP OAuth error messages for missing commands

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.50.19] - 2026-01-07


### Added
<!-- New features go here -->

### Changed
- Replaced node-pty fork with official package for Windows compatibility

### Fixed
- MCP server command resolution on Windows
- MCP server installation on Windows and improved cross-platform PATH resolution
- Document scanner now continues scanning tracker files beyond limit
- Tracker metadata refresh for agent-edited files

### Removed
<!-- Removed features go here -->

## [0.50.18] - 2026-01-06


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- File tree truncation causing folders to disappear

### Removed
<!-- Removed features go here -->

## [0.50.16] - 2026-01-05


### Added
- PostHog analytics tracking for permissions system interactions

### Changed
- Developer tools now include all one-time modals for testing

### Fixed
- Permissions modal UX improvements to prevent race conditions
- Users can no longer click outside permissions modal to dismiss it
- Permissions modal messaging made less intimidating

## [0.50.15] - 2026-01-05

### Fixed
- AI diffs now show only new changes after approving with Keep All

## [0.50.14] - 2026-01-05


### Added
- Context menu to convert text attachments back to prompt text

### Changed
- Diff colors now use CSS variables for dark mode support

### Fixed
- Mermaid diagram changes now show in diff mode
- Extension manifest/output mismatches caught at build time
- iOS-dev extension builds without tsconfig warning
- Table action menu now positions correctly when document is scrolled
- PDF viewer now loads in packaged builds

### Removed
<!-- Removed features go here -->

## [0.50.13] - 2026-01-05


### Added
- PDF extension build support for crystal-run

### Changed
- More efficient Nimbalyst build in worktrees

### Fixed
- PDF viewer now outputs ES module with .mjs extension

### Removed
<!-- Removed features go here -->

## [0.50.12] - 2026-01-04


### Added
<!-- New features go here -->

### Changed
- Extension SDK now exports complete EditorHost types

### Fixed
- Cmd+F in files mode now opens editor find instead of transcript find
- AI chat in files mode now knows which document is open
- Theme changes now apply to all open editors
- Locally queued AI prompts now execute instead of sitting idle
- Duplicate prompt queue submissions no longer possible
- Removed outdated authentication error string matching logic

### Removed
<!-- Removed features go here -->

## [0.50.11] - 2026-01-03


### Added
<!-- New features go here -->

### Changed
- Simplified diff header UI

### Fixed
- CSV and other custom editors no longer re-render on autosave
- Diff mode table widths now display correctly in Lexical editor
- CSV spreadsheet delete now correctly clears cells
- AI session search now works correctly
- Session state changes no longer trigger unnecessary App re-renders
- CSV spreadsheet now saves edits when tab is closed
- File tree updates and dirty state no longer trigger editor re-renders
- Custom editors now interactive on session restore
- PDF and DataModelLM extension styles now load correctly after Vite 7 upgrade

### Removed
<!-- Removed features go here -->

## [0.50.10] - 2026-01-03


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Fixed OpenAI model import mismatch causing connection errors

### Removed
<!-- Removed features go here -->

## [0.50.9] - 2026-01-02


### Added
- Inline session rename functionality
- PostHog tracking for terminal usage
- PostHog tracking for MCP configuration

### Changed
- Improved MCP logo appearance in light/dark modes
- Moved 'test' button outside hidden section in MCP templates

### Fixed
- Connection tested state not resetting
- AWS logo in MCP templates
- Many MCP server configuration issues
- PATH handling for MCP servers
- Playwright MCP configuration
- Doubled up login widgets display issue
- Claude Code login button not showing

### Removed
<!-- Removed features go here -->

## [0.50.8] - 2026-01-02


### Added
<!-- New features go here -->

### Changed
- Added guidance for users to start a new session when using chat models

### Fixed
- Fixed broken build in PDF viewer package
- Added module description to PDF viewer package for better clarity

### Removed
<!-- Removed features go here -->

## [0.50.7] - 2026-01-02


### Added
- 17 new MCP server templates with brand icons
- Brand icons for MCP server templates replacing text fallbacks

### Changed
- Terminal history initialization refactored to use shell bootstrap files
- Terminal initialization commands now filtered from output
- Terminal sessions now respect light/dark theme

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.50.6] - 2026-01-02


### Added
- PostHog MCP server slash command for analytics queries
- OAuth authorization support for MCP remote servers
- On/off toggle for MCP servers
- Template selection flow for MCP server configuration
- PostHog template with improved connection testing
- Terminal session support in agent mode (Alpha)
- Terminal scrollback and command history persistence

### Changed
- Redesigned MCP servers configuration UI with template selection flow
- Document changes in PostHog events list

### Fixed
- Mockup screen no longer goes white on accept for new files
- Mockup diff slider hidden on new files
- API keys no longer logged in console

### Removed
<!-- Removed features go here -->

## [0.50.5] - 2026-01-01


### Added
<!-- New features go here -->

### Changed
- Split CLAUDE.md into per-package documentation

### Fixed
- Editor screenshots now work for CSV and custom extension editors
- CSV spreadsheet styles now load correctly after Vite 7 upgrade
- Screenshot tools return proper errors instead of crashing sessions
- Enter key now sends messages containing @ or / characters
- Diff header buttons now visible in narrow panels

### Removed
<!-- Removed features go here -->

## [0.50.3] - 2025-12-31

### Added
- Mobile can cancel running sessions and answer questions via sync
- Mobile AskUserQuestion prompts can now be cancelled
- Extension dev menu shows process uptime
- CSV cells save on click-away like Google Sheets
- Extension errors now visible with detailed diagnostics
- iOS development tools extension

### Fixed
- Encrypt project_id in mobile sync for privacy
- Markdown view mode switch no longer crashes on diff header
- CSV spreadsheet keyboard focus preserved after cell edits
- Mobile sync commands now fail if encryption unavailable
- CSV requires alpha release channel
- Extension AI tools now return useful data instead of failing
- PDF viewer no longer freezes in infinite loading loop
- Opening already-open project focuses existing window instead of creating duplicate
- Validate todos is an array before calling .filter()
- Permissions on internal build

## [0.50.2] - 2025-12-29


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Build extension-sdk before extensions in CI

### Removed
<!-- Removed features go here -->

## [0.50.1] - 2025-12-29


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Extensions now include dist folders in packaged builds

### Removed
<!-- Removed features go here -->

## [0.50.0] - 2025-12-29


### Added
- Monaco diff header now shows change count and navigation arrows
- AI edits show pending review status with session links in file gutter
- Mobile session list now supports pull-to-refresh
- Mobile users can now choose project when creating new session
- Database Browser now runs queries on Cmd+Enter
- AI agents can now query PGLite database via MCP tool

### Changed
- Unified diff approval header across Monaco and Lexical editors

### Fixed
- Queued and mobile-synced messages now appear in transcript
- Extensions now load correctly on Windows
- Sync status icon now shows for newly authenticated users
- Newly created files now show diff mode for AI edits
- Extension SDK Documentation help link only visible to alpha users
- Ctrl+W on Windows now closes tabs instead of the whole window
- Sessions from other workspaces no longer appear in wrong project
- Mobile session list no longer allows horizontal panning
- Mobile keyboard no longer creates large gap below input
- File tree no longer auto-scrolls while browsing folders
- Mobile layout now respects iOS safe area properly
- CSV spreadsheet no longer freezes when dialogs exist elsewhere

## [0.49.14] - 2025-12-27


### Added
- Support wildcard domain patterns and "Allow All Domains" button

### Fixed
- Provider icons now visible in dark mode session picker

## [0.49.13] - 2025-12-27


### Added
- Text attachments now clickable to preview content

### Changed
- Increase AI session message limit from 2000 to 5000

### Fixed
- Queued messages now appear in chat transcript
- MockupViewer now uses EditorHost API for content management
- MonacoCodeEditor fails diff view for source mode
- Custom editors now properly save on close and support source mode
- Thinking dots touch side of panel
- File tree now shows all folders in workspaces with large dependency dirs
- DatamodelLM editor no longer reloads on every user edit
- Extension reload validation now correctly detects components export

## [0.49.12] - 2025-12-26


### Added
- Context limit errors now show helpful widget with compact button
- E2E tests for agent tool permission system

### Changed
- Use Claude Code native settings for tool permissions

### Fixed
- Quoted strings and heredocs no longer trigger compound command detection
- Compound bash commands now require approval for each part
- Trust toast now shows current permission mode when changing settings
- Long Bash commands in permission dialog now scroll vertically
- Bypass-all mode now skips compound command permission checks
- Custom editor file changes no longer clobber user edits
- Permission prompts no longer repeat and show specific patterns
- Agentic panel now scrolls to show sent messages
- Windows forced shutdowns no longer leave database locks

## [0.49.11] - 2025-12-23


### Added
- Beta badge to Smart Permissions option in trust toast

### Changed
- Simplify permission trust model and add Allow All WebFetches option

### Fixed
- Update button label from "Trust Project" to "Save"

## [0.49.10] - 2025-12-23


### Added
- Show dotfiles in file tree when "All Files" filter is selected

### Fixed
- Quick Open now finds all files including dotfiles and images
- Session history spinner now animates during processing
- WebSearch and WebFetch permission "Allow Always" now persists correctly

## [0.49.9] - 2025-12-23


### Changed
- Redesign project trust dialog with clearer permission choices

## [0.49.8] - 2025-12-23


### Added
- CSV spreadsheet supports clicking row/column headers to select entire rows/columns
- MCP tools for AI agents to debug extensions

### Fixed
- CSV row header selection now correctly handles header rows
- AI edits no longer trigger false autosaves in diff mode
- CSV spreadsheet no longer types characters when Cmd+key is pressed
- /compact command no longer shows false "no output" error
- CSV spreadsheet cell editing now uses dark background in dark mode
- OS notifications now show agent's final summary instead of first message
- Allow All mode now bypasses URL permission prompts
- CSV spreadsheet dark mode cell borders now visible and selection highlights correctly
- CSV spreadsheet sorting now excludes empty rows and works from column headers
- Workspaces now restore correctly after dev mode restart

## [0.49.7] - 2025-12-22


### Added
- Extension dev mode indicator with restart button
- New session button tooltip now shows Cmd+N shortcut
- QuickOpen now searches all text file types

### Changed
- Remove obsolete permission mode setting from global settings

### Fixed
- URL permissions now persist correctly across AI sessions
- Cmd+N now reliably triggers correct action based on current mode

## [0.49.6] - 2025-12-22


### Added
- Archive toast now shows session name
- Context menu "New File..." now opens full file dialog
- Add /restart command for quick app restart during development

### Changed
- Remove internal clipboard, use system clipboard only

### Fixed
- CSV editor no longer steals keyboard input from dialogs
- Queued messages now send reliably with 5-second fallback
- Auto /context command no longer runs after agent errors
- Typeahead menus no longer auto-select item under cursor on open
- Parallel tool permissions now queue instead of overwriting
- Dismissing trust toast no longer revokes workspace trust
- New File menu item now works when triggered from Agent mode

## [0.49.5] - 2025-12-22


### Changed
- Temporarily disable Windows code signing

## [0.49.4] - 2025-12-22


### Added
- Undo/redo support for CSV spreadsheet editor

### Fixed
- Tabs now reliably reopen when using Cmd+Shift+T
- Resolve DigiCert code signing action reference

## [0.49.3] - 2025-12-22


### Added
- Edit button for queued messages
- Enhanced New File dialog with file type selection and folder picker
- Folder context menu now shows all file type options inline
- Text selection context automatically included in AI prompts

### Changed
- Clarified agent vs chat terminology in UI
- Use DigiCert signing manager to sign Windows builds

### Fixed
- Settings panel content now scrolls properly
- Queued prompts now properly fail instead of silently completing
- Restart tool now preserves session state and works reliably in dev

### Removed
- Removed unused mockupEnabled feature flag

## [0.49.2] - 2025-12-21


### Added
- Agent tool permission system with workspace trust levels
- Add restart_nimbalyst tool to extension dev MCP server
- CSV spreadsheet right-click context menu
- Open file button on edit tool result cards in agent transcript
- Search button in agent mode header for session quick search

### Changed
- Use es-module-shims for extension loading

### Fixed
- Database backups no longer overwrite good data with corrupted/empty backups
- URL patterns and directory permissions now persist across restarts
- File mentions now match files with spaces in names
- Single-line code blocks now render inline in AI chat
- Extensions with minified variable names now load correctly
- Slash command menu arrow keys now navigate in visual order

## [0.49.1] - 2025-12-19


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Mockup images sent to Claude Code are now compressed and lower resolution to work around SDK display bug

### Removed
<!-- Removed features go here -->

## [0.49.0] - 2025-12-19


### Added
- Claude can ask clarifying questions during agentic sessions (AskUserQuestion tool support)
- CSV spreadsheet extension with formula support
- PDF viewer with text selection and fit-to-width zoom
- Extension Developer Kit with MCP tools for hot-reloading extensions
- Cmd+L shortcut to quickly search and open AI sessions
- Extension SDK documentation with examples
- CSV spreadsheet header row toggle with persistent settings
- Copy button for AI responses and user messages in agent transcript
- Visual diff viewer for AI-generated mockup changes
- Optional word wrap for inline code blocks in AI chat

### Changed
- Alpha-only extensions are now hidden from stable channel users
- Extension dev tools now validate manifests before install/reload
- extension_reload now rebuilds before hot-reloading
- Extensions now bundle their own utility libraries

### Fixed
- Increase MCP connection timeout to 20 seconds for slower server startups
- Move extensionsReady state declaration to the top of the App component
- Update @anthropic-ai/claude-agent-sdk to version 0.1.73
- Update @anthropic-ai/claude-agent-sdk to version 0.1.72
- Add Stytch public token configuration for OAuth integration in sync server
- Update CapacitorMlkitBarcodeScanning to version 7.5.0
- CSV spreadsheet extension now loads correctly
- Session quick open now shows all sessions and filters instantly
- Closing AI session now navigates to adjacent tab instead of first tab
- Windows Claude Code installation via npm now detected correctly
- Mockup image viewing when image is on disk instead of returned in tool call
- Code block rendering in AI chat

## [0.48.13] - 2025-12-17


### Fixed
- DataModel extension now loads correctly in production builds

## [0.48.12] - 2025-12-17


### Added
- Mouse back/forward buttons now navigate between tabs
- Analytics tracking for editor and navigation events

### Changed
- Prevent switching between SDK and Agent modes (prevents session corruption)
- Clarification added to developer dropdown
- Reduced logging output

### Fixed
- Images now display correctly in all tabs
- DataModelNode and MockupNode screenshots now work correctly in all tabs
- Windows-only Claude Code checks no longer run on macOS/Linux
- DataModelLM editor now auto-reloads when AI edits .prisma files
- Token counting now works correctly with Claude Agent SDK 0.1.62
- Token counts display correctly for Claude Code sessions
- Resized prompt input box

## [0.48.11] - 2025-12-16


### Added
- DataModelLM can export schemas to SQL, JSON, DBML formats
- Support for model and field descriptions from comments in Prisma parser
- "Learn more" button for slash commands with explanation modal
- Info about nimbalyst-local directory shown before creating

### Changed
- Downgraded @anthropic-ai/claude-agent-sdk to version 0.1.62

### Fixed
- List of edited files in sidebar no longer takes over the screen

## [0.48.10] - 2025-12-16


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Build extensions before packaging in CI
- Manual "Check for Updates" no longer hangs on checking state

### Removed
<!-- Removed features go here -->

## [0.48.9] - 2025-12-16


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Lexical editor crashes in production builds
- Mobile queued prompts now process correctly
- Agent transcript updates immediately when turn completes
- Only add markdown header when creating markdown files

### Removed
<!-- Removed features go here -->

## [0.48.8] - 2025-12-16


### Added
- Extension system: extensions can now provide Claude Code slash commands
- Extension system: extensions can open binary files with custom editors
- Extension settings UI with enable/disable and configuration support
- File context menu now opens files in system default app
- Archive button shows undo toast, archived sessions show unarchive option

### Changed
- Updated to latest version of Anthropic Agent SDK
- Removed 'New Window' option from application menu
- Updated welcome message to recommend opening project root folder

### Fixed
- Tab state corruption preventing files from opening
- Toast notification now appears below tabs
- Slash command suggestions now match transcript content width
- Archive button updates immediately after unarchiving
- Datamodel and mockup screenshots work without files being open
- Bundle built-in extensions in packaged app
- Clarify file type error message
- Search files button tooltip shows correct shortcut (Cmd+O)
- QR pairing button now enabled when using default sync server URL
- Stytch auth handlers now use production sync in production builds
- Production builds no longer use dev sync server from persisted config
- Ensure serverUrl is set before allowing login actions
- Sync server now correctly uses production when selected in dev builds
- Capacitor app icon
- Mockup annotations now sent to AI when using "+ mockup annotations"
- Skip button restored to data collection form, all fields optional

## [0.48.7] - 2025-12-14


### Added
- Large text pastes become attachments to keep transcript clean
- Close and Archive button on agent transcript panel
- Mermaid diagrams now have Redraw button and better error messages
- Auto-updater now uses subtle toast instead of popup window
- Mobile app now allows device to sleep after inactivity
- Easier browser testing for mobile sync

### Fixed
- Pasting text starting with '#' no longer triggers memory mode
- Tracker typeahead no longer triggers on markdown headers
- Closing Project Manager no longer reopens it indefinitely
- DatamodelLM entity headers now readable
- Remove update.html entry from vite config (file was deleted)
- One failing editor tab no longer breaks the entire app
- Custom editors now load correctly after app restart
- New projects now sync to mobile immediately when enabled
- Login widget no longer triggers on normal AI responses
- Login widget no longer re-renders when scrolling old sessions
- Use SDK's first-class auth error detection for login widget
- Mobile session detail layout works correctly on iPhone and iPad
- Skip export compliance prompt on TestFlight uploads
- Update pod paths for Capacitor dependencies

## [0.48.6] - 2025-12-13

### Added
- Auto-updater now uses subtle toast instead of popup window
- Mobile app now allows device to sleep after inactivity
- Easier browser testing for mobile sync

### Fixed
- One failing editor tab no longer breaks the entire app
- Custom editors now load correctly after app restart
- New projects now sync to mobile immediately when enabled
- Login widget no longer triggers on normal AI responses
- Login widget no longer re-renders when scrolling old sessions
- Use SDK's first-class auth error detection for login widget
- Mobile session detail layout works correctly on iPhone and iPad
- Skip export compliance prompt on TestFlight uploads
- Update pod paths for Capacitor dependencies

## [0.48.5] - 2025-12-12

### Added
- Extension system with DatamodelLM as first plugin
- Extensions can add slash commands and custom Lexical nodes
- Extensions can add items to the New File menu
- Extensions can use shared host dependencies like MaterialSymbol
- DatamodelLM view modes and auto-layout
- DatamodelLM now uses Prisma schema format (.prisma files)

### Changed
- Removed 'New Window' option from application menu
- Updated welcome message to recommend opening project root folder

### Fixed
- Mobile app header no longer hidden under notch, input no longer cut off at bottom
- Duplicate messages no longer appear in AI session sync
- Error now shown to user when environment switch fails
- Environment toggle now saves config when Stytch API unavailable
- Stytch auth now defaults to production in dev builds
- Sync server now correctly uses production when selected in dev builds
- Ensure serverUrl is set before allowing login actions
- Search files button tooltip shows correct shortcut (Cmd+O)
- Capacitor app icon

## [0.48.4] - 2025-12-11


### Fixed
- QR pairing button now enabled when using default sync server URL

## [0.48.3] - 2025-12-11


### Fixed
- Stytch auth handlers now use production sync server in production builds

## [0.48.2] - 2025-12-11


### Added
- Window title now shows AI session name when in agent mode
- Settings now auto-save and display scope description for each setting

### Changed
- Updated Claude Agent SDK to version 0.1.65
- Removed dangerous developer menu database features

### Fixed
- Production builds no longer use dev sync server from persisted config
- Plaintext session titles no longer sent during sync (privacy improvement)
- Claude Code allowed tools section now displays properly in settings
- Global MCP servers now work correctly in Claude Agent sessions

## [0.48.1] - 2025-12-11

### Changed
- Added diagnostic logging for PGLite database initialization

### Fixed
- Show clear error message when attempting to open binary files (PDF, PPTX, etc.)

## [0.48.0] - 2025-12-10

### Added
- Production deployment configuration for CollabV3 sync server at sync.nimbalyst.com

### Changed
- Disabled console logs in AIService and ModelRegistry for cleaner output

### Fixed
- Mobile app no longer lags when typing in chat input
- Sync now connects automatically after app restart
- Auto-updater now downloads latest version even if update window sat idle
- Analytics: ai_session_resumed event no longer fires incorrectly on app startup

## [0.47.2] - 2025-12-10


### Added
- Universal Windows installer supporting both x64 and arm64 architectures

### Changed
- Role field now marked as required in data collection form

### Fixed
- Fixed Claude Code logout process on Windows

### Removed
<!-- Removed features go here -->

## [0.47.1] - 2025-12-09


### Added
<!-- New features go here -->

### Changed
- Improved git availability detection with more comprehensive checking
- Updated Claude Agent SDK to version 0.1.62

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.47.0] - 2025-12-09


### Added
- Toast notification prompting users to install Claude commands in their workspace
- Folder History dialog to browse and restore deleted files
- AI chat @mention now supports CamelCase search for file matching
- Document links now export as standard markdown and support fuzzy search
- Session list shows relative dates (e.g., "2 hours ago") instead of absolute timestamps
- AI Usage Report now shows token counts for Claude Code sessions
- Multi-select files in file tree

### Changed
- Updated data collection form

### Fixed
- Mockup images now load correctly when reopening documents
- Mockup image syntax now matches actual transformer format
- AI Usage Report no longer resets token counts after each message
- Clicking files in agent mode now properly switches to files mode
- Session list now shows correct user message count
- Claude Code sessions now work in new/existing projects
- New projects no longer auto-open settings screen
- History restore tests now work with diff preview mode
- Git install popup no longer shown if git is not installed

### Removed
<!-- Removed features go here -->

## [0.46.11] - 2025-12-09


### Added
- Warning dialog before quitting with active AI session
- Windows users now see a warning that they need Claude Code installed

### Changed
- Rebranded "Claude Code" to "Claude Agent" in UI

### Fixed
- AI input stays focused when switching modes or tabs
- Slash command menu now shows best matches first
- Project search now shows best matches first
- Mermaid diagram edit mode now displays correctly in dark mode
- Mermaid diagrams no longer intermittently show "[object Object]" error
- @ typeahead menu now positions correctly when scrolled
- Table action menu and dropdown now display correctly in dark mode
- Table context menu and hover buttons now position correctly when scrolled
- Mobile session view no longer requires refresh after JWT expires
- Queued AI messages no longer fire immediately while AI is responding
- QR pairing modal no longer overflows screen in dev mode
- iOS mobile app now decrypts session titles and saves credentials
- Session titles now display correctly on mobile
- Magic link now requires HTTPS redirect URL in production
- Session titles and queued prompts now encrypted end-to-end
- No keychain access prompt when sync is disabled
- Sync server now restricts CORS to allowed origins only
- Mobile credentials now encrypted via iOS Keychain / Android Keystore
- Speculative fix for NIM-118: cannot-open-file-editorregistry-error-prevents-tab-creation

## [0.46.10] - 2025-12-08


### Added
- Added dirty filter indicator to file tree to show unsaved changes

### Changed
- Improved onboarding images for better display on different screen sizes
- General UI polish and refinements to onboarding experience

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.46.8] - 2025-12-07


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Fixed onboarding dialog not displaying in production builds

### Removed
<!-- Removed features go here -->

## [0.46.7] - 2025-12-07


### Added
- Git status icons in file tree showing modified/untracked files
- Toggle control to show/hide git status icons in file tree
- Feature walkthrough with onboarding images for new users
- Stytch authentication with Google OAuth and magic link email support
- Server-side token validation for authentication via CollabV3
- Session persistence across app restarts via encrypted safeStorage
- Account & Sync panel (visible to alpha users only)
- PostHog event tracking for Claude Code login/logout
- PostHog tracking for AI messages using built-in Nimbalyst slash commands
- First-launch detection for Claude Code installation status
- simple-git dependency to electron module

### Changed
- Mockup nodes now use standard linked image markdown syntax `[![alt](screenshot.png)](file.mockup.html)` instead of custom syntax
- Updated LINK and IMAGE transformer regexes to not match linked images

### Fixed
- Mobile app now shows "Running" indicator for desktop-initiated AI prompts
- Encrypted tool names and message metadata in sync system (previously exposed as plaintext)

### Security
- Added security review documentation for upcoming audit
- Tool names, attachments metadata, and content length now encrypted in synced messages

## [0.46.6] - 2025-12-05


### Added
<!-- New features go here -->

### Changed
- Reverted node-pty for Windows Claude login due to stability issues

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.46.5] - 2025-12-05


### Added
- Virtualized AI transcript for smoother scrolling in long sessions
- Standup changes summary generator (`/mychanges` command) for recent git commits
- Mobile sync testing capability in desktop browser
- Prompts navigation menu for mobile app

### Changed
- Renamed "wireframe" to "mockup" throughout codebase for consistency
- Improved mockup annotations styling
- Removed "Send to AI" button from UI
- Updated `/plan` command to use `/mockup`
- Use cross-env for build script environment variables (Windows compatibility)
- Use node-pty for Windows Claude login

### Fixed
- AI transcript rendering performance improved
- Duplicate thinking indicators no longer appear in AI transcript
- Stale data now cleared when switching sessions on mobile
- npm security vulnerabilities patched

## [0.46.4] - 2025-12-04


### Added
- Cross-device AI session sync between desktop and mobile app
- Mobile messages now trigger AI processing on desktop
- Running/pending status indicators for AI sessions on mobile
- QR code pairing for mobile app sync with E2E encryption
- Device awareness showing connected devices in sync settings
- Sync status button in navigation gutter with visual indicator
- Unified settings view with project-level AI provider overrides
- Database browser developer tool (Developer menu)
- Incremental sync that only syncs changed sessions on startup
- iOS Capacitor project files for mobile builds
- CollabV3 sync system with E2E encryption (replaces Y.js for mobile sync)
- Click to enlarge image attachments in AI chat input
- Close attachment viewer with Escape key
- Mockup nodes now support resizing with size persistence
- Embed mockups as screenshot nodes in documents

### Changed
- Consolidated icons under unified MaterialSymbol system
- Settings now opens as full view instead of modal window
- Session history sorts by last message time instead of last activity
- Removed abandoned v2 collab implementation

### Fixed
- Hidden messages now stay hidden when synced to mobile app
- Mobile session list now matches desktop sort order
- Session title updates now sync to mobile app
- Token usage bar now shows actual usage instead of appearing full
- Lazy-load session tabs to prevent slow startup with many open sessions
- Sync no longer creates duplicate messages or excessive WebSockets
- Mobile-queued prompts no longer duplicate or refire on desktop
- Mobile-queued prompts now show thinking indicator on desktop
- Mockup drawings render correctly on scrolled content
- Mockup Edit button now opens file in tab
- File tree items now have border-radius
- SyncPanel and provider panels display correctly in settings

### Removed
- Abandoned v2 collab implementation (Y.js overuse)

## [0.46.3] - 2025-12-03


### Added
- Slash command suggestions displayed in empty chat sessions
- Mouseover tooltips for slash command suggestions
- (+) button to expand and show all suggested slash commands
- Description text for slash commands in autocomplete
- `/mockup` command for creating mockups
- "Are you sure?" confirmation dialog when starting fresh database
- MockupLM instructions added to system prompt and `/plan` command
- MCP tool for mockupLM with headless render fallback
- Documentation update instructions to `/review-branch` command
- PostHog tracking for slash command suggestion clicks
- PostHog tracking for mockup file creation

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- `/compact` command broken after "prompt too long" error
- Two absolute imports failing in modules
- Command regex to list speckit in autocomplete
- Directory naming: `.nimbalyst-local` corrected to `nimbalyst-local`
- MockupLM annotations now sent to agent when present

### Removed
<!-- Removed features go here -->

## [0.46.2] - 2025-11-26


### Added
- MockupLM-style mockup editor with AI integration
- Recursive scanning for Claude commands and agents (BMAD v4 fix)
- Maximum file scan limit increased from 1,000 to 2,000
- TypeScript files now show distinct TS icon in file tree
- Message timestamps show date when not from today
- AI usage analytics dashboard

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- AI-created files now open automatically from files panel
- Claude Code session imports now show accurate data
- Corrected missing dots in `.nimbalyst-local` directory references

### Removed
<!-- Removed features go here -->

## [0.46.1] - 2025-11-25


### Added
- Model version now displayed in selector for Claude Code
- Prompt caching support for AI responses (reduces API costs and improves response times)

### Changed
- Session timestamps now match sort order for consistent display

### Fixed
- Users migrating from older versions now see all available Claude Code models

### Removed
<!-- Removed features go here -->

## [0.46.0] - 2025-11-24


### Added
- Users can now disable analytics in settings
- Cmd+Shift+T now reopens last closed tab
- Selection of different Claude models (Opus 4.5, Opus 4, Sonnet 4, etc.)
- Remember what model was used when creating a new session

### Changed
- Refactor: consolidate all file opening to single clean API
- Use store.ts app settings instead of localStorage for onboarding screen state
- Update Claude Agent SDK to latest version to support Opus 4.5

### Fixed
- Skip onboarding check in Playwright tests
- Agent file clicks now open in editor mode
- Pinned tabs now protected from bulk close operations
- Restore correct onboarding implementation
- Onboarding dialog no longer appears in every window

## [0.45.43] - 2025-11-24


### Added
- Pasted images now work in other markdown editors (use asset storage system instead of temp files)
- @ mentioned files auto-attach for non-agent models
- Configure models option to model selector dropdown

### Fixed
- Chat attachments no longer pollute project directories (now stored in dedicated assets folder)
- Image attachments now display in transcript
- API errors now display in chat instead of failing silently
- Swap session action button order to match physical layout

## [0.45.42] - 2025-11-23


### Changed
- Commit command now emphasizes impact over implementation in messages

### Fixed
- OpenAI, LMStudio, and Claude API providers now work correctly (responses and tool calls were not being displayed or executed)
- AI diffs from non-Claude-Code providers now persist across app restarts

## [0.45.41] - 2025-11-23


### Added
- Native spell check context menu with correction suggestions, "Learn Spelling", and "Ignore Spelling"

### Changed
- Remove redundant tab activation polling check

### Fixed
- Wait for editor ready before checking pending diffs
- Prevent AI edits going to wrong document on tab switch
- Restore Monaco diff mode on mount for code files (diff view was not displaying for code files)
- Preserve manual edits during diff mode and save on tab close (manual edits were being lost when accepting/rejecting diffs or closing tabs)

### Removed
- Remove sharp dependency (no longer needed)

## [0.45.40] - 2025-11-23


### Added
- Display image thumbnails in agent transcript
- ExitPlanMode confirmation hook for planning mode
- Memory mode to AIInput for Claude Code
- Allow archiving active/selected sessions
- Token usage tracking restored for all AI providers
- Enhance FileGutter with git status and operation icons
- Session archiving system with multi-select support
- Enhanced session dropdown with name, provider icon, and status
- User role question on first startup
- Analytics for branch-review command
- `.nimbalyst-local` directory with color in project root
- Links to changelogs for agent-sdk and claude-code
- Feedback survey button

### Changed
- Update session message count label from "messages" to "turns"
- Remove dueDate field from plans tracker system
- Windows build changed to x64 instead of arm64
- Detect installed packages on the fly instead of saving state
- Add identifying CSS classes to major React components
- Use vite-plugin-monaco-editor to fix CSS 403 errors

### Fixed
- Hide WelcomeModal in Playwright tests
- Update invoke method for session metadata to use correct namespace
- Place implementation checkboxes after plan title, not before
- Pass workspacePath prop to AgentTranscriptPanel for git status
- Generate unique filenames for pasted images
- Send images directly to Claude SDK instead of file paths
- LMStudio messages not appearing in agent transcript
- Add Monaco CSS import to fix 403 errors in dev mode
- Hide FileGutter in agent mode to avoid duplicating sidebar
- Close session tab when archiving
- Prevent tab context menu from going off screen
- Sync session dropdown across agent and files modes
- Update sharp dependencies for cross-platform compatibility
- Remove platform-specific sharp dependency that broke macOS installs
- Windows was using the old icon
- Add cross-platform path handling for Windows compatibility

### Removed
<!-- Removed features go here -->

## [0.45.39] - 2025-11-20


### Added
- MCP server configuration UI for alpha users
- File type support to history dialog
- Export pathResolver utility from utils
- E2E test for file mention typeahead with all file types
- Blue dot indicator for pending diffs
- Track users who have opened from Crystal
- Message displayed when file tree filter has no results
- Support for --workspace and --filter CLI arguments to launch with specific workspace and filter

### Changed
- Improve file mention typeahead display and scrolling
- Improve tracker loading and file mention path handling
- Force TrackerTable reload when data changes
- Maintain running state between queued messages
- Update filter icon to use actual filter icon
- Improve database corruption message
- Remove redundant hamburger menu
- Remove unused WorkspaceHeader function
- Logging cleanup
- Upgrade @modelcontextprotocol/sdk to 1.22.0

### Fixed
- Configure Monaco Editor to use local workers in Electron
- Support URLs with parentheses in markdown links
- Send completion token on error so UI knows agent turn is done
- NIMBALYST_SYSTEM_MESSAGE showing when pressing up arrow
- Wrong path parsing in non-render components
- Queued messages race conditions with auto-context
- CI build failures caused by peer dependency conflicts and missing MCP SDK dependencies

### Removed
<!-- Removed features go here -->

## [0.45.35] - 2025-11-20


### Added
- MCP server configuration UI for alpha users
- File type support to history dialog
- Export pathResolver utility from utils
- E2E test for file mention typeahead with all file types
- Blue dot indicator for pending diffs
- Track users who have opened from Crystal
- Message displayed when file tree filter has no results
- Support for --workspace and --filter CLI arguments to launch with specific workspace and filter

### Changed
- Improve file mention typeahead display and scrolling
- Improve tracker loading and file mention path handling
- Force TrackerTable reload when data changes
- Maintain running state between queued messages
- Update filter icon to use actual filter icon
- Improve database corruption message
- Remove redundant hamburger menu
- Remove unused WorkspaceHeader function
- Logging cleanup

### Fixed
- Configure Monaco Editor to use local workers in Electron
- Support URLs with parentheses in markdown links
- Send completion token on error so UI knows agent turn is done
- NIMBALYST_SYSTEM_MESSAGE showing when pressing up arrow
- Wrong path parsing in non-render components
- Queued messages race conditions with auto-context

### Removed
<!-- Removed features go here -->

## [0.45.34] - 2025-11-19


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Improve session history refresh experience
- Correct function name in session delete handler

### Removed
<!-- Removed features go here -->

## [0.45.33] - 2025-11-19


### Added
- Tab-triggered content search to session history
- E2E test for Monaco diff approval

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Prevent React event from being passed to createNewSession
- Respect sort selection in session history grouping

### Removed
- Unnecessary log statements

## [0.45.32] - 2025-11-19


### Added
- File tree filter for git modified files
- Orange gutter indicator when running in dev mode

### Changed
- Replace orange dev mode background with "TEST MODE" text indicator
- Update review-branch.md to include OS interoperability

### Fixed
- Session history timestamp display and timezone handling
- Monaco diff approval bar now appears for AI edits to code files
- Detect expired Claude Code sessions and show clear error message
- Path bug causing slash commands not to load

### Removed
- Debug logs from MonacoDiffApprovalBar

## [0.45.31] - 2025-11-18


### Added
- Planning mode file restrictions
- Word boundaries in diff context stripping
- Discord link to Help menu
- Read/written file filters to file tree
- Token usage category breakdown to AI chat
- Auto-name sessions via MCP

### Changed
- Refactor: remove AgenticCodingWindow in favor of unified agent mode
- Refactor: add mode field to separate session behavior from origin
- Better display for MCP tool calls
- Keep showing login button even when logged in (prevents OAuth expiry issues)
- Log reduction

### Fixed
- Preserve search box when no sessions match in agent mode
- Update Discord invite URL to correct link
- Monaco diff editor disposal errors
- Session not opening when switching from Files to Agent mode
- Always fetch release notes from R2 for alpha channel
- Remove duplicate Files header in agent sidebar
- Fork AutoLinkPlugin to filter base64 URLs
- Comment out console warnings for depth scanning limits
- Prevent false diffs for hashtags in unchanged content

### Removed
<!-- Removed features go here -->

## [0.45.30] - 2025-11-17


### Added
- Session state tracking for cross-mode visibility
- /bug-report command for interactive bug reports
- Automated /release-public command with cumulative release notes
- Automated public release notes from CHANGELOG
- Release notes fetching from R2 for alpha channel updates

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Add performance limits to workspace manager file scanning
- Prevent app freezing on large workspace directories
- Remove unused Documentation button from Global Settings
- Prevent Monaco diff editor disposal error when closing tabs
- Resolve workspace-relative paths in workspace:open-file handler
- File tree sync and auto-scroll issues
- Prevent editor.registerCommand crash during HMR
- Remove double scrollbars in Monaco markdown mode

### Removed
<!-- Removed features go here -->

## [0.45.29] - 2025-11-17


### Added
- Full-text search to session history
- Floating actions to agent transcript
- Inline diff mode for Monaco code editor
- Markdown syntax highlighting to Monaco editor
- Project-aware file opening from OS
- Natural sorting to file tree
- Release notes to alpha channel updates

### Changed
- Replace markdown mode conversion with view mode toggle

### Fixed
- Disable console logs for context fetching in AIService and TreeMatcher
- Disable error markers in Monaco editor
- Ensure DiffApprovalBar appears after view mode switch
- Handle DMG/ZIP files without version in filename

### Removed
<!-- Removed features go here -->

## [0.45.28] - 2025-11-16


### Added
- Alpha release channel for internal testing
- Image viewer for standalone image files
- File tree filtering with type-specific icons
- Find functionality to agent transcript
- Tracker type assignment UI to document actions menu
- Dual session opening from floating AI sessions dropdown
- Claude Code session import and sync system

### Changed
- Replace dynamic imports with static imports
- Persist file tree filter and icon visibility settings

### Fixed
- Debounce search input to prevent focus steal
- Route search shortcuts through menu system
- Remove quick open name match badge
- Preserve newlines in user messages in transcript
- OptimizedWorkspaceWatcher not sending file-changed-on-disk events
- Monaco editor not updating when file changes on disk
- Improve scrolling behavior for change groups in editor
- Remove overly broad process exit error classification
- FileTree auto-expand and selection clearing
- Claude Code session import message filtering and ordering
- Correct R2 bucket name in workflow

### Removed
<!-- Removed features go here -->

## [0.45.27] - 2025-11-16


### Added
- Alpha release channel for internal testing
- Image viewer for standalone image files
- File tree filtering with type-specific icons
- Find functionality to agent transcript
- Tracker type assignment UI to document actions menu
- Dual session opening from floating AI sessions dropdown
- Claude Code session import and sync system

### Changed
- Replace dynamic imports with static imports
- Persist file tree filter and icon visibility settings

### Fixed
- Debounce search input to prevent focus steal
- Route search shortcuts through menu system
- Remove quick open name match badge
- Preserve newlines in user messages in transcript
- OptimizedWorkspaceWatcher not sending file-changed-on-disk events
- Monaco editor not updating when file changes on disk
- Improve scrolling behavior for change groups in editor
- Remove overly broad process exit error classification
- FileTree auto-expand and selection clearing
- Claude Code session import message filtering and ordering

### Removed
<!-- Removed features go here -->

## [0.45.26] - 2025-11-14


### Added
- Database backup and corruption recovery system
- Folder contents refresh on expansion
- Review-branch slash command

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Built-in slash commands broken by user prompt addendum
- Open document message showing to user
- Message formatting to append current document name instead of prepend
- Local network usage description for Nimbalyst
- Token count and AI chat broken after merge
- Correct context window usage calculation

### Removed
<!-- Removed features go here -->

## [0.45.25] - 2025-11-14


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
<!-- Bug fixes go here -->

### Removed
- Remove phone number detection from analytics

## [0.45.24] - 2025-11-14


### Added
<!-- New features go here -->

### Changed
- Disable sourcemaps in production builds

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.45.23] - 2025-11-14


### Added
<!-- New features go here -->

### Changed
- Switch from accept/reject to undo/keep for clarity in diff approval actions
- Use unified diff for guideposts instead of context-aware hashing

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.45.22] - 2025-11-13


### Added
- Strip unchanged context from agent transcript diffs for cleaner display

### Changed
- Comment out console logs for cleaner output during file operations
- Logging cleanup in diff operations

### Fixed
- Handle markdown normalization in diff matching
- Fix file watcher stats for Chokidar implementation
- Prepend current document name to ClaudeCode messages in AIChat
- Remove bad stopFileWatcher causing us to lose track of agent changes
- Allow re-scrolling to current diff with navigation arrows
- Separate pure formatting changes from text changes in inline diff
- Handle formatting changes in inline diff

### Removed
- Reverted experimental markdown normalization for diff matching
- Reverted red/green color coding changes
- Reverted automatic diff acceptance behavior
- Reverted hacky window refresh approach

## [0.45.21] - 2025-11-13


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- AI diff view now properly refreshes when toggling diff view on/off
- Disabled automatic acceptance of AI diffs when diff view is turned off, ensuring file content shown matches what's on disk

### Removed
<!-- Removed features go here -->

## [0.45.20] - 2025-11-13


### Added
<!-- New features go here -->

### Changed
- Disabled red/green color coding by default

### Fixed
- Fixed crash: "Error: The 'screen' module can't be used before the app 'ready' event"

### Removed
- Removed "Getting Started with Nimbalyst" screen

## [0.45.18] - 2025-11-12


### Added
- Sub-agent result display in AI chat transcript
- Better visuals for edit/write tools
- Test normalized Lexical-sourced markdown for original content matching

### Changed
- Update Claude Agent SDK to latest version
- Better UX for Claude Code auth settings
- Hide mode-tag button until wired to sessionType

### Fixed
- Add diagnostic logging for AI diff display issues
- Route notifications by workspace path instead of window ID
- Export horizontal rules as --- instead of ***
- Let dev mode locations fire normally (better for testing)
- Improve diff matching with text-based guide posts
- Copy as Markdown menu item now works and preserves newlines correctly
- Dark mode theming for workspace actions and tracker icons
- History dialog diff preview respects dark mode theme
- Scrollbar theming in dark mode on macOS when user has always show scrollbars on

### Removed
<!-- Removed features go here -->

## [0.45.17] - 2025-11-12


### Added
- Improve search/replace bar with live updates and better UX

### Changed
- Hide mode-tag button until wired to sessionType
- Remove unused editorRef from useIPCHandlers

### Fixed
- Export horizontal rules as --- instead of ***
- Let dev mode locations fire normally (better for testing)
- Improve diff matching with text-based guide posts
- Copy as Markdown menu item now works and preserves newlines correctly
- Dark mode theming for workspace actions and tracker icons
- History dialog diff preview respects dark mode theme
- Scrollbar theming in dark mode on macOS when user has always show scrollbars on

### Removed
<!-- Removed features go here -->

## [0.45.16] - 2025-11-11


### Added
- Floating button to show AI sessions for current document
- Sort dropdown to session history panel

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Update session name in history list immediately after rename

### Removed
<!-- Removed features go here -->

## [0.45.15] - 2025-11-11


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Empty lines appearing at wrong positions in diff operations
- Prevent duplicate snapshot creation and history dialog selection bugs
- Remove debug logging that leaked document contents
- Generate tagIds for incremental-approval tags and update pendingAIEditTagRef
- Incremental diff baseline tracking for subsequent AI edits
- Prevent accepted changes from reappearing in subsequent AI edits

### Removed
<!-- Removed features go here -->

## [0.45.14] - 2025-11-10


### Added
- Dispatch CLEAR_DIFF_TAG_COMMAND in additional edge cases
- incremental-approval support to history dialog
- E2E test for Accept All edge case and metadata parsing
- E2E test for reject-then-accept-all diff behavior

### Changed
- Updated AI input placeholder text to 'Ask a question. @ for files. / for commands'
- Improved no file opened screen design
- Updated empty AI sidebar text

### Fixed
- Infinite autosave loop after editing files
- Dev mode location analytics now fire normally (better for testing)
- Prevent flashing reloads during tab switches in diff mode
- Keyboard shortcuts now reliably target focused window
- Preserve incremental diff state across file close/reopen

### Removed
<!-- Removed features go here -->

## [0.45.13] - 2025-11-10


### Added
- Git status indicators to FileEditsSidebar
- PostHog events for tracking tab usage
- is_dev_user property sent on all non-release builds with setOnce

### Changed
- Extract FileEditsSidebar inline styles to CSS

### Fixed
- Incremental diff accept/reject now properly clears pre-edit tag

### Removed
<!-- Removed features go here -->

## [0.45.12] - 2025-11-10


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- SQL parameter placeholder in mark session as read
- Incremental diff accept/reject now clears pre-edit tag
- OS notifications not appearing in development mode
- Detection of tool packages installation

### Performance
- Optimized AI chat input rendering in long sessions by splitting transcript and input components

### Removed
<!-- Removed features go here -->

## [0.45.11] - 2025-11-09


### Changed
- Claude Code enabled by default for new installations
- Improved login widget UX with better post-login experience
- Enhanced error handling to avoid showing duplicate login messages

### Fixed
- Don't show model config screen on fresh install
- Better logic around showing duplicate login messages
- Don't show error in addition to login widget

## [0.45.9] - 2025-11-09


### Added
- AI prompt queueing system for managing multiple AI requests
- Tool packages system with version tracking for Claude Code
- Typeahead search with keyboard navigation to workspace manager
- Display project-relative paths in agent transcript

### Changed
- Tightened agentic panel UI spacing and improved CSS variable usage
- Made entire folder row clickable to expand/collapse in file tree

### Fixed
- Cmd+Alt+Left tab navigation event name mismatch
- TrackerTable now responds to filterType prop changes
- Pass attachments to AI provider and prevent typeahead conflicts
- Eliminated unnecessary session list reloads and race conditions
- Fixed tab keyboard arrow navigation
- Prevented double-loading of diff editor on file open

### Removed
<!-- Removed features go here -->

## [0.45.8] - 2025-11-08


### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
- Resolve peer dependency conflicts by hoisting ajv and terser

### Removed
<!-- Removed features go here -->

## [0.45.7] - 2025-11-08


### Added
- Working simple todo display

### Changed
- Upgraded vite-plugin-static-copy to 3.1.4 to fix chokidar dependencies
- Upgraded npm to 11.x in CI to fix optional dependencies bug

### Fixed
- Prevent infinite loop in tab activation during diff application
- Add zod dependency and externalize MCP SDK to fix dev mode build
- Improved test reliability and fixed race conditions

### Removed

## [0.45.6] - 2025-11-07


### Added
- /implement command for plan execution and progress tracking

### Changed
- Upgraded Claude Agent SDK to latest version

### Fixed
- Terminal icon no longer shows for every Claude Code interaction
- Analytics now only recorded on official release builds (not development builds)
- Check login status now works correctly in packaged DMG
- History dialog restore button now properly enables when showing diffs
- Claude installation assumed available on Win32 platform

## [0.45.5] - 2025-11-07


### Added
- Settings menu item for non-darwin platforms (File > Settings...)
- E2E test for partial diff acceptance with rejections

### Changed
- Integrated ThresholdedOrderPreservingTree (TOPT) algorithm for order-preserving diffs
- Improved TOPT matching for nested list structures
- Use hybrid content-first matching for list item diffs
- Reorganized and cleaned up DiffPlugin tests
- Use electron-node for Claude Code login/logout operations

### Fixed
- External links now open in default browser instead of in-app
- Reverted bad optimization for local changes that caused full document diff regressions
- History dialog diff navigation now syncs with clicked diff groups
- TOPT now forces exact text matches to prevent false alignments
- Prevent unnecessary processing of children when content is unchanged
- AI edit tag now clears properly after incremental diff operations
- Console.log statements removed from diff utilities and various components
- Electron-node authentication for Claude Code login/logout

### Removed
<!-- Removed features go here -->

## [0.45.4] - 2025-11-05


### Added
- TreeViewPlugin now displays diff state information for debugging

### Changed
- Markdown import/export preserves newlines and spacing more consistently
- LiveNodeKeyState setup is now automated in diff operations
- Reduced debug logging noise in DiffPlugin, SlashCommandService, and markdown import

### Fixed
- History dialog diff preview now displays changes correctly
- Multi-section diff operations no longer create extra blank lines
- Claude Code login/logout workflow improved
- Window close behavior on macOS (removed darwin-specific check)

## [0.45.3] - 2025-11-04


### Added
- Unified diff navigation for document history dialog
- Token usage display for Claude Code AI sessions
- Sound and OS notifications enabled by default for new users
- Login required widget for Claude Code authentication
- E2E tests for AI multi-round editing

### Changed
- Improved Claude Code login widget appearance
- Claude Code now uses SDK-only authentication

### Fixed
- File watchers now stay active for all open tabs (no longer stop when switching tabs)
- Cmd+N new file dialog now opens correctly in files mode
- Unhandled promise rejection in Claude Code login check
- AI diff approval system for consecutive edits
- Adjacent diff changes now group correctly
- Cache read tokens excluded from cumulative usage display
- Session history no longer refreshes on input, improved status indicators
- Title bar overlay error handling
- Multiple debug console log noise issues

### Removed
<!-- Removed features go here -->

## [0.45.2] - 2025-11-03


### Added
- Separate /release-public command for public release phase
- GitHub Actions workflow for publishing to public repository
- Two-phase release process (internal testing, then public release)

### Changed
- Split /release command into two phases for internal testing
- Updated electron-builder to publish to private repo first
- Release workflow now publishes to nimbalyst-code (private) before nimbalyst (public)

### Fixed
- Session unread indicators now use timestamp-based tracking
- PGlite database initialization error handling improved
- Concurrent AI sessions now work properly in agent mode
- Enhanced test helpers with better logging and tab selectors

### Removed
<!-- Removed features go here -->

## [0.45.1] - 2025-11-02


### Added
- Find/replace bar now integrated in fixed tab header
- File-watcher-based diff approval for AI edits
- OS notification support for AI completion
- Completion sound notifications for AI responses
- Auto-focus AI input when creating new session
- Agent mode replacing separate session manager window

### Changed
- AI chat draft input now persisted to database
- AgenticCodingWindow deprecated in favor of AgenticPanel
- Optimized AgenticPanel event handler registrations
- Memoized AISessionView to prevent unnecessary re-renders
- Custom tracker loading extracted to separate service

### Fixed
- Reduced runtime package TypeScript errors from 33 to 9
- Achieved zero TypeScript compilation errors in rexical
- Improved TypeScript compilation with path mappings
- Capture full text context for tracker item titles with whitespace
- Consecutive AI edits now update diff view properly
- Display user message count in agent session list
- Resolve system theme to actual theme before rendering
- Allow tab switching shortcuts when search bar focused
- Route MCP tools to correct window using workspace path
- Use relative paths in onboarding service file creation

## [0.45.0] - 2025-10-31


### Added

Welcome to the first public alpha release of Nimbalyst, a markdown editor with integrated Claude Code support.

**Core Features:**
- Rich markdown editing with Lexical framework
- Native Claude Code integration for AI-assisted editing
- Document history with version snapshots
- Multi-workspace support
- File tree navigation
- Live preview and syntax highlighting

**AI Capabilities:**
- Chat with Claude directly in your documents
- AI-powered diff review and approval
- Multiple AI provider support (Claude, OpenAI, LM Studio)
- Streaming edits with real-time preview

**Built for developers:**
- Clean, distraction-free interface
- Fast local-first architecture
- Cross-platform (macOS, Windows, Linux)

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.44.0] - 2025-10-31


### Added

Welcome to the first public alpha release of Nimbalyst, a markdown editor with integrated Claude Code support.

**Core Features:**
- Rich markdown editing with Lexical framework
- Native Claude Code integration for AI-assisted editing
- Document history with version snapshots
- Multi-workspace support
- File tree navigation
- Live preview and syntax highlighting

**AI Capabilities:**
- Chat with Claude directly in your documents
- AI-powered diff review and approval
- Multiple AI provider support (Claude, OpenAI, LM Studio)
- Streaming edits with real-time preview

**Built for developers:**
- Clean, distraction-free interface
- Fast local-first architecture
- Cross-platform (macOS, Windows, Linux)

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [0.43.0] - 2025-10-31


### Added
- Added slider control for tracker progress fields
- Added comprehensive analytics event tracking for feature usage
- Show workspace onboarding dialog if not completed yet

### Fixed
- Fixed restart button not disabling and showing restarting status
- Fixed missing onRestore callback in history dialog
- Fixed agent transcript sidebar entries not spanning full width
- Fixed code blocks without language specification being dropped on export
- Fixed path.join implementation bug
- Fixed config.json being appended to instead of overwritten when saving

### Changed
- Migrated organization to nimbalyst GitHub organization

### Removed
<!-- Removed features go here -->

## [0.42.60] - 2025-10-30

### Fixed
- Fixed file selection not clearing when tab is closed
- Fixed tracker document header not appearing on initial load
- Fixed files not marked dirty when tracker updates frontmatter
- Fixed error handling for missing directories in folder contents retrieval

### Changed
- Claude Code now updates database and notifies panel to check for updates
- MCP stream tool now operates synchronously for better reliability
- AI tools now require explicit file paths for better clarity

### Removed
- Removed deprecated getDocument tool

### Internal
- Modernized end-to-end test infrastructure


<!-- system test edit 2026-02-24 -->
<!-- system test: minor edit -->
