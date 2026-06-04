# June 3rd Release

### New Features

- **Claude Opus 4.8** is now available in the Claude provider with 1M context, and is the default model for new installs.
- **Claude Code Task List panel** — Claude Code sessions now show the agent's live task queue in the right sidebar, including status, owner, and blocked-by dependencies.

### Improvements

- Default Claude model upgraded to Opus 4.8 for new sessions. Existing sessions keep their configured model.
- Claude Code's opus-4-7 variants remain selectable for anyone who wants to stay on the previous model.
- "Commit with AI" now includes relevant related files in the commit proposal.

### Fixed

- Claude Code sessions selected on Opus 4.8 now actually run on 4.8.
- The AI Usage Report no longer crashes the app, and Claude Code session token totals are now reported accurately.
- Tracker tool widgets no longer crash.
- Commit proposal diff previews open at their normal size again instead of collapsing to a tiny popover.
- Quick Open file search no longer lags while typing.
- Terminal scrollback history is preserved even when output contains a stray NUL byte.
- Meta-agent child sessions now inherit the parent session's provider and model.
- The local `/clip` endpoint now rejects requests from arbitrary web pages.
