---
planStatus:
  planId: plan-native-ios-navigation
  title: Native iOS Navigation with Embedded Web Transcript
  status: completed
  planType: system-design
  priority: high
  owner: ghinkle
  stakeholders: []
  tags: [mobile, ios, swift, swiftui, navigation, architecture, sqlite, grdb]
  created: "2026-02-13"
  updated: "2026-02-15"
  progress: 100
---

# Native iOS Navigation with Embedded Web Transcript

## Problem Statement

The current Capacitor app is 100% web-based inside a single WKWebView. All navigation (project list, session list, session detail, settings) is handled by React Router with a custom `SwipeNavigation` component. This leads to:

- **Non-native navigation feel**: The custom swipe-back implementation (`SwipeNavigation.tsx`) is a poor approximation of `UINavigationController` - it only detects the first 30px of the left edge, uses a fixed pixel threshold, and has no interactive gesture with the underlying view peeking through.
- **No native transitions**: Screen transitions are instant CSS transforms, not the standard iOS push/pop animations with the parallax effect.
- **No native navigation bar**: Headers are hand-built HTML with inline SVG icons, not `UINavigationBar` with proper large title support, blur effects, and system styling.
- **No native pull-to-refresh**: Both `ProjectListScreen` and `SessionListScreen` implement custom pull-to-refresh with manual touch tracking - ~60 lines of JavaScript each vs. one line of `UIRefreshControl`.
- **No haptic feedback on navigation**: The standard iOS haptics on navigation transitions are missing.
- **Web overhead for simple list views**: Project list and session list are trivially simple screens (a title + a flat list of items with chevrons) that don't need React at all.
- **Cold start penalty**: Every app launch re-syncs all data from scratch over WebSocket. No local persistence means no offline viewing and slow startup.

## Architecture

Native Swift owns everything except the transcript renderer. Data lives in a local SQLite database, synced incrementally via WebSocket. The web layer is a pure renderer.

```
Native Swift Layer                        Web Layer (embedded WKWebView)
┌──────────────────────────────┐         ┌─────────────────────────────┐
│ SwiftUI App                  │         │ Transcript Renderer Only    │
│                              │         │                             │
│ ┌──────────────────────────┐ │         │ - AgentTranscriptPanel      │
│ │ SQLite Database (GRDB)   │ │         │ - AIInput composer          │
│ │ projects, sessions,      │ │         │ - Tool widgets (permissions,│
│ │ messages, sync_state,    │ │         │   code blocks, questions)   │
│ │ credentials              │ │         │ - Message rendering         │
│ └────────────┬─────────────┘ │         │                             │
│              │               │         │ Receives from native:       │
│ ┌────────────▼─────────────┐ │ bridge  │ - Decrypted messages (JSON) │
│ │ SyncManager              │◄├────────►│ - Session metadata          │
│ │ - URLSessionWebSocketTask│ │         │ - Theme / font config       │
│ │ - CryptoKit AES-GCM     │ │         │                             │
│ │ - Incremental sync       │ │         │ Sends to native:            │
│ │ - Index + Session rooms  │ │         │ - User prompts              │
│ └──────────────────────────┘ │         │ - Interactive responses     │
│                              │         │ - Haptic requests           │
│ SwiftUI Views:               │         │ - Voice mode requests       │
│ - NavigationStack            │         └─────────────────────────────┘
│   - ProjectListView          │
│   - SessionListView          │
│   - SessionDetailView        │
│     (native header +         │
│      embedded WKWebView)     │
│ - NavigationSplitView (iPad) │
│ - SettingsView               │
│ - VoiceControlView (TBD)     │
└──────────────────────────────┘
```

## SQLite Database Schema

Local persistence using GRDB.swift (Swift SQLite wrapper with Codable support, migrations, and observation).

