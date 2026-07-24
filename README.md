# Nimbalyst is the visual workspace for building with Codex and Claude Code

[Nimbalyst](https://nimbalyst.com) is a free, open-source, local, interactive visual editor & session/task manager for developers, product managers, designers, builders. 
- Maximize speed, bandwidth, and context with Codex, Claude Code, Opencode (alpha), Copilot (alpha) by collaborating visually on integrated files, sessions, and tasks
- Iterate visually with coding agents in your markdown, mockups, diagrams, csv, Excalidraw, data models, and code. Approve the coding agent's changes in red/green WYSIWYG, edit, annotate.
- Manage multiple sessions in parallel and in kanban. Search, resume, link sessions to files and files to sessions. For developers we include git management, AI commit, workstreams, worktrees, and terminal.
- Manage tasks. Keep track of your plans, bugs, todos, etc. Have the agent edit tasks and items, add them, move them, and execute them. Humans see and edit this as well.
- Extend Nimbalyst. Build your own custom editors and visual interfaces integrated with the rest of Nimbalyst and your agents.
- Mobile app. Start, manage, and respond to your Codex and Claude Code sessions while on the go.

![Version](https://img.shields.io/github/v/release/nimbalyst/nimbalyst)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

https://github.com/user-attachments/assets/bfd89552-61f4-4db1-8301-cc2495423b89

## Features
**Visual Editors:** Built-in WYSIWYG editors where you and your coding agents collaborate visually. Approve agent changes as red/green diffs, edit, annotate, and iterate.
- Markdown
- Mockups with annotations
- Mermaid
- Excalidraw
- CSV
- Data Models
- Code with Monaco

![Nimbalyst files and editors](./.github/assets/nimbalyst-hero-files-dev-dark.png)

**Session Management:** Manage coding agents' work across parallel sessions in a UI
- Link sessions to files and files to sessions
- Open files in your sessions. Group files touched by a session
- Run parallel sessions
- Search and resume sessions
- Manage in a Kanban board

![Nimbalyst session kanban](./.github/assets/sessions-kanban-dark.webp)

**Task Tracking:** Keep track of your plans, bugs, features, todos etc.
- Have the agent edit tasks, add them, move them, and execute them
- Humans view and edit them too

**For Developers**
- Manage git state
- Use AI to git commit
- Use the embedded ghostty terminal
- Leverage worktrees

![Nimbalyst developer view](./.github/assets/developers-dark.webp)

**Mobile App**
- Session dashboard: see which agents need you and which are still working
- Reply to questions via text or voice, agents resume immediately
- Visual diff review: swipe through changes, tap to approve
- Queue next tasks: keep the pipeline full, don't let agents sit idle
- Push notifications: agents tell you when they need you

**Open** storage of content and status in markdown, workflow in slash commands, and plain files on disk or in git.

**Extension System**
- Pluggable editors for any file type. Every editor (including built-ins) goes through the same `EditorHost` contract, so custom editors are first-class.
- Current extensions include an Astro website editor, visual git log, mindmap, slides, and a 3D object editor.

![Nimbalyst extension marketplace](./.github/assets/extension-marketplace-dark.png)

**Supported Coding Agents**
- Codex
- Claude Code
- Opencode (alpha)
- Copilot (alpha)

## Download

Download the latest version for your platform:

| Platform | Download | Requirements |
| --- | --- | --- |
| macOS Apple Silicon | [Download .dmg](https://github.com/Nimbalyst/nimbalyst/releases/latest/download/Nimbalyst-macOS-arm64.dmg) | macOS Apple Silicon 12+ |
| macOS Intel | [Download .dmg](https://github.com/Nimbalyst/nimbalyst/releases/latest/download/Nimbalyst-macOS-x64.dmg) | macOS Intel 12+ |
| Windows | [Download .exe](https://github.com/Nimbalyst/nimbalyst/releases/latest/download/Nimbalyst-Windows.exe) | Windows 10+ |
| Linux | [Download AppImage](https://github.com/Nimbalyst/nimbalyst/releases/latest/download/Nimbalyst-Linux.AppImage) | Linux |

## Getting Started

1. **Create or open a document** — click "New" or press `Cmd/Ctrl+N`
2. **Write in markdown** — write/edit in the WYSIWYG editor
3. **Use the AI assistant** — ask AI to research, edit the document, work across your files
4. **Accept/reject AI changes** — step through suggested AI edits and accept or reject
5. **Work in Agent Manager** — switch to the agent manager view and run multiple agent sessions in parallel
6. **Search/resume sessions** — search and resume sessions, manage your work

## Auto-Updates

Nimbalyst automatically checks for updates and notifies you when a new version is available. You can also manually check via Help → Check for Updates.

By default, fresh installs are on the **stable** release channel and only receive promoted releases. If you want early-access builds, switch to the **alpha** channel under **Settings → Advanced → Release Channel**. Alpha builds are rougher and may break; revert to stable any time.

## Telemetry

Nimbalyst sends **anonymous usage analytics** to PostHog so we can understand how the app is used and prioritize improvements. We never collect:

- Usernames, emails, or IP addresses (no PII)
- File contents or file paths (categorized buckets only)
- API keys or authentication tokens
- Document, session, or chat content

A randomly-generated anonymous ID is used to correlate events from the same install. You can opt out at any time in **Settings → Advanced → Analytics**.

For the complete list of every event we send and its properties, see [POSTHOG_EVENTS.md](./docs/POSTHOG_EVENTS.md). For the privacy rules our analytics code follows, see [ANALYTICS_GUIDE.md](./docs/ANALYTICS_GUIDE.md).

## Building from Source

Nimbalyst is a TypeScript / Electron monorepo using npm workspaces.

```bash
# Install dependencies (npm 7+ required)
npm install

# Start the Electron app in dev mode
cd packages/electron && npm run dev

# Build a local Mac binary
cd packages/electron && npm run build:mac:local
```

Major workspaces:

- `packages/ios` — Native iOS app (SwiftUI)
- `packages/electron` — Desktop application (Electron)
- `packages/runtime` — Cross-platform runtime services (AI, sync, Lexical editor)
- `packages/collab-protocol` — Wire-format types for the collaboration sync protocol (shared with the sync server)
- `packages/extension-sdk` — Extension development kit
- `packages/extensions` — Built-in extensions

The collaboration sync server (talked to at `wss://sync.nimbalyst.com`) is a separate project.

For deeper architecture and contributor guidance, see [CLAUDE.md](./CLAUDE.md) and the docs under [`docs/`](./docs). For contribution rules and the DCO sign-off requirement, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Community

- [Documentation](https://docs.nimbalyst.com/) — watch videos and read the docs
- [Discord](https://discord.gg/FgD9S2MCYB) — join the discussion
- [Website](https://nimbalyst.com) — learn more about Nimbalyst

## License

- This repository is licensed under the **MIT License** — see [LICENSE](./LICENSE).
- The collaboration sync server (the Cloudflare Worker that powers `wss://sync.nimbalyst.com`) is a separate project. Clients in this repo talk to it over the wire protocol defined in [`packages/collab-protocol/`](./packages/collab-protocol/).
- For licensing context and contact information, see [LICENSING.md](./LICENSING.md).

## Contributing

- 💡 **Have a vague idea or question?** → [Join the discussion](https://github.com/Nimbalyst/nimbalyst/discussions)
- 🐛 **Found a bug?** → Report it in-app with **Send Feedback** (left rail or Help menu). Your agent helps draft the report, and you approve everything before it goes to GitHub.
- 🗺️ **Curious what we're building?** → [See the roadmap](https://github.com/orgs/Nimbalyst/projects/4/views/1)
- 🤝 **Want to help with roadmap work?** → [Community view](https://github.com/orgs/Nimbalyst/projects/4/views/2)
- ✨ **Have a concrete feature request?** → Send it in-app with **Send Feedback** (left rail or Help menu) and your agent will help draft it.
- 🌱 **Looking for a smaller place to start?** → [Good first issues](https://github.com/orgs/Nimbalyst/projects/4/views/4)

We rank features and bugs by 👍 reactions. Don't comment "+1" — react with 👍 instead.
[Sort issues by reactions →](https://github.com/Nimbalyst/nimbalyst/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc)

## Acknowledgments

Built with:
- [Electron](https://electronjs.org/)
- [Lexical](https://lexical.dev/) by Meta
- [React](https://reactjs.org/)
- [Monaco Editor](https://microsoft.github.io/monaco-editor/)
- [Excalidraw](https://excalidraw.com/)
