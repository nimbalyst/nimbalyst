# June 15 Release

### New Features

- **Integrated Claude Code in embedded terminal sessions with your Claude Pro/Max subscription** - Use Claude Code in an embedded terminal with your pro/max subscription, while Nimbalyst also layers in session monitoring to support additional Nimbalyst features on top.
- **Claude Fable 5** added support, but currently does not work do to government restrictions.
- **Built-in PR review mode** (Cmd/Ctrl+U): browse, filter, diff, comment on, and approve/merge PRs using your existing `gh` login — or open a PR into a worktree with an agent session.
- **Browser tabs for HTML preview** (Cmd+Shift+B), plus browser tools that agents can drive.
- **Auto session mode for Claude Code**: safe actions run silently and only uncertain ones prompt, when workspace trust is set to "Allow All" and run AI classifier is enabled.
- Quick Open's Sessions tab can now search session contents.
- More support for clickable file paths in AI transcripts.
- Refresh button in the Files Mode sidebar header.

### Fixed

- Effort selector not always working.
- Voice mode connects again after OpenAI retired the Realtime Beta API (desktop and iOS).
- "Allow All" permission mode auto-approves everything again; the Claude Code safety classifier is now opt-in per project.
- No more Electron crash when a worktree produces a filesystem-event storm.
- Fixed the whole app freezing permanently after closing a terminal that had rendered emoji output.
- Auto-commit retries when another git process briefly holds the index lock, so concurrent sessions commit on the first try.
- In Multi-Project mode, a project's tracker list no longer shows another open project's items.
- Docs a session just created sync to mobile immediately, and their transcript links wait for the doc to sync instead of dead-ending.
- Renaming or moving a project no longer fails and rolls back on sqlite.
- Quick Open remembers your filter selections, and file-mask filters return matching results.
- The chat box no longer leaks keystrokes into a file an agent is editing.
- Session images can be copied; transcript images are zoomable, uncropped, and persist across reloads.
- Local markdown links open correctly, resolving relative paths from the current document.
- HTML preview renders again instead of a blank pane, and in-workspace files on Windows are no longer rejected over drive-letter casing.