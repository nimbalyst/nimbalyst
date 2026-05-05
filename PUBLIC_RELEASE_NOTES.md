# Nimbalyst v0.58.21

This release covers everything since v0.58.14: live kanban peek transcripts, Claude Code 2.1.x session import, theme contributions from extensions, AI chat undo/redo, granular diffs, and a substantial security hardening pass on the desktop app.

### New Features

- **Import Claude Code 2.1.x sessions.** Available from the File menu, with full support for subagents, extended-thinking blocks, follow-up prompts, and inlined long tool results.
- **Live kanban peek transcripts.** Hover a running session card and watch the transcript stream in real time instead of waiting for the turn to finish.
- **Extension-contributed themes.** Extensions can register themes via `contributions.themes`. They appear in Settings > Themes under "Extension Themes" and in the gutter theme popup, with a graceful fallback when an extension is disabled.
- **Spawn sibling AI sessions.** Agents can launch sibling sessions via `/launch-new-session`, sharing files-edited, tabs, and workstream overview with the parent.
- **Full undo/redo for AI chat input.** Cmd+Z / Cmd+Shift+Z restore the complete state -- text, attachments, cursor, and prompt history navigation -- across image pastes, large-text pastes, drag-drops, mention insertions, and force-pastes.
- **Diff peek in Agent mode.** Hover-revealed peek icon on Files Edited rows opens an inline unified diff popover anchored to the row.
- **File history dialog in Agent mode.** Cmd+Y now opens history for the active file in Agent mode, not just Files mode.
- **`xhigh`**** effort level for Claude Code.** Matches the CLI's full five-level slider (low / medium / high / xhigh / max).

### Improvements

- **Streaming transcripts coalesce live.** Streaming assistant messages now merge into a single canonical event as tokens arrive, so the kanban peek shows real recent context instead of just the last few tokens of long turns.
- **Security hardening.** Improved internal MCP with local token auth
- **CVE patches.** Updated `lodash-es` for a security advisory.
- **Auto-naming sessions is more reliable.** Extra check for agent session naming and tagging, so sessions land on the kanban board with the right metadata even when the agent doesn't volunteer it.

### Fixed

- **Concurrent tab edits no longer clobber each other.** Built-in editor saves route through diff resolution so an edit in one tab no longer silently overwrites concurrent changes in another.
- **Granular AI diffs.** Word-by-word LCS-based diffs no longer flash entire bullets or paragraphs as red+green when only a small span actually changed; pure-formatting changes mark only the re-formatted span.
- **Table diffs show row add/remove and in-cell content changes.** Modified cells show the original content as removed and the new content as added, instead of silently overwriting.
- **Reduced renderer freeze on long Claude Code streams.** Transcripts re-render at most once per animation frame regardless of token rate, helping reduce multi-minute hangs and OOM on long sessions.
- **Custom Claude Installation override is now per-workspace.** Project values no longer leak into the User scope or other projects.
- **Worktree workspaces inherit Claude path overrides** from their parent project.
- **Codex ACP stays stable on longer sessions.** Bounded the stderr buffer so multi-hour sessions no longer crash the main process with OOM.
- **Git status reads no longer wait 15+ seconds.** Read-only `git:status` and `git:working-changes` skip the index lock that was queueing behind concurrent writes.
- **File tree refreshes for gitignored folders** when an agent creates `temp/`, `nimbalyst-local/`, or similar paths.
- **OpenCode receives paste attachments.** Pasted text and images now actually reach the model instead of showing up as phantom `@filename` references.
- **Multi-file Codex ACP \****`apply_patch`**\*\* tracks every file**, not just the first.
- **Context menus stop flashing at 0,0** before positioning.
- **Workstream UI refreshes** when a sibling session spawns -- no manual toggle.
- **Workstream and worktree kanban peeks** show the child session's transcript instead of "No messages yet."
- **Custom editors load for compound file extensions** like `*.reddit.watch.json`.
- **Workspace-relative paths resolve** in the `workspace:open-file` IPC, fixing the git diff peek "Open in editor" link.
- **Duplicate rows collapse in the Files Edited tree.** Relative and absolute paths for the same file now dedup correctly.
- **Cross-timezone date comparisons** work correctly across TIMESTAMPTZ stores.
- **OpenCode installation instructions** now correctly points at `opencode-ai`.