```sql
-- Sync credentials and pairing state
CREATE TABLE credentials (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL  -- Keychain for encryption key, SQLite for non-sensitive config
);

-- Projects (workspace paths from desktop)
CREATE TABLE projects (
    id TEXT PRIMARY KEY,           -- workspace path
    name TEXT NOT NULL,            -- display name (last path component)
    session_count INTEGER DEFAULT 0,
    last_updated_at INTEGER,       -- unix timestamp
    sort_order INTEGER DEFAULT 0
);

-- Session index (synced from index room)
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title_encrypted TEXT,          -- still encrypted at rest
    title_iv TEXT,
    title_decrypted TEXT,          -- cached decrypted title for display
    provider TEXT,
    model TEXT,
    mode TEXT,                     -- 'agent' | 'planning'
    is_executing INTEGER DEFAULT 0,
    has_queued_prompts INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_synced_seq INTEGER DEFAULT 0,  -- for incremental message sync
    FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- Individual messages within sessions
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    sequence INTEGER NOT NULL,
    source TEXT NOT NULL,           -- 'user' | 'assistant' | 'tool' | 'system'
    direction TEXT NOT NULL,        -- 'input' | 'output'
    encrypted_content TEXT NOT NULL,
    iv TEXT NOT NULL,
    content_decrypted TEXT,         -- cached decrypted content
    metadata_json TEXT,             -- tool_name, has_attachments, content_length
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, sequence)
);

-- Sync watermarks for incremental sync
CREATE TABLE sync_state (
    room_id TEXT PRIMARY KEY,       -- 'index' or session ID
    last_cursor TEXT,
    last_sequence INTEGER DEFAULT 0,
    last_synced_at INTEGER
);

-- Queued prompts waiting to be sent to desktop
CREATE TABLE queued_prompts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    prompt_text_encrypted TEXT NOT NULL,
    iv TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sent_at INTEGER                 -- NULL until acknowledged by desktop
);

CREATE INDEX idx_messages_session_seq ON messages(session_id, sequence);
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
```

### Encryption at Rest

The encryption key (derived from QR pairing) is stored in the iOS Keychain (not SQLite). Decrypted content is cached in `title_decrypted` and `content_decrypted` columns for fast display. These cached columns are re-populated on app launch from the encrypted versions using the Keychain key. If the Keychain key is lost (device restore, etc.), the app re-pairs and re-syncs.

### Incremental Sync Flow

```
App Launch:
1. Read projects + sessions from SQLite -> display immediately in native lists
2. Connect WebSocket to index room
3. Send sync_request with last_cursor from sync_state
4. Server returns only new/changed sessions since cursor
5. Upsert into SQLite, update sync_state

Opening a Session:
1. Read cached messages from SQLite -> pass to web transcript immediately
2. Connect WebSocket to session room
3. Send sync_request with since_seq = sessions.last_synced_seq
4. Server returns only new messages since that sequence
5. Append to SQLite, forward decrypted messages to web transcript
6. Subsequent real-time messages: decrypt -> SQLite -> web transcript
```

## Native Sync Manager (Swift)

Replaces `CollabV3SyncContext.tsx` entirely. Key components:

### WebSocket Client
- `URLSessionWebSocketTask` for WebSocket connections
- Two concurrent connections: index room + active session room
- Automatic reconnection with exponential backoff
- Heartbeat/ping to detect stale connections

### Encryption (CryptoKit)
- `AES.GCM` for encrypt/decrypt (replaces `node-forge`)
- Key derivation from pairing seed using `PBKDF2` (CommonCrypto `CCKeyDerivationPBKDF`, 100k iterations, SHA-256)
- Decryption happens in native before storing or forwarding to web
- Actually cleaner than the JS implementation since CryptoKit is purpose-built

### Data Flow Manager
- Observes SQLite via GRDB's `ValueObservation` for reactive UI updates
- SwiftUI views automatically re-render when DB rows change
- No manual state management needed for lists

## Native-Web Bridge Protocol

Communication between Swift and the embedded transcript WKWebView:

### Swift -> JS (via `evaluateJavaScript`)

```typescript
// Load a session's messages into the transcript
window.nimbalyst.loadSession({
  sessionId: string,
  messages: DecryptedMessage[],  // full cached history from SQLite
  metadata: { title, provider, model, mode, isExecuting }
})

// Append a new real-time message
window.nimbalyst.appendMessage(message: DecryptedMessage)

// Update session metadata (title change, executing state change)
window.nimbalyst.updateMetadata(metadata: Partial<SessionMetadata>)

// Clear current session (navigating away)
window.nimbalyst.clearSession()

// Apply theme
window.nimbalyst.setTheme({ isDark: boolean, colors: Record<string, string> })
```

