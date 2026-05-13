# Nimbalyst v0.60.1

This release covers everything since v0.59.2: a new multi-project rail, a richer structured-prompt tool for AI agents, Codex parity work, and a long list of fixes across the editor, AI pipeline, and platform support.

### New Features

- **Multi-project rail.** A new Discord-style vertical rail lets a single Nimbalyst window host several workspaces side-by-side, with instant switching. Inactive projects stay warm: AI sessions keep streaming, file watchers keep firing, transcripts keep updating, and tabs/panel layouts are preserved per project. `Cmd/Ctrl+1..9` activates the Nth project; `Cmd/Ctrl+Shift+W` closes the active one. Right-click a rail icon for "Open in new window", "Reveal in Finder/Explorer", and "Close project". Enable it under Settings > Advanced > General > "Multi-project Mode".
- **Show Tool Calls in Chat toggle.** A new Agent Features setting (default on) lets you hide tool-call rows in the AI chat entirely, not just collapse them. Interactive prompts (permission requests, plan-mode exits, commit proposals, AskUserQuestion) still appear so you can always respond.
- **PromptForUserInput MCP tool.** Agents can now collect several inputs at once through a single structured-prompt widget with five field types: multi-select, single-select, reorder, edit-text, and confirm. Voice mode honors a `voiceFriendly` hint and defers to the screen for long drafts or large reorders.
- **Rename AI sessions, plus Preferred Agent Language.** Sessions can now be renamed (right-click an existing session). A new "Preferred Agent Language" setting on the Agent Features panel steers AI-generated session names toward your chosen language for both Claude Code and other providers.
- **Voice mode improvements.**
  - Voice agent can now run "Commit with AI" via a new `propose_commit` voice tool. The same Requesting Commit Proposal widget appears in the transcript and you can approve or reject by voice.
  - Voice agent can create a coding session on demand; the new session becomes the active linked session automatically.
  - "Generate Project Summary" now launches a new agent session in your configured agent (Claude Code, Codex, etc.) instead of requiring an Anthropic API key.
  - Voice Mode settings surface microphone permission status with a deep link to System Settings on macOS.
- **Codex parity.**
  - Codex `file_change` tool calls now render as inline red/green edit cards in the transcript, matching how Claude's `Edit` tool already renders.
  - Codex slash command autocomplete and a unified slash-command picker across Claude Code and Codex.
  - Skills and commands written for one agent run in the other; workflow discovery is unified across providers.
  - Codex reasoning items map into transcript thinking blocks.
