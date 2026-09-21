# iOS Package (Native iOS App)

This package contains the native SwiftUI iOS/iPadOS app for Nimbalyst. It provides a mobile interface for viewing and interacting with AI sessions synced from the desktop Electron app via end-to-end encrypted WebSocket sync.

The app is **pure Swift/SwiftUI** with no Capacitor or web framework dependency. The only web view is `TranscriptWebView` (WKWebView) which renders the rich chat transcript using the same React components as the desktop app.

## Package Structure

```
packages/ios/
  NimbalystNative/          # Swift Package - all business logic and UI
    Sources/
      App/                  # AppState (root observable), ContentView, navigation
      Auth/                 # AuthManager (Stytch OAuth via ASWebAuthenticationSession)
      Crypto/               # CryptoManager (AES-256-GCM, PBKDF2), KeychainManager
      Database/             # DatabaseManager (GRDB migrations, queries)
      LiveActivity/         # FleetActivityAttributes/Formatting/Controller (ActivityKit tokens)
      Models/               # GRDB record types: Project, Session, Message, QueuedPrompt, SyncState
      Notifications/        # NotificationManager (push notification registration)
      Sync/                 # SyncManager, WebSocketClient, SyncProtocol types
      Utils/                # RelativeTimestamp, NimbalystColors
      Views/                # All SwiftUI views
    Tests/                  # Unit and integration tests
    Package.swift           # Swift Package Manager manifest (GRDB dependency)

  NimbalystApp/             # Xcode app target
    Sources/                # App entry point (@main), DebugMenu
    Resources/              # Assets.xcassets (AppIcon, Splash), transcript-dist bundle
    NimbalystWidgets/       # Widget extension: Live Activity lock screen + Dynamic Island
    project.yml             # XcodeGen project definition

  CryptoCompatibility/      # CommonCrypto bridging header for PBKDF2 key derivation

  src/transcript/           # React transcript web bundle (loaded in WKWebView)
    main.tsx                # Entry point with Swift <-> JS bridge
    styles.css              # Styles with bundled Material Symbols font
    fonts/                  # Locally bundled Material Symbols TTF

  vite.config.transcript.ts # Vite config for transcript bundle (IIFE format for file://)
  transcript.html           # HTML entry point for Vite build
  dist-transcript/          # Build output (not committed)
```

## Key Architecture Decisions

### Authentication Flow
1. QR pairing stores encryption seed + server URL in Keychain
2. Stytch OAuth stores JWT + user ID in Keychain
3. When both paired AND authenticated, managers initialize
4. Encryption key derived from seed + user ID via PBKDF2

### Data Flow
- **Sync**: WebSocket connection to CollabV3 Durable Object (same server as desktop)
- **Encryption**: All session data encrypted with AES-256-GCM before transmission
- **Storage**: GRDB (SQLite) with reactive `ValueObservation` for live UI updates
- **Transcript**: WKWebView loads bundled React app, communicates via `webkit.messageHandlers.bridge`

### iPhone and iPad Navigation
- One `NavigationSplitView` and `WorkspaceNavigationState` on every device and orientation: the session/file sidebar sits beside the detail on wide screens and collapses into a stack on narrow screens.
- Never replace the navigation tree based on size class; rotation and window resizing must preserve the active session and unsent compose state. Sidebar rows use List tags with stable `WorkspaceSelection` values, including sessions opened by notification or voice. Do not mix `NavigationLink(value:)` pushes with the selection-driven detail stack: the duplicate navigation can disappear the visible transcript and cancel its session connection.
- SwiftUI may remount the detail while collapsing columns. Keep `SessionComposeState` (text, pending attachments, and draft timestamps) in `WorkspaceNavigationState`, above the split view, and clear that cache when the account changes.

### Session Fleet Live Activity

The Lock Screen card and Dynamic Island render the same derived fleet snapshot as the macOS menu bar strip (`packages/electron/src/main/tray/fleetActivity.ts`). Four rules that are easy to break by accident:

1. **The app never calls `Activity.request`.** The card is started, updated and ended by the server through APNs. `FleetActivityController` only observes ActivityKit and hands tokens to `SyncManager`. If you add a local start for convenience, the server will believe a card it did not start is its own.
2. **Push-to-start and update tokens are different things.** A push-to-start token belongs to the app; an update token belongs to one activity and dies with it. They travel as separate `LiveActivityTokenKind` values all the way to the server's storage, because sending an update to a push-to-start token fails at APNs with an error indistinguishable from a bad token.
3. **The widget extension shares source files by target membership, not by linking `NimbalystNative`** (GRDB + PostHog have no business in an extension memory budget). ActivityKit matches an activity to its attributes by the *unqualified* type name, so both targets must compile the same `FleetActivityAttributes` declaration. The server also sends that name as a string (`LIVE_ACTIVITY_ATTRIBUTES_TYPE` in `collabv3/src/liveActivity.ts`) — renaming the Swift type without moving that constant breaks push-to-start with an APNs rejection and no client-side symptom.
4. **The widget's `Info.plist` version must match the app's.** `scripts/ios-release.sh` bumps both; App Store Connect rejects a drifted embedded extension.

