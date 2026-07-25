# Android Testing

## Current Coverage

The initial Android package scaffold supports these checks:

```bash
cd packages/android
npm run build:transcript
npm run sync:transcript-assets
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest
```

On this machine, those Gradle tasks passed when `JAVA_HOME` was set to `/Users/ghinkle/Library/Java/JavaVirtualMachines/openjdk-20.0.2/Contents/Home` instead of the default GraalVM install.

## Expected Next Additions

- Room migration tests
- WebSocket sync integration tests (scaffolded and gated — see "Sync verification (gated)" below)
- emulator smoke tests for the native shell and transcript host
- emulator verification for `nimbalyst://auth/callback` deep links and in-app pairing QR scans
- emulator verification for queued prompt submission and queue clearing
- emulator verification for interactive widget responses in the transcript view
- emulator verification for camera QR scanning across permission states
- emulator verification for image attachment send flow from photo picker and camera preview
- emulator verification for unread badges clearing when a session is opened
- emulator verification for desktop settings/model sync display
- device verification for notification permission flow and FCM token registration once Firebase config is installed
- worker-env verification for FCM service-account secrets before Android push delivery

## Sync verification (gated)

`app/src/test/java/com/nimbalyst/app/sync/SyncCollabIntegrationTest.kt` drives the
real `SyncManager` public API (index-room join + snapshot, session-room join,
queued-prompt submit, session-control round-trip) against a LIVE
`nimbalyst-collab` Durable-Object sync server.

These are plain JVM (Robolectric) tests, not instrumented tests, so the gating
can read host environment variables and check for the sibling collab-server
checkout. They mirror the electron collab specs' `RUN_COLLAB_TESTS=1` /
`COLLAB_SERVER_PATH` model (see `.github/workflows/ci.yml`, the
`tracker-sync-collab.spec.ts` / `tracker-content-collab.spec.ts` gate).

By default the `nimbalyst-collab` repo is NOT checked out next to this monorepo,
so every test in that class is reported as **SKIPPED** (via JUnit `assumeTrue`)
and CI stays green. A test runs only when BOTH:

1. `RUN_COLLAB_TESTS=1` is set, AND
2. the collab-server directory exists — `COLLAB_SERVER_PATH` if set, otherwise
   the sibling default `../nimbalyst-collab` (relative to the monorepo root).

### Local run recipe

1. Check out `nimbalyst-collab` as a sibling of this repo and install it:

   ```bash
   git clone <nimbalyst-collab-url> ../nimbalyst-collab
   cd ../nimbalyst-collab && npm install
   ```

   (Use `COLLAB_SERVER_PATH` to point at a checkout elsewhere; an absolute path
   is used as-is, a relative one resolves from the monorepo root.)

2. Start the collab dev server (in the `nimbalyst-collab` checkout). Note its
   WebSocket URL/port and set `COLLAB_WS_URL` to match. The harness default is
   `ws://127.0.0.1:8787`, a placeholder — adjust it to the actual dev-server
   port.

3. Provide the live credentials the future harness wires up — the same paired,
   authenticated shape the desktop hands the mobile app:

   | Env var | Purpose |
   | --- | --- |
   | `RUN_COLLAB_TESTS` | Must be `1` to un-skip the class. |
   | `COLLAB_SERVER_PATH` | Optional override for the sibling repo path (default `../nimbalyst-collab`). |
   | `COLLAB_WS_URL` | Collab server WebSocket base URL (default `ws://127.0.0.1:8787`). |
   | `COLLAB_AUTH_JWT` | Valid team-scoped session JWT the room auth accepts. |
   | `COLLAB_SESSION_TOKEN` | Stytch session token used for JWT refresh. |
   | `COLLAB_ENCRYPTION_SEED` | E2E encryption seed (must match the desktop's so payloads decrypt). |
   | `COLLAB_AUTH_USER_ID` | Auth/crypto user id (JWT `sub`); also derives the AES key and routing. |
   | `COLLAB_ORG_ID` | Org id used to build the room id (`org:<org>:user:<user>:index`). |

4. Run just the gated class:

   ```bash
   cd packages/android
   RUN_COLLAB_TESTS=1 \
   COLLAB_WS_URL=ws://127.0.0.1:8787 \
   COLLAB_AUTH_JWT=... COLLAB_SESSION_TOKEN=... COLLAB_ENCRYPTION_SEED=... \
   COLLAB_AUTH_USER_ID=... COLLAB_ORG_ID=... \
   ./gradlew :app:testDebugUnitTest --tests 'com.nimbalyst.app.sync.SyncCollabIntegrationTest'
   ```

When un-gated, the tests await real `SyncManager` state transitions inside a
timeout: if the server is unreachable or rejects the credentials, the await
times out and the test FAILS loudly rather than passing vacuously. The
live-round-trip assertions are intentionally minimal/TODO-marked scaffolding —
the join/submit calls are real, and the deeper assertions (decrypted snapshot
contents, desktop-side echo) are to be fleshed out against a live server.

Known potential hurdle for the live run: `PairingStore` uses
`EncryptedSharedPreferences` + the Android Keystore. If Robolectric cannot
initialize the Keystore in your environment, `setUp` will fail at
`PairingStore(context)` (a setup failure unrelated to sync). If that happens,
register a Keystore shadow (or stand up a test-only pairing store) — this only
affects the un-gated live run, never the default skipped CI path.

## Manual Smoke Check

1. Build the transcript bundle.
2. Sync transcript assets into the generated Android asset directory.
3. Launch the app from Android Studio or `./gradlew :app:installDebug`.
4. Confirm the native shell opens.
5. Open Settings and verify:
   - QR payload import populates the pairing fields
   - browser login launches the server auth route
6. Open the Session screen and verify the transcript host either:
   - loads the bundled transcript page, or
   - shows the explicit missing-assets message instead of failing silently.
7. With a paired desktop session selected, send a prompt from Android and verify:
   - the queued prompt card updates immediately
   - the desktop receives the queued prompt
   - the queued prompt clears once desktop starts processing it
8. Open a session with an interactive prompt widget and verify the response is sent back to desktop and reflected in the transcript.
9. Open onboarding or settings, scan a valid desktop pairing QR, and verify the pairing fields are populated without manual paste.
10. Add an image attachment from the session composer and verify desktop receives the queued prompt with the attachment payload.
11. Let a session receive a new message while not selected, verify it shows unread state, then open it and verify the unread indicator clears.
12. Trigger a desktop settings sync and verify Android settings shows the synced model list and default model.
13. Install Firebase config, enable notifications from Android settings, and verify the sync server receives `registerPushToken`.
14. Provision FCM worker secrets, trigger a mobile push from desktop, and verify Android receives the notification with the session deep link.