### JS -> Swift (via `WKScriptMessageHandler`)

```typescript
// User submitted a prompt
bridge.postMessage({ type: 'prompt', text: string, attachments?: [] })

// User responded to an interactive widget (permission, question)
bridge.postMessage({ type: 'interactive_response', promptId: string, response: unknown })

// Request haptic feedback
bridge.postMessage({ type: 'haptic', style: 'light' | 'medium' | 'heavy' })

// Request voice mode
bridge.postMessage({ type: 'open_voice', sessionId: string })

// Transcript scroll position (for state preservation)
bridge.postMessage({ type: 'scroll_position', offset: number })
```

## What Becomes Native SwiftUI

| Current Web Component | Native Replacement | Notes |
|---|---|---|
| `App.tsx` (React Router) | `NimbalystApp.swift` with `NavigationStack` | SwiftUI app lifecycle |
| `ProjectListScreen.tsx` | `ProjectListView.swift` | SwiftUI `List`, `.refreshable`, `NavigationLink` |
| `SessionListScreen.tsx` | `SessionListView.swift` | SwiftUI `List`, search, status badges |
| `SessionDetailScreen.tsx` header | `SessionDetailView.swift` header | Native nav bar with title, status, voice button |
| `SessionDetailScreen.tsx` transcript | **Stays web** (embedded WKWebView) | Receives decrypted messages from native |
| `SettingsScreen.tsx` | `SettingsView.swift` | Native forms, `AVCaptureSession` for QR |
| `SwipeNavigation.tsx` | Deleted (native `NavigationStack` handles this) | |
| `SplitView.tsx` | `NavigationSplitView` | iPad gets proper split view |
| `CollabV3SyncContext.tsx` | `SyncManager.swift` | WebSocket + CryptoKit + SQLite |
| `StytchAuthService.ts` | `AuthManager.swift` | `ASWebAuthenticationSession` for OAuth |
| `PushNotificationService.ts` | `NotificationManager.swift` | Native UNUserNotificationCenter |

## What Stays as Web

- `AgentTranscriptPanel` - message list with virtual scrolling
- `AIInput` - the composer with attachment support
- All tool widgets (permissions, questions, code blocks, commit proposals, etc.)
- `transformAgentMessagesToUI` - message transform pipeline
- Theme CSS variables

The web build becomes a single-page transcript app with no routing, no data fetching, no WebSocket code. It receives pre-decrypted messages via the JS bridge and renders them.

## Implementation Phases

### Phase 1: Foundation

**Completed:**
- [x] Verify encryption compatibility: JS Web Crypto <-> Swift CryptoKit roundtrip
  - Test vectors generated from Web Crypto API (same as desktop)
  - 11 XCTests passing: PBKDF2 key derivation, AES-GCM decrypt (short text, unicode, JSON, empty, 4KB, fixed IV project ID), deterministic encrypt match, roundtrip, error cases
  - Location: `packages/capacitor/ios/CryptoCompatibility/`

**Completed (Foundation Package):**
- [x] Create standalone Swift Package project with GRDB dependency
  - Location: `packages/capacitor/ios/NimbalystNative/`
  - SPM with GRDB.swift 7.9.0, targets: library + tests
  - Builds clean on macOS 13+ / iOS 16+
- [x] Create SQLite database schema with GRDB migrations (projects, sessions, messages, sync_state, queued_prompts)
  - `DatabaseManager.swift` with `v1_initial` migration
  - Uses `DatabasePool` for file-based, `DatabaseQueue` for in-memory (tests)
  - All 5 tables with foreign keys, cascade deletes, indices
  - 4 XCTests passing: table creation, session CRUD, message append/query, sync state tracking
- [x] Create GRDB model structs (Codable, FetchableRecord, PersistableRecord)
  - `Project.swift`, `Session.swift`, `Message.swift`, `SyncState.swift`, `QueuedPrompt.swift`
  - Full GRDB column expressions and associations
- [x] Create `CryptoManager` - wraps CryptoKit AES-GCM + CommonCrypto PBKDF2
  - Extracted from CryptoCompatibility tests into production code
  - `encrypt()`, `decrypt()`, `encryptDeterministic()`, `encryptProjectId()`
  - `decryptOrNil()` convenience for optional encrypted fields
