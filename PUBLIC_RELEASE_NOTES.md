# July 23rd 2026 Release

### New Features

- **Launch a session from anywhere with Cmd+Shift+N.** The draggable composer starts an AI session in the background from any workspace mode without navigating away, and resets for the next launch.
- **Agent attention list.** The Agent navigation icon shows sessions awaiting input, running, or unread, and opens a grouped attention list with a mark-all-read action. Agents can also send local system notifications when you step away.
- **Model controls in chat.** Switch AI models from the keyboard directly in the chat input, search the model picker by name or ID, and toggle extended thinking per session on supported Claude models.
- **Start a PR review session.** Launch an AI review session from any pull request with the review command prefilled.
- **Voice improvements.** Voice agents can now use your workspace's slash commands.
- **Persistent Git command history.** The Git extension keeps a live command output history across panel and renderer reloads.
- **Selection chips in AI chat.** What you have selected in an editor now appears as removable chips in the chat — including multiple shapes at once from editors like Excalidraw — so you can drop anything you don't want sent to the model.
- **Customizable tracker types. Add, rename, or remove statuses, tweak labels, icons, and colors, or add fields on built-in tracker types per workspace, and reset to defaults at any time.** Tracker types can also be organized into manually ordered folders.
- **Better tracker navigation.** Star tracker items and filter by Favorites, Recently Viewed, and Edited by Others. Tracker items and sessions mentioned in chat are clickable and show live workflow status, and you can launch an isolated worktree session directly from a tracker item.
- **Extension settings pages.** Extensions can contribute first-class Application or Project settings pages with per-repository context, request host filesystem access for editors that read and write project files, and reference tracker items with compact typed pickers.
- **Tool usage in the AI Usage Report.** See built-in and extension tool usage over time and by project, with historical backfill.
- **Nimbalyst Teams alpha enhancements.** Team collaboration and shared documents got a broad round of improvements and fixes during the free alpha, including offline editing, more shareable file types, and multi-account sign-in.

### Improvements

- The agent permissions dialog and navigation indicator now present four clearer autonomy levels, defaulting to Agent-verified.
- Codex is now enabled by default and the Claude Code CLI is opt-in; existing choices are preserved.
- The bundled Claude Agent engine was updated to Claude Code 2.1.215, and the desktop app now runs on Electron 43.
- The bundled marketplace catalog includes 18 extension releases, including Electronics Studio and new Replicad CAD tools.
- Quick Open now puts Memory search at the end with clear Docs, Trackers, and Sessions scopes, while keeping exact tracker lookup and file-content search distinct.
- Inline tracker references show the item type, key, live title, workflow state, and owner, with completed titles crossed out.
- Hidden Tracker and PR Review modes pause background work while preserving their state, and extension editors stay available without eagerly loading every extension.
- Hiding, showing, or reordering navigation gutter icons updates every open window immediately instead of after a reload.
- File and folder pickers open in the active workspace or their last-used directory.
- Mobile session sync skips messages the mobile transcript never displays, cutting sync storage and traffic.
- Settings is reorganized into Application, Account, and Project sections, plus project-level MCP server configuration.

### Fixed

**AI sessions and agents**

- Claude Agent sessions no longer invalidate their prompt cache mid-session, which could re-bill the full cached context on tag updates, session naming, or extension servers connecting mid-session.
- Interrupting a Claude Agent session no longer lets a permission-gated tool run anyway, and stopping a Codex session — including from mobile — now cancels it immediately instead of bouncing back to "running".
- New agent sessions no longer hang on a spinner that never resolves when git status stalls.
- Answering an interactive prompt from mobile — approving a plan, granting a tool permission, or answering a question — now works across every agent, and Codex question prompts reliably resume the turn.
- Codex model selection is preserved across turn refreshes, Codex usage adapts to variable rate-limit windows, and Codex sessions reap child processes instead of accumulating orphans.
- File edits from concurrent Codex sessions stay with the session that made them.
- OpenAI Codex automations use the signed-in subscription, report failures accurately, and prevent overlapping duplicate runs.
- Claude Code (CLI) sessions created for a worktree now run inside that worktree, so their edits land on the worktree branch.
- OpenCode no longer stays disabled for the rest of the session when its server is slow to start, and a missing OpenCode CLI reports a clear error.
- MCP servers disabled in Settings no longer load in Claude Code (SDK) sessions.
- Queued prompts that were delivered but never answered now show a visible failed state with a retry hint instead of being silently marked completed (#783, #790).
- The context usage popup labels cumulative session totals separately from the current window fill (#824).
- Commit with AI stays bound to its native worktree, preserves unrelated staged changes, and no longer sweeps in ignored files like `node_modules`.

**Performance and stability**

- Very large AI sessions open quickly instead of appearing to hang, and no longer slow down as history grows.
- The UI no longer stalls for seconds during heavy AI file editing across multiple sessions.
- Switching sessions no longer leaks event listeners, which could slow the window down and eventually crash it after days of uptime.
- Scrolling long virtualized lists such as the sessions list no longer crashes the app, and sorting by created date no longer crashes or locks you out of a workspace.
- Switching themes no longer freezes the window when documents with code blocks are open.
- Opening several tracker items or AI tabs at once no longer repeats redundant lookups and network round trips.
- Archiving a workstream archives its child sessions too, and oversized session metadata is cleaned up on startup so affected databases stop growing.

**Editors and UI**

- Text you select in an editor reliably appears as a chip in the AI chat and is sent with your prompt — after editor reloads, in agent-session tabs, for spreadsheet cells, and for mockup screens.
- Embedded files and tracker references survive copy and paste without degrading or emptying the document.
- RTL text typed in the chat composer displays on the right again, and RTL support no longer flattens transcript headings or strips layout from Markdown blocks.
- Importing Mermaid diagrams into Excalidraw works again, including subgraphs, and AI-added arrows keep their labels.
- SQLite databases open in the browser again, and the Find command opens the native find widget in code files instead of crashing.
- Legacy mockup embeds migrate to the current live design-link format, and inline charts and screenshots in chat render again.
- Embedded spreadsheets and code editors in the transcript no longer steal focus and scroll-jump the transcript.
- Tracker sidebar counts match the filtered list and Kanban views, tracker history records manual edits, and long tracker titles wrap instead of being clipped.
- Right-clicking near a panel edge keeps context menus on screen, and Escape closes them.
- PR review diffs follow the active theme, PR rows show the time of the latest real activity, and PR mode explains when a merge needs the GitHub CLI `workflow` scope.
- Restored windows no longer steal focus during launch, and restored terminal history no longer flashes before hiding.
- The user menu links to Application and Project settings again.

