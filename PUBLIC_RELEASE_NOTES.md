# Nimbalyst v0.63.9

### Improvements

- **Claude Opus 4.8 is available and the default for new Claude sessions.**
- **AI session performance is better under load -** Streaming transcripts, background widgets, search, and long-running sessions put less pressure on the renderer, database and sync pipeline.
- **Unified Quick Open -** Files, Sessions, Prompts, Projects, and Trackers now live in one tabbed launcher with better filters.
- **Calc Sheets -** New `.calc.md` documents combine spreadsheet-style results with plain-text editing, units, currency handling, and assertions.
- **Opt-in SQLite migration preview -** You can dry-run a move off PGLite, inspect validation results, and keep a rollback backup before switching.
- **More contextual guidance -** Empty AI sessions and core surfaces now surface contextual tips for worktrees, trackers, shortcuts, themes, shared docs, mobile pairing, and more.
- **Auto-update is quieter and cleaner -** Downloads now happen in the background, and mid-publish metadata gaps no longer throw a scary raw 404 toast.
- **Worktree AI flows are smoother -** Worktree sessions now support manual vs smart commit mode, Commit with AI, and easier worktree-specific session search with `#worktree`.
- **Startup and large-workspace responsiveness improved -** Shared-tracker startup, prompt search, quick open, and other heavy paths do less blocking work.

### Fixed

- AI edits to large markdown files with inline base64 images no longer trigger multi-minute beachballs.
- Tool calls no longer get stuck at "running" when multiple AI sessions are open.
- Parent workstream sessions now bubble up correctly when child sessions become active.
- New Worktree no longer stays disabled because of early git-probe races.
- Session history no longer pegs the renderer during heavy AI streaming.
- Theme readability issues were cleaned up across light and dark themes, including Calc Sheets error rows and primary-button label contrast.