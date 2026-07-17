# July 10th 2026 Release
# 
### New Features

- **New AI models.** GPT-5.6 (Sol, Terra, and Luna) is available for the OpenAI and Codex agents, with Sol as the new default.
- **GLM 5.2 via OpenCode.** OpenCode presets now include GLM 5.2 through the Z.AI and Z.AI Coding Plan providers.

### Improvements

- New projects derive their tracker issue-key prefix from the project name instead of always using `NIM`.
- Tracker link chips in chat show more of the item title before truncating.

### Fixed

- Long Claude Code thinking phases no longer end early with a "no output for 120s" error.
- Editing a markdown file with em dashes or curly quotes no longer corrupts the text into `â` symbols or traps it in a reload loop.
- File links to paths with spaces (e.g. `My Project`) stay clickable in chat instead of breaking at the first space.
- Codex/ChatGPT sessions no longer reject Nimbalyst's own tools with "user rejected MCP tool call".
- Extension agent provider settings now save correctly instead of being discarded.
- Tracker reference popovers now follow the active theme instead of always rendering light.
- The Claude Usage popover shows the Claude provider icon instead of a generic layers icon.
- Codex tool results no longer appear as stray "message elided" warnings in iOS transcripts.
- Sidebar resize handles keep responding while dragged over a mockup preview.
- The bundled Codex runtime was updated so the Codex Chrome plugin can start in Nimbalyst.
