# Nimbalyst for Android

Native Android companion app for Nimbalyst, mirroring the native iOS package architecture while explicitly excluding voice-agent features in the first implementation track.

## Current Status

This package currently contains:

- a Kotlin + Jetpack Compose Android app scaffold
- an Android `WebView` host for the shared transcript renderer
- a Room-backed local store for projects, sessions, messages, and sync watermarks
- a Kotlin AES-GCM / PBKDF2 crypto layer compatible with the iOS and desktop wire format
- an OkHttp WebSocket sync manager for index-room and session-room hydration
- QR payload import, editable pairing/auth credentials, and `nimbalyst://` deep-link handling for pairing and auth callbacks
- a browser-login entry point that launches the existing server OAuth flow
- a CameraX + ML Kit QR scanner for pairing import in onboarding and settings
- a desktop session-creation request flow from the Projects screen
- queued prompt sync and prompt submission from Android through the index-room update path
- native image attachments for prompts via photo picker and quick camera capture
- interactive widget responses bridged from the transcript `WebView` back to desktop session control
- unread-state tracking for the active session and unread indicators in the session list
- desktop settings/model metadata sync surfaced in Android settings
- notification permission and FCM token registration plumbing wired on the Android client (the server-side push send path lives in the sibling `nimbalyst-collab` repository, not this monorepo)
- a dedicated Vite transcript bundle setup under `src/transcript/`
- package-local docs and scripts so Android work can evolve without touching the monorepo root

What is not implemented yet:

- push notifications
- production-ready UX polish and release hardening

## Structure

```text
packages/android/
  app/                         # Android application module
  src/transcript/              # React transcript bundle for Android WebView
  scripts/                     # Package-local helper scripts
  package.json                 # Transcript build/test scripts
  build.gradle.kts             # Root Android Gradle config
  settings.gradle.kts          # Android Gradle settings
```

## Development

### Transcript bundle

```bash
cd packages/android
npm install
npm run build:transcript
npm run sync:transcript-assets
```

### Android app

The project builds with JDK 17. It targets `JavaVersion.VERSION_17` / `jvmTarget = "17"`, and Temurin 17 matches CI. From the repository root:

```bash
npm run android:test:unit         # ./gradlew :app:testDebugUnitTest
npm run android:assemble:debug    # ./gradlew :app:assembleDebug
npm run android:assemble:release  # ./gradlew :app:assembleRelease
npm run android:bundle:release    # ./gradlew :app:bundleRelease
```

To run Gradle directly, point `JAVA_HOME` at a Temurin 17 install:

```bash
cd packages/android
JAVA_HOME=/path/to/temurin-17 ./gradlew :app:assembleDebug
JAVA_HOME=/path/to/temurin-17 ./gradlew :app:testDebugUnitTest
```

If `JAVA_HOME` points at GraalVM, Android builds can fail during the AGP `jlink` step. Temurin 17 sidesteps that and matches the Gradle config.

### Builds, signing, and CI

- `google-services` is applied conditionally (only when `app/google-services.json` exists), so the build is green without it and push stays inert until the file is added.
- CI can inject Firebase config from the optional `ANDROID_GOOGLE_SERVICES_JSON_BASE64` GitHub secret by decoding it to `app/google-services.json` before the Gradle build.
- The release `signingConfig` reads the keystore path and credentials from environment variables: `NIMBALYST_ANDROID_KEYSTORE`, `NIMBALYST_ANDROID_KEYSTORE_PASSWORD`, `NIMBALYST_ANDROID_KEY_ALIAS`, `NIMBALYST_ANDROID_KEY_PASSWORD`. With no keystore the release build is unsigned. Minification stays off.
- `.github/workflows/android-build.yml` builds both the APK and Play-ready AAB in CI and supplies the signing secrets to produce signed release artifacts when secrets are present.

The app currently boots into a native Compose shell with placeholder project, session, and settings screens plus a `TranscriptWebView` container that will load the generated transcript asset bundle once `dist-transcript/` has been synced into the Android build assets.

Android can now:

- store and edit pairing, auth, and routing credentials locally
- import the same pairing payload shape used by iOS QR flows
- scan the desktop pairing QR directly from onboarding and settings
- receive `nimbalyst://auth/callback?...` links; pairing payloads are accepted only through the in-app QR scanner
- open the existing browser login flow from Settings
- connect to CollabV3 index and session rooms and hydrate the local Room database
- request new desktop sessions and wait for the returning index broadcast
- queue prompts from Android and render queued prompts in the session detail view
- attach photos from the library or quick camera capture when queueing prompts
- send AskUserQuestion, ToolPermission, ExitPlanMode, and GitCommit widget responses from the transcript bridge
- clear unread indicators as sessions are viewed on Android
- show desktop-synced available models and the current default model in settings
- enable push notifications from Settings, request notification permission, and attempt FCM token registration when Firebase config is present

Current push blocker:

- There is no `google-services.json` in this workspace, so Android cannot complete real FCM registration yet. The `google-services` plugin is applied conditionally, so the build stays green and push stays inert until the file is added.
- Firebase/FCM secrets still need to be provided to the collab server environment (the sibling `nimbalyst-collab` repository) before Android push can deliver in production.