- [x] Create `KeychainManager` - iOS Keychain storage for encryption key seed
  - Stores: encryption key seed, server URL, user ID
  - Uses `kSecAttrAccessibleAfterFirstUnlock` for background access
- [x] Create `WebSocketClient` - URLSessionWebSocketTask with reconnection, heartbeat
  - 5-second reconnect delay, 30-second device announce timer (heartbeat)
  - Platform-aware device info (UIDevice on iOS, Host on macOS)
  - JSON encoding/decoding with Codable messages
- [x] Create `SyncManager` - connects to index room, handles all message types
  - Processes: index_sync_response, index_broadcast, index_delete_broadcast, project_broadcast
  - Decrypts project IDs, session titles, caches in SQLite
  - Device presence tracking (devices_list, device_joined, device_left)
  - Create session request support
- [x] Create `SyncProtocol.swift` - all wire protocol types (Codable)
  - Client messages: index_sync_request, device_announce, create_session_request, session_control, register_push_token
  - Server messages: index_sync_response, index_broadcast, index_delete_broadcast, project_broadcast, create_session_response_broadcast, error, devices_list
- [x] Create SwiftUI app skeleton with NavigationStack/NavigationSplitView
  - `NimbalystApp.swift`, `AppState.swift`
  - `ProjectListView`, `SessionListView`, `SessionDetailView` (placeholder views)
  - iPad split view support, dark mode

**Remaining:**
- [x] Add CryptoManager tests to NimbalystNative (port from CryptoCompatibility)
  - 14 XCTests ported to NimbalystNative test target
- [x] Integration test: SyncManager end-to-end with mock WebSocket
  - 4 SyncIntegration tests: decrypt+store, bulk sync, upsert, missing title

### Phase 2: Native Navigation

**Completed:**
- [x] Wire `AppState` to initialize DatabaseManager, CryptoManager, and SyncManager from Keychain
  - Testing init with pre-built DatabaseManager, full manager chain from seed+userId
  - SyncManager connection state forwarded to AppState.isConnected
- [x] `ProjectListView` with GRDB `ValueObservation` for reactive database updates
  - Projects auto-update when SyncManager writes to SQLite
  - Pull-to-refresh triggers index sync
  - Connection status indicator in toolbar
  - Large title navigation bar (iOS)
  - Relative timestamps for last activity
- [x] `SessionListView` with GRDB `ValueObservation`, status badges, pull-to-refresh
  - Filtered by project, sorted by updatedAt descending
  - Provider badges with appropriate colors (Claude=blue, OpenAI=green, etc.)
  - Executing spinner and queued prompt indicators
  - Swipe-to-delete with cascade to messages and session count refresh
  - New Session sheet with optional initial prompt
- [x] `SessionDetailView` with reactive GRDB observation
  - Live updates to title, executing state, queued prompts from real-time broadcasts
  - Provider/model info display
  - Placeholder for Phase 3 WKWebView transcript
- [x] Dark theme color constants matching Nimbalyst desktop theme
  - `NimbalystColors` enum with all darkThemeColors (bg, text, primary, success, etc.)
  - `Color(hex:)` extension for hex color initialization
- [x] `RelativeTimestamp` utility (now, Xm ago, Xh ago, Xd ago, date)
- [x] Session deletion: `deleteSession()`, `session(byId:)`, `refreshSessionCount()`
  - Delete broadcast handler wired in SyncManager
  - Cascade deletes messages via foreign key constraint
- [x] iPad `NavigationSplitView` variant (from Phase 1 skeleton, now wired to data)
- [x] 13 Phase 2 XCTests: delete+cascade, session count, ValueObservation insert/delete, relative timestamps
  - Total: 35 tests passing (14 crypto + 4 database + 4 sync + 13 phase2)

### Phase 3: Native Transcript & Input

**Completed:**
- [x] `SessionDetailView` with native message list and compose bar
  - GRDB ValueObservation on messages table, filtered by session ID, ordered by sequence
  - ScrollViewReader with auto-scroll to bottom on new messages
  - Status bar (executing spinner, queued prompt indicator)
  - Empty state with provider/model badges
  - Session menu with voice mode placeholder
