# Nimbalyst v0.59.2

Inline red/green diff cards for Codex edits, performance and stability fixes for long Claude Code sessions, and a fix for losing your open file tabs when switching tasks.

### Improvements

- **Inline edit cards for Codex `file_change`** -- render as red/green diff cards in the transcript, including for new and gitignored files.
- **Finish timestamps on completed turns**, with full prior-day dates when relevant.
- **Faster, more stable AI message logging** -- coalesced writes cut p95 lock time from ~330ms to ~1ms during long Claude Code turns and stop intermittent "Stream closed" errors. (#163)
- **Bounded PGLite WAL growth** -- periodic checkpoints stop the database from accumulating unbounded WAL across launches and freezing on startup.
- **Single-flight session refresh** -- cold-start no longer fires concurrent `/auth/refresh` requests that race for the single-use token and stall the UI.
- **Bundled Codex updated to 0.128.0**
- **Faster image attachments** -- PNG/JPEG skip the HEIC wasm decoder.
- **Voice agent can spawn coding sessions on demand** via a new MCP tool, automatically linked as the active session.
- **Markdown export to PDF includes title metadata and outlines** so exports are bookmarked correctly.

### Fixed

- **Open file tabs no longer disappear when switching tasks/sessions/files.** A hydration race could overwrite the saved tab list with an empty list during mount. (#169)
- **Codex edits attribute correctly for gitignored, never-snapshotted, or freshly-created files.** Proper red/green diffs instead of empty-baseline whole-file-green; per-change `add` / `update` / `delete` honored end-to-end.
- **Sub-bullet-with-link diffs render cleanly** -- no more 1-red + 2-green duplicates or orphaned `URL:` placeholders.
- **Word-level diffs no longer interleave red/green fragments on near-complete paragraph rewrites.** Falls back to block-level when most of the text changed.
- **Editor refreshes on AI edits when the pre-edit signal outruns the disk write.**
- **Settings > Claude Agent SDK reads the correct version** when the SDK is hoisted to the workspace root by npm dedup. (#60)
- **Stage deleted files in git commit proposals**, in both the widget and auto-commit paths.
- **Platform-correct keyboard shortcuts on Windows and Linux** -- Mac glyphs only on macOS. (#149)
- **No more cross-window session pollution** -- streaming activity in one window no longer triggers stale-session warnings in others.
- **Empty git repos open without a stack trace** in the log.
- **Meta-agent works inside git worktrees.** MCP-created sessions show up in the kanban; `spawn_session` no longer fails with "Parent session not found". (#157)
- **Claude Code stdin stays open** across late tool permission requests on multi-result turns. (#160)
- **Workstream UI reveals new child sessions immediately** without a manual disclosure toggle.
- **Auto-committed widgets stay visually committed** after auto-commit is later disabled, with a proper toggle checkbox.
- **Claude Code session import handles workspace paths with spaces, apostrophes, or accented characters**, and surfaces failures in the dialog. (#170)
- **Falls back to all Claude session imports** when the workspace-filtered scan returns nothing.
- **Meta-agent session history context menus restored**
- **Codex child session results populate correctly** (`lastResponse`, `recentMessages`, `originalPrompt`) for meta-agent children. (#145)
- **Meta-agent MCP tools work in Codex sessions.**
- **`@` mentions surface `nimbalyst-local` plans again.**
- **Child `session:completed` events only forward to the parent on terminal idle**, with proper turn-boundary dedup. (#142)
- **Walkthrough callouts no longer overflow the viewport edge** when marked wide.
