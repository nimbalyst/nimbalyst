# Nimbalyst for Android

Native Android companion app for Nimbalyst. It follows the iOS app's architecture: a Kotlin + Jetpack Compose shell, a Room database, WebSocket sync with the collab server, and one `WebView` that renders the shared React transcript. Voice features are out of scope on Android.

## What works today

- **Pairing:** scan the desktop's pairing QR code with the in-app CameraX + ML Kit scanner. Settings also accepts a pasted QR payload. Pairing links (`nimbalyst://pair`) are deliberately **not** routed from outside the app, because a pairing payload selects the sync server and encryption context.
- **Sign-in:** Google sign-in in a Custom Tab, or an email magic link when the pairing carries an email. The `nimbalyst://auth/callback` link completes sign-in. A failed callback shows the server's `error_description` on the sign-in screen.
- **Sync:** end-to-end encrypted AES-GCM / PBKDF2 (wire-compatible with iOS and desktop) over OkHttp WebSockets to the index and session rooms, hydrating a local Room database.
- **Projects and sessions:** browse projects and sessions synced from the desktop app, with unread indicators, and create a new session on the desktop from the session list.
- **Transcript:** the React transcript bundle (`src/transcript/`) in a `WebView`, including interactive widget responses (AskUserQuestion, ToolPermission, ExitPlanMode, GitCommit) sent back to the desktop.
- **Prompts:** queue prompts from Android, with photo library and camera attachments.
- **Push notifications:** client code exists (FCM token registration and notification taps that open a session), but it only works in a build that includes `app/google-services.json`, and delivery also depends on the collab server's Firebase configuration. Without the file the build stays green and push is inert.
- **Account:** sign out, unpair, and delete account from Settings.
- **Look:** dark only, using the same Nimbalyst palette as iOS (`ui/theme/`).

## Not implemented yet

Much of this is tracked in the Android/iOS parity plan. Notable gaps compared with iOS: the files and document views, an adaptive tablet layout, a model picker, and multiple accounts.

## Structure

```text
packages/android/
  app/                         # Android application module
    src/main/java/.../ui/      # Compose screens; ui/theme and ui/components hold shared styling
    src/debug/                 # Debug-only screenshot mode (demo data, fake pairing)
    src/test/                  # JVM unit tests (Robolectric where Android APIs are needed)
  src/transcript/              # React transcript bundle for the Android WebView
  scripts/                     # Transcript asset sync helpers
  package.json                 # Transcript build/test scripts
  build.gradle.kts             # Root Android Gradle config
  settings.gradle.kts          # Android Gradle settings
```

## Development

### Transcript bundle

```bash
cd packages/android
pnpm install
pnpm run build:transcript
pnpm run sync:transcript-assets
```

### Android app

The project targets `JavaVersion.VERSION_17` / `jvmTarget = "17"`. CI uses Temurin 17; OpenJDK 20 also works locally. Avoid GraalVM, which can fail the AGP `jlink` step. From the repository root:

```bash
pnpm run android:test:unit         # ./gradlew :app:testDebugUnitTest
pnpm run android:assemble:debug    # ./gradlew :app:assembleDebug
pnpm run android:assemble:release  # ./gradlew :app:assembleRelease
pnpm run android:bundle:release    # ./gradlew :app:bundleRelease
```

To run Gradle directly:

```bash
cd packages/android
JAVA_HOME=/path/to/jdk ./gradlew :app:assembleDebug
JAVA_HOME=/path/to/jdk ./gradlew :app:testDebugUnitTest
```

Open `packages/android/` in Android Studio, not the repo root.

### Play Store screenshots

`pnpm run android:screenshots` and `pnpm run android:walkthrough` drive an emulator against the debug-only screenshot mode. See [ANDROID_MARKETING_SCREENSHOTS.md](../../docs/ANDROID_MARKETING_SCREENSHOTS.md).

### Builds, signing, and CI

- `google-services` is applied only when `app/google-services.json` exists. Never commit that file.
- CI can inject Firebase config from the optional `ANDROID_GOOGLE_SERVICES_JSON_BASE64` GitHub secret by decoding it to `app/google-services.json` before the Gradle build.
- The release `signingConfig` reads the keystore path and credentials from `NIMBALYST_ANDROID_KEYSTORE`, `NIMBALYST_ANDROID_KEYSTORE_PASSWORD`, `NIMBALYST_ANDROID_KEY_ALIAS`, and `NIMBALYST_ANDROID_KEY_PASSWORD`. With no keystore the release build is unsigned. Minification stays off.
- `.github/workflows/android-build.yml` builds the APK and AAB. Pushes and pull requests run an unsigned job with no signing secrets. A signed build runs only for an `android/v*` tag, in a job gated on the `android-release` protected environment, and fails fast if `ANDROID_GOOGLE_SERVICES_JSON_BASE64` is missing.
- To cut a signed release: `git tag android/vX.Y.Z && git push origin android/vX.Y.Z`, then approve the `android-release` deployment. For a local signed AAB, run `pnpm run android:bundle:signed`.

### Server side

Push delivery and the sync rooms live in the collab server, the sibling `nimbalyst-collab` repository. Android push changes usually need coordinated client and server work.