- [x] `MessageBubbleView` - native message rendering
  - User messages: right-aligned with blue tint, rounded bubbles
  - Assistant messages: left-aligned with dark background
  - Tool calls: collapsed cards with wrench icon and tool name
  - System messages: centered italic text
  - Markdown rendering via `AttributedString` (bold, italic, inline code, links)
  - JSON content parsing (extracts "content" or "prompt" fields from structured messages)
  - Tool name extraction from metadataJson or content JSON
  - Relative timestamps per message
- [x] `ComposeBar` - native input bar
  - Multi-line `TextField` with dynamic height (1-6 lines)
  - Send button with primary color (disabled when empty)
  - Executing state icon (clock) vs send icon (arrow up)
  - Ultra-thin material background with divider
- [x] Session room sync in `SyncManager`
  - `joinSessionRoom(sessionId:)` / `leaveSessionRoom()` lifecycle
  - Second `WebSocketClient` for session room (concurrent with index room)
  - Paginated sync: buffers pages until `has_more: false`, then batch commits
  - Real-time `message_broadcast` handling: decrypt + store + observation fires
  - `metadata_broadcast` handling: updates session executing/provider/model state
  - `sendPrompt()`: encrypts, sends `append_message`, stores locally for immediate display
  - Sync watermark tracking per session room
- [x] Session room protocol types (`SyncProtocol.swift`)
  - `SessionSyncRequest`, `SessionSyncResponse`, `AppendMessageRequest`
  - `ServerMessageEntry`, `SessionRoomMetadata`
  - `MessageBroadcast`, `MetadataBroadcast`
- [x] 16 Phase 3 XCTests: message observation (insert, ordering, filtering),
  content parsing (plain text, JSON content/prompt, nil, tool names),
  protocol encoding/decoding (sync request/response, broadcasts, append),
  sync state watermark
  - Total: 51 tests passing (14 crypto + 4 database + 4 sync + 13 phase2 + 16 phase3)

### Phase 3b: Embedded Web Transcript (WKWebView)

**Completed:**
- [x] Standalone transcript web entry point (`transcript.html` + `src/transcript/main.tsx` + `src/transcript/styles.css`)
  - Imports `AgentTranscriptPanel`, `transformAgentMessagesToUI` from `@nimbalyst/runtime`
  - `window.nimbalyst` bridge: `loadSession()`, `appendMessage()`, `updateMetadata()`, `clearSession()`
  - `createMobileBridgeHost()` for interactive widget responses back to Swift
  - Dark-only CSS variables, iOS safe area support, text selection control
- [x] Separate Vite config for transcript (`vite.config.transcript.ts`)
  - IIFE format output (no ES module CORS issues with `file://` URLs in WKWebView)
  - `wkwebview-compat` plugin strips `crossorigin` and replaces `type="module"` with `defer`
  - Deep imports to avoid barrel `@nimbalyst/runtime` index (prevents pulling in Excalidraw/Mermaid)
  - Produces `dist-transcript/transcript.html` + single JS bundle (~2.2MB)
- [x] `TranscriptWebView.swift` - WKWebView SwiftUI wrapper (`UIViewRepresentable`)
  - `WKScriptMessageHandler` bridge: handles `ready`, `prompt`, `interactive_response`, `haptic`, `js_error`
  - Swift -> JS: `loadSession()`, `appendMessage()`, `updateMetadata()` via `evaluateJavaScript`
  - Queues session data as `pendingSession` until web view signals "ready"
  - Incremental updates: only appends new messages, only sends metadata when changed
  - Haptic feedback via `UIImpactFeedbackGenerator` (light/medium/heavy)
  - `window.onerror` + `unhandledrejection` handlers injected at document start
  - `#if canImport(UIKit)` guard for macOS build compatibility
- [x] `SessionDetailView` updated to use `TranscriptWebView`
  - Replaced native `ScrollView`/`LazyVStack`/`MessageBubbleView` with embedded `TranscriptWebView`
  - Keeps native status bar and `ComposeBar`
  - GRDB `ValueObservation` drives live message updates to TranscriptWebView
  - macOS fallback to native message list via `#if !canImport(UIKit)`
- [x] Xcode project updated (`project.yml`)
  - `Resources/transcript-dist` bundle resource reference
  - Pre-build script copies Vite output to Xcode resources
