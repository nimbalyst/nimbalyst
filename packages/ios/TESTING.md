# iOS Transcript Integration Testing

This document describes the automated testing strategy for the iOS transcript integration.

## Overview

The transcript integration involves building a web bundle (React + TypeScript) and embedding it in a native iOS WKWebView. Testing covers:

1. **Web Bundle Build** - Vite builds the transcript correctly
2. **Native Swift Code** - TranscriptWebView and coordinator logic
3. **Integration** - Bundle is properly included in the iOS app
4. **End-to-End** - Full pipeline from source to running app

## Test Structure

```
packages/ios/
├── NimbalystNative/Tests/
│   ├── DatabaseManagerTests.swift       # Database layer tests
│   └── TranscriptWebViewTests.swift     # Web view integration tests
├── src/transcript/                      # Transcript web source
└── .github/workflows/
    └── ios-transcript-tests.yml         # CI/CD automation
```

## Running Tests Locally

### Quick Test

```bash
# Run Swift tests
cd packages/ios
npm run test:swift

# Build transcript
npm run build:transcript
```

### Individual Test Steps

**Build transcript only:**
```bash
cd packages/ios
npx vite build --config vite.config.transcript.ts
```

**Run Swift tests only:**
```bash
cd NimbalystNative
swift test --enable-code-coverage
```

**Build iOS app only:**
```bash
cd NimbalystApp
xcodegen generate
xcodebuild -project NimbalystApp.xcodeproj -scheme NimbalystApp \
  -destination 'platform=iOS Simulator,name=iPhone 15' clean build
```

## Large document downloads

`swift test --filter DocumentSync` covers ordered transactional batches and runs a local encrypted WebSocket fixture on macOS. The transport test downloads 2,293 files, interrupts after 50, refreshes credentials, and verifies the resumed request contains the partial cache and the fresh token. No real account or production sync state is used.

For the full Files UI test, start `node packages/ios/scripts/document-sync-fixture.cjs --interrupt` from the repository root. It prints an ephemeral port. Pass that port to the test runner using `TEST_RUNNER_NIMBALYST_DOCUMENT_FIXTURE_URL=http://127.0.0.1:<port>` when running `xcodebuild test -only-testing:NimbalystNavigationUITests/NavigationContinuityTests/testFilesDownloadsLargeProjectAndRetriesInterruptedSync` with the scheme and simulator destination below. Stop that fixture process afterward. This one test is skipped when its local server URL is absent; the ordinary navigation tests have no server dependency. The app accepts the fixture only in a debug screenshot launch and uses an in-memory database.

The test opens Files, interrupts a download, allows automatic recovery or taps Retry when offered, waits for 2,293 files, and opens a downloaded document in the real editor. Simulator acceptance does not establish physical-device peak memory or production rollout acceptance.

## Navigation Continuity

`NimbalystNavigationUITests` exercises the production `MainNavigationView` with an in-memory demo account. It opens a project and session, types an unsent draft, rotates through portrait and both landscape orientations, and verifies the selected session, draft, Back navigation, and that wide screens keep the session list visible beside the transcript. The split view uses both columns with at least 700 points of available width, including iPhones whose native horizontal size class stays compact in landscape. Run the rotation test on a regular iPhone Pro, a Pro Max, and an iPad:

```bash
cd packages/ios/NimbalystApp
xcodegen generate
xcodebuild -project NimbalystApp.xcodeproj -scheme NimbalystApp \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' \
  -destination 'platform=iOS Simulator,name=iPad Pro 11-inch (M5)' \
  -only-testing:NimbalystNavigationUITests/NavigationContinuityTests/testSessionDraftAndBackHistorySurviveRotation \
  -parallel-testing-enabled NO -collect-test-diagnostics never test
```

The debug launch arguments `--screenshot-mode --screenshot-screen=navigation` use the real navigation shell instead of an isolated screenshot screen. This bypasses pairing and does not connect to sync. The test suppresses the notification prompt through a launch-time UserDefaults override.

`testNewSessionOpensTranscriptWithoutReopening` uses `--session-creation-fixture` with the sessions screen to create three sessions through the real toolbar and creation callbacks. An in-memory account substitutes only the desktop response; it uses the bundled transcript and pooled WKWebView. Creating again after Back and reopening each session from its row must finish loading. The fixture covers standalone sessions, a single-session worktree, a meta-agent header, and its child. This catches premature disappearance of the visible detail, which cancels its observers, timeout, and session connection. The detail uses an explicit navigation stack; sidebar rows use List selection tags so they do not also push an implicit destination. The Files transport UI test exercises the same selection path for documents. It does not verify desktop/server transport or a physical phone.

`testEmptyListsWaitForIndexSync` uses `--loading-fixture` with the projects and sessions screens to hold an empty local database in loading for ten seconds, then complete the index. It verifies that loading appears before the definitive empty state. `SyncIntegrationTests.testIndexLoadCompletesOnlyAfterImportAndRejectsFailedImports` separately feeds encrypted wire responses through the real index handler and verifies that completion follows database writes, failed imports remain failures, and an empty retry completes. These fixtures do not connect to the live sync server.