Anything user-facing on the card that can be expressed as a pure function belongs in `FleetActivityFormatting.swift`, which is unit tested. The views themselves are not, and cannot be exercised in the simulator without a real push — see [TESTING.md](./TESTING.md).

## Development

### Prerequisites
- Xcode 16+
- Node.js 20+ (for transcript bundle)
- XcodeGen (`brew install xcodegen`)

### Commands
```bash
# From monorepo root:
npm run ios:test:swift          # Run all 68 Swift tests
npm run ios:build:transcript    # Build transcript web bundle

# From packages/ios/:
cd NimbalystNative && swift test                    # Run tests directly
cd NimbalystApp && xcodegen generate                # Regenerate .xcodeproj
open NimbalystApp/NimbalystApp.xcodeproj            # Open in Xcode
```

### Transcript Bundle
The Xcode pre-build script in `project.yml` automatically builds the transcript with Vite and copies it to `Resources/transcript-dist/`. You can also build manually:

```bash
npm run ios:build:transcript
```

Output: `dist-transcript/transcript.html` + `dist-transcript/assets/` (JS bundle + Material Symbols font).

After building, copy the output to Xcode resources:
```bash
rm -f NimbalystApp/Resources/transcript-dist/assets/transcript-*.js
cp dist-transcript/transcript.html NimbalystApp/Resources/transcript-dist/transcript.html
cp dist-transcript/assets/* NimbalystApp/Resources/transcript-dist/assets/
```

**CRITICAL: React hooks rules in `src/transcript/main.tsx`**

The transcript React app runs inside WKWebView where errors are invisible (cross-origin `window.onerror` reports "Script error." with no details). This makes hooks violations especially dangerous -- the screen goes blank with no diagnostic information.

Rules for editing `TranscriptApp` in `main.tsx`:
- **All hooks (`useState`, `useRef`, `useCallback`, `useMemo`, `useEffect`) must come BEFORE any early returns.** React requires the same hooks to run in the same order on every render. An early `return` before a hook means that hook runs on some renders but not others, crashing React with "Rendered more hooks than during the previous render."
- **The `TranscriptErrorBoundary` wraps the app** to catch render errors and display them on screen + report to the native bridge. Do not remove it.
- **The `postErrorToNative` helper** sends error details through `webkit.messageHandlers.bridge` so they appear in Xcode console logs with full stack traces. Use it in any new try-catch blocks.
- **Test after any change**: Always rebuild the transcript (`npm run ios:build:transcript`), copy to Xcode resources, and rebuild in Xcode. Vite build success does NOT mean React will render correctly at runtime.

## Key Files

| File | Purpose |
|------|---------|
| `Sources/App/AppState.swift` | Root observable object; owns database, crypto, and sync managers |
| `Sources/Sync/SyncManager.swift` | WebSocket sync with CollabV3; processes index responses and broadcasts |
| `Sources/Sync/SyncProtocol.swift` | All wire protocol types (Codable structs with CodingKeys) |
| `Sources/Database/DatabaseManager.swift` | GRDB schema migrations, queries, and project stats refresh |
| `Sources/Crypto/CryptoManager.swift` | AES-256-GCM encrypt/decrypt, deterministic project ID encryption |
| `Sources/Views/TranscriptWebView.swift` | WKWebView + Coordinator with JS bridge, TranscriptController |
| `Sources/Views/SessionDetailView.swift` | Session detail with transcript, scroll-to-top, jump-to-prompt |
| `Sources/Views/SessionListView.swift` | Time-grouped session list with search and swipe-to-delete |
| `Sources/Views/ProjectListView.swift` | Project list sorted by last activity with desktop connection indicator |
| `Sources/LiveActivity/FleetActivityAttributes.swift` | Wire shape of the Live Activity; shared with the widget target by membership |
| `Sources/LiveActivity/FleetActivityController.swift` | ActivityKit token observation and activity lifecycle; never starts an activity |
| `Sources/LiveActivity/FleetActivityFormatting.swift` | Pure, testable card text (counts, elapsed time, row labels) |
| `../NimbalystApp/NimbalystWidgets/FleetActivityWidget.swift` | Widget configuration: lock screen + Dynamic Island minimal/compact/expanded |
| `src/transcript/main.tsx` | React transcript app with `scrollToTop`, `scrollToMessage`, `getPromptList` JS bridge |

## Testing
- Swift tests cover database, crypto, sync integration, web view, and the Live Activity formatting/attributes layer
- See [TESTING.md](./TESTING.md) for CI/CD pipeline details and for what the Live Activity can and cannot prove in the simulator
- Tests run on both macOS (via Swift Package Manager) and iOS simulator (via Xcode)