- [x] All 51 tests still passing

**Bugs found and fixed during real-device testing:**
- [x] **CORS/module loading**: WKWebView with `file://` URLs rejects `crossorigin` attributes and
  `type="module"` scripts (CORS origin is `null`). Fixed by building as IIFE with `defer`.
- [x] **SwiftUI `updateUIView` race condition**: `@State messages` starts empty, so the first
  `updateUIView` call stores `pendingSession` with 0 messages. When GRDB fires with real data
  (e.g., 1886 messages), `currentSessionId` already matches so it falls to the append path, which
  silently drops messages because `isReady` is false. When the WebView becomes ready, it loads
  the stale `pendingSession` with 0 messages. Fixed by adding a `!coordinator.isReady` guard that
  updates `pendingSession` data when new messages arrive before the WebView is ready.
- [x] **Message envelope unwrapping**: The sync layer encrypts messages as a JSON envelope
  `{"content":"<inner JSON>","metadata":null,"hidden":false}`. `bridgeMessageToRaw()` was passing
  the entire envelope as `content` to `transformAgentMessagesToUI`, which couldn't match any
  expected format and silently dropped all messages (producing 0 UI messages from 2000+ raw
  messages). Fixed by unwrapping the envelope in `bridgeMessageToRaw()` to extract
  `envelope.content` as the actual message content.
- [x] **Test data format mismatch**: Test data in `NimbalystAppMain.swift` used raw inner content
  directly (no envelope), which meant the test path never exercised the real data format. Fixed by
  wrapping test data in the envelope format via `JSONSerialization`, and using the correct message
  formats (`{"prompt":"..."}` for user input, `{"type":"text","content":"..."}` for assistant output).

### Phase 4: Settings & Auth

**Completed:**
- [x] `QRScannerView.swift` - AVCaptureSession QR code scanner
  - `UIViewRepresentable` wrapping `AVCaptureVideoPreviewLayer`
  - `QRPairingData` parser (validates JSON with seed, serverUrl, userId fields)
  - Coordinator pattern with `AVCaptureMetadataOutputObjectsDelegate`
  - Single-fire scanning (prevents duplicate scans)
  - `#if canImport(UIKit)` guard for macOS build compatibility
- [x] `PairingView.swift` - Full pairing onboarding flow (replaces placeholder)
  - Instructions screen with "Scan QR Code" button
  - Camera permission request handling (authorized, notDetermined, denied)
  - QR scanner presented as sheet with viewfinder overlay
  - Parses scanned QR data and calls `AppState.pair()`
  - Error display for invalid QR codes and pairing failures
- [x] `SettingsView.swift` - Native settings with SwiftUI `Form`
  - Connection section: status indicator, server URL, connected devices disclosure group
  - Account section: user ID, paired status
  - Notifications section: push toggle with `UNUserNotificationCenter` (iOS only)
  - Danger zone: unpair button with confirmation dialog
  - Wired into ProjectListView toolbar (gear icon, top-left)
- [x] `NotificationManager.swift` - Push notification lifecycle manager
  - `UNUserNotificationCenter` permission request and status check
  - APNs token registration via `UIApplication.shared.registerForRemoteNotifications()`
  - Token forwarding to `SyncManager` via callback
  - `UNUserNotificationCenterDelegate` for foreground and tap handling
  - `makeRegisterTokenMessage()` builds wire protocol message
  - Push enabled state persisted in `UserDefaults`
- [x] `SyncManager` push token integration
  - `setupPushTokenForwarding()` wires `NotificationManager.onTokenReceived`
  - `registerPushToken()` sends `register_push_token` message via index client
  - Re-registers token on reconnect
- [x] `RegisterPushTokenMessage` made `public` in `SyncProtocol.swift`
- [x] `WebSocketClient.deviceId` made package-accessible for push token messages
- [x] 14 Phase 4 XCTests: QR parsing (valid, extra fields, missing fields, empty, invalid JSON, URL),
  push token message encoding, pairing data equality, AppState unpair, push defaults persistence
  - Total: 65 tests passing (14 crypto + 4 database + 4 sync + 13 phase2 + 16 phase3 + 14 phase4)