## Testing the Session Fleet Live Activity

This is the one path in the app that unit tests cannot finish. Know which half you are proving.

### What automated tests cover

| Layer | Tests |
|-------|-------|
| Desktop snapshot + row ranking + coalescing | `packages/electron/src/main/tray/__tests__/fleetActivity.test.ts` |
| Server decision, APNs payload, per-device recovery, token rotation and retries | `collabv3/test/liveActivity.test.ts`, `liveActivityRecovery.test.ts` (nimbalyst-collab) |
| Card text, attributes decoding, permission recovery and activity-token ownership | `NimbalystNative/Tests/FleetActivityTests.swift` |

Everything up to the APNs request is pure and tested. The APNs round trip and the rendered card are not.

### What the simulator cannot do

**ActivityKit does not vend push tokens in the simulator.** No push-to-start token means the server has nothing to send to, so the card can never appear there — and because the app deliberately never calls `Activity.request`, there is no local-start path to fall back on either. `xcrun simctl push` does not substitute: it delivers to the app, not to an activity the system has no token for.

Layout work therefore needs either a SwiftUI preview in `NimbalystWidgets` or a real device.

### Verifying on a device

1. Install a **TestFlight or Release-signed** build over the existing installation. Recovery acceptance must preserve existing registrations; do not delete the app to make the test pass. If testing a switch from a development-signed build, diagnose its token environment separately: the source entitlements alone do not prove the installed signature uses production APNs. Check the shipped app with `codesign -d --entitlements :- YourApp.app`.
2. Confirm Settings > **Session Fleet Live Activity** is on, and that Live Activities are enabled for the app in iOS Settings.
3. Watch the token reach the server. The app logs `Sent Live Activity <kind> token registration` (subsystem `com.nimbalyst.app`, category `SyncManager`); the server side is visible in `wrangler tail`.
4. On the Mac, start a session and let it ask for approval. The desktop publishes on transitions plus a 5-minute heartbeat, so a quiet fleet will not produce a card.
5. Check all four: the Lock Screen card, the Dynamic Island compact and expanded presentations, that tapping a row opens the right session, and that the card **ends** when the fleet goes quiet rather than lingering.
6. Leave it running past the 12-minute stale window with the Mac asleep — the card should dim, not keep asserting a stale count.

If nothing arrives, inspect `wrangler tail` against the production worker. Token registration logs report the device and token kind; `Live Activity push: action=…` reports the APNs outcome, and `Live Activity decision: action=…` reports whether that outcome changed the stored state. These logs omit full tokens. Expected interpretations:

| Symptom in the tail | Cause |
|---|---|
| `result=invalid status=400 reason=BadDeviceToken` | Check signing and token environment; the rejected token is retired. A production entitlement in source does not prove the installed signature is production |
| `result=invalid status=410 reason=ExpiredToken` | The activity token expired; it is retired and the next eligible publication can start a replacement |
| `result=accepted` on start but no card | APNs acceptance does not prove rendering. Check ActivityKit on the physical phone and confirm update-token registration |
| `result=retry` | Credential, transport, rate-limit or server failure; registration is preserved and retry is backed off |
| `applied=false` | A newer registration or invalidation superseded this APNs response; it must not mutate that newer state |
| No new start while one is pending | Accepted starts without a returned update token become eligible for retry after 15 minutes, capped at three attempts per eight-hour window. A later publication or registration drives retry; there is no retry alarm. This cadence still needs physical TestFlight acceptance |
| Card disappears while using the Mac | This is no longer intended behavior. Mac presence must not suppress the phone card |

## CI/CD Testing

GitHub Actions automatically runs tests on:
- Push to `main`
- Pull requests to `main`
- Changes to `packages/ios/**` or `packages/runtime/**`

The CI pipeline has three jobs:

### Job 1: Test Transcript Bundle Build
- Installs dependencies
- Builds transcript with Vite
- Verifies bundle structure
- Uploads bundle as artifact

### Job 2: Test iOS Native Code
- Downloads transcript bundle artifact
- Runs Swift unit tests with coverage
- Builds iOS app for simulator
- Runs UI tests (if configured)

### Job 3: End-to-End Integration Test
- Full build from source
- Verifies transcript in built app bundle
- Checks file structure

### Running Tests in Xcode

1. Open `NimbalystApp/NimbalystApp.xcodeproj`
2. Select the `NimbalystNative` scheme
3. Press `Cmd+U` to run tests

## Debugging Test Failures

### Bundle Not Found

If `testTranscriptBundleExists` fails:

1. Manually run the build:
   ```bash
   cd packages/ios
   npx vite build --config vite.config.transcript.ts
   mkdir -p NimbalystApp/Resources/transcript-dist
   cp dist-transcript/transcript.html NimbalystApp/Resources/transcript-dist/
   cp -R dist-transcript/assets NimbalystApp/Resources/transcript-dist/
   ```

2. Regenerate Xcode project:
   ```bash
   cd NimbalystApp
   xcodegen generate
   ```
