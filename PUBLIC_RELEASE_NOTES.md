# Nimbalyst v0.61.1

### New Features

- **Inline file embeds in markdown.** Use @ reference to embed Excalidraw, mockup, datamodel, CSV, and SQLite editors directly inside markdown documents.
- **Programmable AI action prompts.** Define reusable prompt presets per workspace and invoke them from the AI composer, including actions that launch a new sibling session.
- **LaTeX math in the document editor.** Inline and block math with double-click to edit, plus matching math rendering in the agent transcript.
- **Codex moved to the app-server transport** for improved file-edit hooks and unified-diff capture.
- **Tag filter for the sessions list.**
- **Clear-all-unread action in the system tray.**

### Improvements

- AI transcript  performance and selection improvements.
- Large markdown files no longer hang the renderer mid-AI-edit.
- Heavy tool-call streams no longer hang the renderer.
- Pasted Google-Docs-style images stored as assets instead of inline base64.
- Codex thread/resume preserves MCP servers, sandbox, approval policy, instructions, model, and reasoning effort.
- Codex chat attachments preserved in prompts and transcript across SDK and ACP sessions.
- Human-readable error widget for upstream Claude API 5xx errors.
- Long multi-line git errors stay a single line with View / Copy buttons.

### Fixed

- Pre-approved tools in the global Claude allow list bypass the permission dialog as intended. (#152)
- "Allow this tool?" permission dialog no longer gets stuck with no buttons. (#276)
- Auto-update on macOS no longer fails with "command is disabled" after download. (#245)
- Auto-update toast no longer fires on transient DNS failures. (#387)
- CommonMark angle-bracket inline links render as clickable hyperlinks. (#86)
- OpenCode test-connection finds the `opencode` binary under nvm / asdf / Volta / fnm. (#184)
- OpenCode model picker finds `opencode.json` on Windows. (#284)
- Copilot ACP retains context between turns. (#251)
- Copilot CLI resolves from `%APPDATA%\npm` on packaged Windows.
- Right-click Archive surfaces backend rejections instead of failing silently. (#282)
- Pressing Enter at end of a tracker-item line on the last line of the file inserts a new paragraph. (#263)
- Enter at end of a list item ending with inline-code-plus-space no longer keeps the new bullet in inline-code format. (#302)
- Cmd+O Quick Open and @-mention picker scope "recent files" to the current workspace. (#301, #304)
- Find-in-page search bar no longer hides behind the session-phase pill on narrow widths. (#309)
- CSV editor no longer truncates `YYYY-MM-DD` date cells. (#329)
- CSV editor currency / percent / number column formats render correctly. (#329)
- AI-edit review diff preserved in CSV and datamodel custom editors. (#328)
- Crash-on-load on markdown files with extremely wide table rows is gone. (#321)
- Chat-attached text files reach the agent instead of degrading to a `@filename` token. (#239)
- Claude usage indicator no longer hidden on Windows / Linux. (#362)
- Claude Code permission stream no longer dies on sessions with many tracker tasks. (#320)
- Detached HEAD state handled in the git extension.
- Git views refresh after `.gitignore` edits.
- Git commit failures surface instead of reporting fake success. (#202)
- Drag-and-drop into AI input inserts `[name](/absolute/path)` markdown links.
- Drag-drop from Finder/Dock into folders restored. (#206)
- Codex usage indicator no longer sticks at a stale percentage after the 5h / 7d window resets. (#120)
- Imported sessions show the model actually used instead of always Sonnet. (#394)
- Bug-report anonymizer scrubs workspace paths and Windows path-form variants. (#396)
- External session edits excluded from git staging. (#398)
- Floating menus use proper portals so they stay visible instead of clipping inside panels.
- Unsaved tab edits survive file renames. (#367)
- Onboarding mode-picker no longer beach-balls on cold start. (#260)
- PGLite lock self-heals on Windows after PID reuse. (#272)
- PGLite worker `init` allows 120s so the first relaunch after a force-close doesn't fail while WAL recovery is in progress. (#238)
- Database lock dialog no longer false-positives on fresh-timestamp / ambiguous locks; force-unlock path restored.
- `claude-code` no longer shadows OAuth login with empty `ANTHROPIC_API_KEY`.
