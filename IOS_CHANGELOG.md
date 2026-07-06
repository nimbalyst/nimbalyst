# iOS Changelog

All notable changes to the Nimbalyst iOS app will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]

### Added
<!-- New features go here -->

### Changed
<!-- Changes to existing functionality go here -->

### Fixed
<!-- Bug fixes go here -->

### Removed
<!-- Removed features go here -->

## [1.2.0] - 2026-07-03


### Added
- Mobile voice agent can open new sessions, manage existing sessions, and surface and answer a session's pending prompts
- Voice mode shows live tool-call activity while the agent works
- Memory recall and search results render as transcript cards
- Live tracker reference links in transcripts
- Create a Meta Agent from iOS (alpha-gated, synced from desktop)

### Changed
- Voice mode is pausable and stoppable from the floating mic
- Unified iOS voice onto the gpt-realtime model
- Session transcript images are zoomable, uncropped, and copyable
- More file paths and links in transcripts are tappable

### Fixed
- Voice mode no longer interrupts itself when speakers are open
- Fixed garbled and clicking voice audio on iOS
- Fixed iOS audio after waking from sleep
- Voice agent language now stays pinned to the selected language
- Restored voice mode after OpenAI retired the Realtime Beta API
- Voice agent summarizes a session by id rather than its title
- Newly created docs and their transcript links now sync to mobile
- Self-heal a stale personal sync identity that blocked personal sync
- Preserve nimbalyst:// tracker reference URNs so links no longer render blank
- Stop syncing redundant Claude Code raw-log and system/init data to mobile transcripts

## [1.1.1] - 2026-06-03

Reliability and responsiveness improvements for following and controlling desktop AI sessions from iPhone and iPad.

### Added
- Structured agent prompts now render on iOS for richer review and approval flows

### Changed
- Session transcripts stay live and visible during active AI turns
- Session back navigation feels smoother and more reliable
- Switching back to a recent session now feels instant

### Fixed
- Later-turn Codex tool calls now render correctly in transcripts
- Codex app-server transport sessions now display messages correctly
- Session archive state now syncs correctly from desktop to iOS
- Duplicate session titles no longer appear after sync
- Broken desktop auth discovery now recovers cleanly instead of silently stalling mobile sync
- Git commit proposal cancellation now completes correctly from iOS
- Synced drafts no longer jumble the compose input while you type

## [1.1.0] - 2026-04-29

First public App Store release since 1.0. The 1.0.1 draft was never shipped; its changes are folded into 1.1.0.

### Added
- Real-time E2E encrypted personal document sync
- Bidirectional draft sync and queued prompts between desktop and iOS
- Hierarchical session navigation with worktree and workstream sync
- Cancel button for running AI sessions
- AI model picker on iOS for picking what model new sessions will use
- Slash command typeahead and image attachments in compose bar
- Push notifications, with permission prompt after pairing
- QR code deep-linking opens Nimbalyst when scanned with the Camera app
- Jump-to-prompt sheet, clickable links, and tap-to-copy code blocks in transcripts

### Changed
- Voice playback routed through VPIO bus 0 for proper echo cancellation
- iPad layout polish: Files tab in sidebar, denser session list, single-tap session creation

### Fixed
- Transcript blank screen from React hooks ordering violation in WKWebView
- Voice mode crash on audio capture start
- Background SQLite crash from full index sync on every reconnect
- Sync resilience after network change, sleep, JWT refresh, and org switching
- Draft text jumbling, character loss, and bounce-back during fast typing
- Sessions failing to reorder when viewed; read state now syncs both ways
- QR scanner reliability in release builds