**Not implemented (deferred):**
- OAuth via `ASWebAuthenticationSession` was implemented in Phase 4 via Stytch + Google OAuth.

### Phase 5: Polish & Production Readiness

**Completed:**
- [x] Unread message state tracking (lastReadAt, lastMessageAt in DB + sync)
- [x] Session grouping by time period (Today, Yesterday, This Week, etc.)
- [x] Pull-down search for sessions
- [x] Scroll-to-top on title tap, jump-to-prompt menu
- [x] WKWebView pre-warming pool for instant transcript loading
- [x] Chunked message delivery for large transcripts (50 initial + background chunks)
- [x] Interactive prompt responses (AskUserQuestion, ToolPermission, ExitPlanMode, GitCommit)
- [x] Active-device push notification routing (only notify inactive devices)
- [x] Push notification deep-linking to specific sessions
- [x] App icon and splash screen
- [x] Production logging cleanup (NSLog -> os.Logger, removed debug timing/probes)
- [x] 65 XCTests passing across all phases

**Remaining for App Store submission:**
- [ ] Voice mode integration (present web overlay from native)
- [ ] App Store Connect configuration and TestFlight distribution
- [ ] Privacy policy and data handling declarations
- [ ] App Review compliance (data encryption declaration, IDFA usage)

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| CryptoKit AES-GCM compatibility with node-forge | **RESOLVED** - Compatibility tests pass. CryptoKit splits last 16 bytes as tag from base64(ciphertext\|\|tag) format. PBKDF2 key derivation matches. Deterministic encryption (fixed IV) produces byte-identical output. |
| SQLite schema migrations as sync protocol evolves | GRDB has built-in migration support. Version the schema. |
| Web transcript bundle size / load time | Aggressive tree-shaking: no React Router, no data layer, no Capacitor. Should be much smaller than current bundle. |
| WKWebView `file://` CORS restrictions | **RESOLVED** - `type="module"` and `crossorigin` attributes fail with `file://` URLs (origin is `null`). Fixed by building as IIFE with `defer`. |
| Sync envelope format mismatch | **RESOLVED** - Desktop encrypts `{content, metadata, hidden}` envelope; iOS must unwrap before passing to `transformAgentMessagesToUI`. Test data must also use envelope format. |
| Maintaining two languages (Swift + TypeScript) | The TypeScript portion shrinks to just the transcript renderer. Shared types can be generated. |
| Voice mode complexity | Keep as web overlay for now. Native voice mode is a separate future effort. |
| iPad split view regression | `NavigationSplitView` is actually better than the current custom `SplitView.tsx`. |
| Push notification token registration timing | Register early in `application(_:didFinishLaunchingWithOptions:)`, same as today. |

## Alternatives Considered

### 1. Keep Sync in Web, Only Nativize Navigation
- Web keeps WebSocket and encryption, native queries via bridge
- **Why not**: Native list views can't show data until WebView finishes loading. No offline support. No incremental sync. Defeats the purpose of going native.

### 2. Stay Full Web, Improve Navigation
- Use `framer-motion` or `react-spring` for better transitions
- **Why not**: Still won't match native feel. Pull-to-refresh, back gestures, navigation bar blur, large titles all need to be reimplemented poorly in JS.

### 3. Full Native Rewrite (Including Transcript)
- Rewrite everything in SwiftUI including the transcript renderer
- **Why not**: The transcript renderer is complex (tool widgets, code blocks, interactive prompts, virtual scrolling) and shares code with the desktop app via `@nimbalyst/runtime`. Maintaining a parallel Swift implementation would be unsustainable.

### 4. React Native
- Replace Capacitor with React Native
- **Why not**: No RN expertise, and we'd still need web embedding for the transcript since it uses shared runtime components.

## Success Criteria

- App launches and shows project/session lists instantly from SQLite (no spinner, no WebSocket wait)
- Navigation feels indistinguishable from a native iOS app (back gestures, transitions, bar blur)
- Pull-to-refresh uses native `UIRefreshControl`
- Previously viewed sessions are available offline
- Incremental sync: only new messages are fetched, not the full history
- Transcript rendering quality is unchanged from current web version
- Voice mode continues working
- iPad split view works natively via `NavigationSplitView`
- Capacitor dependency is fully removed
