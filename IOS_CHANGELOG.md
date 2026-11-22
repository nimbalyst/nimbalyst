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

## [1.3.0] - 2026-10-19


### Added
- Wiki tab for projects with a Local wiki: page tree by title and order, in-app links between pages, read-only typed fields and table rows, and editable page bodies that keep frontmatter byte for byte (requires an updated desktop syncing the project)
- Team tab (alpha) for team projects: hosts the web console's Wiki and Trackers in the app, signed in from the phone's account; console links from Mail, Messages, the transcript and `nimbalyst://console` open in the app
- Synced Markdown shows embedded `.html` diagrams live; project sync now carries `.html` files
- Copy diagnostics (versions and recent sync errors, no session content) from Settings, the "Couldn't load sessions" screen and the sync error banner
- Sessions from desktop projects not synced to mobile show "Transcript not synced" with where to turn it on, instead of "Thinking..."

### Changed
- Wide document tables scroll sideways with the first column pinned, and show rows as cards on phone-width screens
- Computer picker lists only computers seen in the last week and hides when there is one
- Phone transcript rows sync inline instead of in chunks; only bulky tool output is shortened for mobile sync
- Per-page sync logging quieted

### Fixed
- Long assistant replies and question forms disappearing from the transcript
- Images shown with `display_to_user` appearing broken in the transcript
- Session list failing with "Couldn't load sessions" on iPhones with an older system SQLite; a database read failure now shows an error instead of an empty list
- Opening a session failing with "bad response from the server" after the sign-in token expired during reconnect
- "Sign in again" banner taking minutes to appear when sign-in refresh keeps failing
- A "different sync key" notice that re-pairing could not clear
- A prompt sent from the desktop staying in the phone's input box
- Sessions that finished while the desktop was disconnected staying marked as running
- Removing a project's last slash command or action prompt on the desktop not removing it on the phone
- Swipe from the left edge of the session list not returning to the project list
- Hidden landscape sidebar on iPhone reappearing after rotation or relaunch

## [1.2.1] - 2026-10-07


### Added
- Live voice: reach and answer questions for sessions started on the desktop, choose audio input/output devices, and use computer inventory controls
- Orchestrators and their workers appear as nested session trees
- Session model shown in the session detail status bar
- Remote sandbox sessions run with the shared composer
- More compact session list and header

### Changed
- Computer switching moved to the status button
- Reconnecting is quiet, and the transcript reloads after the app returns from the background

### Fixed
- App hanging on the launch screen
- Sync failures are now visible, and newer local state is preserved
- Newly created and mobile-created sessions load without reopening; creation failures are reported
- Consumed prompts no longer reappear in the queue
- False prompt delivery warnings
- Session search and history sync restored
- Sessions refresh after returning from the background
- Session list stalls and flashing during updates; desktop sessions stay listed while reconnecting
- Duplicate and out-of-order session messages
- iPhone fleet Live Activity recovers after reconnecting and after a card ends
- Session sidebar stays visible after rotation
- Transcript scrolls to the first message
- "Sync interrupted" notice clears on reconnect
- Session errors dismiss safely
- Live voice context and session loading
- Personal sync keeps publishing past index rows written under another key
- Reduced database contention during session sync

### Removed
<!-- Removed features go here -->

## [1.2.0] - 2026-09-09


### Added
- A Live Activity on the Lock Screen and in the Dynamic Island shows what your session fleet is doing, ranks the sessions waiting on you, and opens one when you tap it; turn it off in Settings.
- Answer desktop action prompts (permission requests, plan approvals, questions) from the mobile composer.
- Create and follow Meta Agent sessions from iOS, with child sessions grouped under their parent.
- Sign in to multiple accounts, with team rooms, direct messages, and team notifications.
- Claude Opus 5, GPT-5.6, Gemini, Grok Build, and Cursor Agent.
- Mobile voice agent can open new sessions, manage existing sessions, and surface and answer a session's pending prompts
- Voice mode shows live tool-call activity while the agent works
- Memory recall and search results render as transcript cards
- Live tracker reference links in transcripts

### Changed
- The session list loads from a persistent cache and pages in older sessions, so it opens fast and stops reshuffling mid-turn.
- Start a voice session from a session list, and voice replies are terser.
- Voice mode is pausable and stoppable from the floating mic
- Unified iOS voice onto the gpt-realtime model
- Session transcript images are zoomable, uncropped, and copyable
- More file paths and links in transcripts are tappable

### Fixed
- Large projects load, and interrupted file syncs resume.
- Notifications reach the right phone and open the session they name.
- Sessions survive layout changes and no longer open on another session's transcript.
- Desktop screenshots render in the mobile transcript again.
- Pairing links open the in-app scanner, and false "re-pair required" warnings are gone.
- Sign-in failures are reported instead of failing silently.
- Sync resilience after network changes, sleep, token refresh, and account switching.
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