- **Slash skill namespacing.** Plugin skills are now namespaced consistently with commands (e.g. `/excalidraw:excalidraw`, `/planning:design`, `/feedback:bug-report`) so the inserted command matches what the agent SDK routes.
- **MCP servers run on Electron's bundled Node.** MCP servers configured with `command: "node"` now use Electron's bundled Node runtime, so MCP features work out of the box on fresh installs without a system-wide Node.js install.
- **List recent sessions by title only.** The `list_recent_sessions` MCP tool now accepts `searchField: 'title' | 'content' | 'both'` so agents can find a session by name even when the search term appears throughout conversations.
- **Tracker `tracker_update` can change the primary type.** A `task` that turns out to be a `bug` can now be reclassified without losing comments, attachments, or session links.
- **Markdown anchor links scroll to in-document headings.** Clicking `[Section](#section)` in a Lexical document now scrolls to the matching heading. (#248)
- **PDF export metadata.** Markdown-to-PDF export now writes the document title and generates an outline from headings, so exported files are bookmarked and the title shows in PDF readers.
- **Peek file diffs from the git log commit detail.** Click a file in a selected commit's detail panel to pin its unified diff in the peek popover; Up/Down steps through files; Esc closes.

### Improvements

- **Slow startup is visible.** A new always-on `[StartupSlow] {phase} took {ms}ms` log line is emitted whenever startup phases (PGLite init, project file sync, session index sync, etc.) cross 2 seconds, so beach-ball reports surface a concrete phase.
- **Lexical 0.44 upgrade.** Editor packages are upgraded to Lexical 0.44.0 across the runtime.
- **Lexical extension API.** Extensions can now ship Lexical editor extensions (custom nodes, transformers, commands, and React UI surfaces) through a new manifest field.
- **Codex SDK upgrade.** Bundled `@openai/codex-sdk` upgraded to 0.128.0; Claude packaged binary resolution hardened so agent sessions stay on bundled or explicit custom binaries.
- **Session list refresh is faster.** The session list no longer scans the full edit history on every refresh, and concurrent refreshes share one query.

### Fixed

- **Tray icon on Linux and Windows.** The system tray entry now appears on Linux AppImage and Windows builds; previously only macOS showed the tray. (#39)
- **Multi-file drag-and-drop.** Dragging a multi-selection of files in the file tree now moves or copies every selected item, with a single summary error dialog if some fail. Previously only the first file was moved. (#31)
- **Claude Chat connection to Claude Opus 4.7.** Test Connection (and real chat sends) no longer fail with `temperature is deprecated for this model` on the default `claude-opus-4-7` model. (#199)
- **Frontmatter detection on Windows CRLF files.** Files checked out with `core.autocrlf=true` are now correctly detected as Tracker items, automations, and other frontmatter-typed documents. (#68)
- **Ctrl+= zoom on Windows and Linux.** Pressing `Ctrl+=` (without Shift) now zooms in; numpad `+`/`-` and `Shift+=` also work. (#205)
- **Honor `.gitignore` in nested git repos.** Workspaces containing nested git repos no longer OOM the main process by walking into ignored directories of the nested repo. (#207)
- **Git status for files in nested repos.** Files committed inside a nested git repo no longer report as untracked indefinitely. (#122)
- **Custom Claude Code binary path.** The Claude Code path setting in AI Models is now read correctly instead of always falling back to the bundled SDK binary. (#162)
- **Auto-update error spam suppressed on hourly polls.** Transient network errors (`net::ERR_NAME_NOT_RESOLVED`, timeouts, refused connections) during the hourly auto-update check no longer pop a toast; manual "Check for Updates" still surfaces errors and download errors still surface mid-download. (#56)
- **Restore open workspaces after auto-update relaunch.** "Restart and Install" no longer leaves the app with zero workspaces open. (#232)
- **Environment Variables setting restored to user scope.** The panel reads/writes the global `~/.claude/settings.json`, so it no longer appears under the Project tab where it implied workspace-scoped state. (#185)
- **Delete file errors surface to the UI.** When a file delete fails (e.g. non-writable trash folder on Linux), the file tree now opens an error dialog with the OS-level reason instead of silently logging. (#195)
- **Commit proposal widget improvements.**
  - Failures now render an actual error state with the reason; previously every failure (hook rejection, no staged changes, IPC throws) was collapsed into "cancelled". (#202)
  - The commit proposal widget reliably appears in the transcript instead of waiting for the user to cancel. (#265)
  - Deleted files are now staged alongside additions and modifications in commit proposals.
  - Files in the commit proposal are sorted alphabetically within each directory, with subdirectories grouped. (#233)
- **Open tabs are no longer lost when switching tasks/sessions/files.** A race where the saved tab list was overwritten with an empty list before workspace state had hydrated is fixed. (#169)
- **Cross-window session pollution stopped.** Streaming sessions in one window no longer produce `Rejecting session ... belongs to /A, not /B` warnings in sibling windows.
- **Stream-closed errors during long Claude Code turns reduced.** The SDK stdin now stays open across late tool permission requests on multi-result turns (e.g. compaction). (#160)
- **Default Claude OAuth subscription traffic.** Fresh installs now classify Pro and Max OAuth traffic correctly so it is not silently deprioritized by Anthropic's backend. (#174)
- **Show platform-correct keyboard shortcuts. Windows and Linux now show Ctrl+... shortcuts instead of macOS glyphs across menus and the Keyboard Shortcuts dialog. (#149)**
- **Paste-as-Text is reliable and discoverable.** `Cmd/Ctrl+Shift+V` detection is normalized in the AI input and the shortcut is listed in the Keyboard Shortcuts dialog.
- **Voice mic stays open after each turn.** The 15-second listen window now starts when audio playback drains in your speakers (not when the server finishes streaming); function-call-only turns also wake the mic; a short readiness cue plays when the mic wakes with no audible reply.
- **`tracker_create` no longer auto-links the calling AI session.** Agents must pass `linkSession: true` (or call `tracker_link_session` afterward), so sessions don't accumulate unrelated tracker items.
- **Pasting images on Windows.** Pasting an image into a markdown document on Windows no longer fails with a `nim-asset` 403 due to mixed path separators.
- **Markdown round-trip fidelity.**
  - Triple-nested emphasis (e.g. `~~strike *italic **bold** text* inside~~`) is preserved on export.
  - Bold spans containing inline code stay intact through approve-all diff round-trips.
  - Sub-bullet diffs with auto-linked URLs no longer duplicate or orphan rows.
- **Inline diff readability.** Near-complete paragraph rewrites fall back to a block-level diff instead of interleaving red/green word fragments; identical opening or closing sentences are peeled off the diff.
- **Editor refreshes on AI edits even when the pre-edit event outruns the disk write.** Tabs no longer freeze on the pre-edit content while disk has the new bytes.
- **Restoring from history on a gitignored file.** The editor no longer shows stale content until you reopen the tab.
- **Agent-mode conflict dialogs.** The dialog caps at viewport height with an internal scroll so header and Close/Resolve buttons stay reachable on short viewports; the dialog also widens to fit conflict file lists.
- **Read-only Codex bash commands no longer attribute as edits.** A read-only `sed -n` or `cat` on a file with uncommitted modifications no longer produces a phantom "edited" row.
- **Lazy HEIC decoder.** Standard PNG/JPEG image attachments no longer pay the HEIC wasm startup cost; HEIC is only decoded when actually needed.
- **Tracker items from automation files appear on the board.** Files using `automationStatus` frontmatter now show as Tracker rows. (#67)
- **Legacy plan and decision tracker docs appear on the board.** Files saved with the older top-level `planStatus` / `decisionStatus` frontmatter are restored to the Tracker view.
- **Tracker "+ Launch Session" uses the workspace's default provider.** Codex-only installs no longer hit "Provider claude-code is not enabled for this workspace". (#176)
- **Built-in editor file types in extension AI tools.** Filesystem-only tools (e.g. automations) no longer fail with "No custom editor registered..." when invoked against a built-in editor's file (e.g. a `.md` file owned by Lexical). (#217)
- **Sub-session renames live-update.** Renaming a sub-session via right-click updates its title immediately; workstream parent rows also gain inline rename support. (#211)
- **Stable left-pane child counts.** Adding a child session (e.g. from `/launch-new-session`) reveals the new child in the workstream tree without a manual disclosure toggle.
- **Codex sessions show child output in meta-agent results.** `get_session_result` now extracts `lastResponse`, `recentMessages`, `userPrompts`, and `originalPrompt` for Codex sessions, not just Claude.
- **iOS transcript renders late-turn Codex tool calls.** Cross-turn Codex item id reuse no longer drops tool calls; Codex and ACP/Copilot CLI providers now route through their own parsers on mobile.
- **Shared mockup viewer rendering.** Standalone shared mockup pages bundle the right styles and no longer crash; mockup diff review is re-enabled for `.mockup.html` editors.
- **Walkthrough callouts.** Wide callouts no longer overflow the viewport edge or point past their target.
- **Claude session imports with workspace paths containing spaces or special characters.** The import path now matches Claude Code's path encoder, so sessions resolve to the right on-disk directory. (#170)
