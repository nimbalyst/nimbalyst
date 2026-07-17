---
planStatus:
  planId: plan-android-play-launch
  title: Android Play Store Launch Plan
  status: in-development
  planType: release
  priority: high
  owner: ghinkle
  stakeholders:
    - ghinkle
  tags:
    - android
    - mobile
    - release
    - push-notifications
  created: "2026-07-06"
  updated: "2026-07-09"
  progress: 35
---
# Android Play Store Launch Plan

## Launch Bar

Ship Android as a polished Nimbalyst companion app, not as full iOS parity. The first Play Store release is acceptable if it reliably handles the mobile agent workflows users reach for away from desktop:

- pair and authenticate without manual credential editing
- see synced projects, sessions, messages, queued prompts, unread state, and connection state
- start a desktop-backed session from Android
- submit prompts, image attachments, and interactive prompt/tool responses
- receive production push notifications for sessions or inbox events that need attention
- recover cleanly from offline, expired auth, denied permissions, and empty states

Voice mode and full mobile document editing can stay out of scope for this launch, but the app must not feel like a debug shell.

## Current Repo State

Android is already a native Kotlin/Compose app under `packages/android`, with Room persistence, encrypted sync, a transcript WebView, QR pairing, auth callbacks, prompt submission, image attachments, unread state, synced model metadata, and client-side FCM token plumbing.

Update 2026-07-09: the first launch-hardening slice is implemented. Android now has an explicit Settings push toggle with unregister support, the notification permission is no longer requested automatically on first authenticated launch, the collab server sends Android FCM as data-only payloads, CI builds a Play-ready AAB alongside the APK, CI can inject Firebase config from `ANDROID_GOOGLE_SERVICES_JSON_BASE64`, the app label is `Nimbalyst`, Android backup is disabled, and notifications use an app-owned small icon.

Update 2026-07-09 (second slice): CI now injects the production `google-services.json` from an `ANDROID_GOOGLE_SERVICES_JSON_BASE64` secret and fails a signed release build if that secret is missing, so a CI-built AAB ships with working push instead of silently inert push. Added an adaptive launcher icon (`mipmap-anydpi-v26` + full-bleed foreground layers at all densities over a white background) and a backported system splash (`androidx.core:core-splashscreen`, `Theme.NimbalystAndroid.Splash`, `installSplashScreen()`). First external release stays at `versionCode 1` / `versionName 0.1.0`.

Update 2026-07-09 (third slice): local signed-AAB pipeline is working end-to-end. `scripts/android-bundle-signed.sh` (`npm run android:bundle:signed`) pulls all signing secrets from the 1Password item `Nimbalyst Android Signing` at build time via `op`; produced a verified-signed `app-release.aab`. Keystores are now gitignored. Store listing copy + Data Safety worksheet complete in `design/MobileSync/android-play-store-listing.md` from a full code audit.

Update 2026-07-09 (fourth slice): store-listing inputs resolved — privacy policy `https://nimbalyst.com/privacy` (live), support `support@nimbalyst.com`, reviewer access via a paired-flow screencast. In-app account deletion **shipped** on Android (`AccountDeletionClient` → `POST /api/account/delete` with the session JWT; Settings > Delete Account with a confirmation dialog; clears local state on success), mirroring the existing iOS flow and satisfying Play's data-deletion requirement. 124 Android unit tests pass. Remaining before submit: capture store screenshots from the polished app, and run on-device push validation (grant/deny/toggle/background/killed tap-routing).

Important launch facts:

- Package id is `com.nimbalyst.app`; treat it as frozen before Play upload.
- `compileSdk` and `targetSdk` are already 35, which satisfies the current Google Play Android 15/API 35 requirement for new apps and updates.
- Release signing is environment-driven through `NIMBALYST_ANDROID_KEYSTORE*`.
- CI currently builds and uploads a signed release APK, not the Android App Bundle Google Play expects for new apps.
- `google-services.json` is intentionally uncommitted and the Firebase plugin is conditional, so push is inert until production Firebase config is installed.
- The sibling `../nimbalyst-collab` server already has token storage plus APNs and FCM HTTP v1 send paths, gated by Cloudflare secrets.
- The existing `design/MobileSync/mobile-push-notifications.md` is useful historical context but is stale: it describes the older Capacitor/APNs implementation rather than the current native Android/iOS architecture.

## Official Constraints To Design Around

- Google Play requires new Android apps to target Android 15/API 35 or higher starting August 31, 2025.
  Source: https://support.google.com/googleplay/android-developer/answer/11926878
- New Google Play apps must publish using Android App Bundles.
  Source: https://developer.android.com/studio/publish/
- Play App Signing should be configured before uploading an app bundle; keep a separate upload key for CI.
  Source: https://developer.android.com/studio/publish/app-signing
- Data Safety requires a privacy policy and disclosure of collected/shared user data and app security practices.
  Source: https://support.google.com/googleplay/android-developer/answer/10787469
- Android 13+ notifications are off by default until `POST_NOTIFICATIONS` is granted, and the app controls when to request the permission because it targets API 35.
  Source: https://developer.android.com/develop/ui/compose/notifications/notification-permission
- FCM HTTP v1 sends to `https://fcm.googleapis.com/v1/projects/{projectId}/messages:send`.
  Source: https://firebase.google.com/docs/cloud-messaging/send/v1-api
- For Android background delivery, FCM messages with both notification and data payload bypass `onMessageReceived`; data arrives in launcher-activity extras on tap. If the app needs custom notification tap routing, prefer data-only messages handled by `FirebaseMessagingService`, or explicitly handle notification extras in `MainActivity`.
  Source: https://firebase.google.com/docs/cloud-messaging/android/receive-messages

## Blocker 1: Production Push Notifications

Push is the main "not half done" gate. The client has registration and display scaffolding, and the server has FCM send scaffolding, but launch needs a verified production path.

### Firebase and Client Setup

- Create or select the production Firebase project.
- Add the Android app with package name `com.nimbalyst.app`.
- Download `google-services.json` and install it locally for release builds. Keep it out of git.
- [x] Decide how CI gets Firebase config for production builds:
  - decode from a GitHub secret into `packages/android/app/google-services.json`, or
  - generate the required Firebase resource values during CI.
- Confirm `FirebaseApp` initializes, `FirebaseMessaging.getInstance().token` returns a token, and Android sends `registerPushToken` after index-room connect.

### Server Setup

- Set Cloudflare secrets in `../nimbalyst-collab` for production:
  - `FCM_PROJECT_ID`
  - `FCM_CLIENT_EMAIL`
  - `FCM_PRIVATE_KEY`
- Verify the service account has permission to call Firebase Cloud Messaging HTTP v1.
- Run or add a staging smoke path that registers an Android token, triggers `requestMobilePush`, and verifies FCM accepts the message.
- Confirm bad-token cleanup works for `UNREGISTERED` and invalid tokens.

### Payload Contract Fix

Current Android service code expects to construct the notification itself from data keys (`sessionId`, `title`, `body`) and route taps through an explicit `nimbalyst://session/<id>` intent. Current server FCM code sends both `notification` and `data`.

Pick one contract before launch:

- Recommended: send Android push as data-only high-priority FCM with `title`, `body`, `sessionId`, and optional `inboxEventId` inside `data`; let `NimbalystFirebaseMessagingService` build the notification in every app state.
- Alternative: keep notification payloads but update `MainActivity` to read FCM extras on launcher intents and route to the right session/inbox event on tap.

The first option matches the existing Android service shape and avoids split foreground/background behavior.

### Android Permission UX

Current Android prompts for notification permission once after auth. That is enough for a smoke test but too blunt for launch.

Before Play:

- [x] Add a Settings notifications section matching iOS conceptually:
  - user-facing push toggle
  - denied-state explanation and deep link to Android app notification settings
  - registration status or last error in plain language
- Add a Settings notifications section matching iOS conceptually:
  - user-facing push toggle
  - denied-state explanation and deep link to Android app notification settings
  - registration status or last error in plain language
- Add `unregisterPushToken` support on Android so turning the app-level toggle off removes the server token.
- Ask for notification permission after pairing/auth when the user reaches a moment where the value is clear, not as an unexplained startup interruption.
- Replace `android.R.drawable.ic_dialog_info` with a proper monochrome notification small icon.
- Use a stable notification channel name and description appropriate for agent/session updates.
- [x] Add `unregisterPushToken` support on Android so turning the app-level toggle off removes the server token.
- [x] Ask for notification permission after pairing/auth when the user reaches a moment where the value is clear, not as an unexplained startup interruption.
- [x] Replace `android.R.drawable.ic_dialog_info` with a proper monochrome notification small icon.
- Use a stable notification channel name and description appropriate for agent/session updates.

### Push Acceptance Criteria

- Fresh install on Android 13+ asks for notification permission only after context is established.
- Grant path registers token with the production/staging sync server.
- Deny path leaves the app functional and shows a recoverable Settings state.
- Toggle-off path unregisters server token and no pushes arrive.
- App backgrounded: agent completion push appears, tap opens the correct session.
- App killed: push appears, tap opens the correct session or a safe session-list fallback.
- Foreground: no duplicate system notification if the relevant session is already visible.
- Desktop active: presence suppression prevents noisy mobile push.
- Bad/expired FCM token is removed server-side.

## Blocker 2: Play-Ready Release Artifact

Google Play launch should use AAB, even if APK artifacts remain useful for direct device smoke tests.

Required work:

- [x] Add `android:bundle:release` script that runs `./gradlew :app:bundleRelease`.
- [x] Update Android CI to build, sign, verify, and upload the release `.aab`.
- Keep APK build as a secondary test artifact if useful.
- [x] Verify the transcript bundle is inside the generated app bundle, not only the APK.
- Create a dedicated upload keystore for Play App Signing and store it in GitHub secrets.
- Establish versioning rules before first upload:
  - `versionCode` must monotonically increase for every Play upload.
  - `versionName` should match the release train, not stay at `0.1.0` after production.
- Decide whether the first external release is `0.1.x`, `1.0`, or a public beta label.

## Blocker 3: Store Compliance and Policy

Prepare the Play Console app record before code freeze so review blockers surface early.

Required Console fields and assets:

- App name: likely `Nimbalyst`, not `Nimbalyst Android`.
- Short description: position it as the mobile companion for Nimbalyst agent sessions.
- Full description: be explicit that desktop pairing is required and voice mode is not included on Android.
- Category: Productivity or Developer Tools, depending on Play Console availability.
- Screenshots:
  - onboarding/pairing
  - project list
  - session list with unread state
  - session transcript
  - prompt composer with attachment
  - settings/sync state
- Feature graphic and app icon.
- Privacy policy URL.
- Support email.
- App access instructions for reviewers:
  - provide a test account or reviewer path
  - include steps to pair with a demo desktop/server environment, or provide a demo mode if pairing cannot be externally reviewed
- Content rating questionnaire.
- Target audience and ads declaration.
- Data Safety form.

Data Safety needs a careful pass. Likely disclosures include account identifiers/email, device push token, usage analytics, crash/diagnostic data if collected, and user-generated AI session content that is end-to-end encrypted in transit/storage through Nimbalyst sync. Do not claim "no data collected" just because message content is encrypted; align the disclosure with the actual app, PostHog behavior, sync server behavior, and privacy policy.

## Blocker 4: Product Polish

These are not all equal priority, but the launch should not proceed if the first-run experience still feels like an engineering harness.

### First-Run and Account

- [x] Rename user-facing app label from `Nimbalyst Android` to `Nimbalyst`.
- [x] Ensure launch icon, adaptive icon, round icon, and splash screen are production assets.
- Make QR pairing the primary path; manual credential editing should stay hidden behind developer mode.
- Make the login/browser callback flow self-explanatory and resilient if the user returns without completing auth.
- Handle expired/invalid auth by showing a clear re-auth action, not only a sync error string.
- [x] Audit backup behavior. Android backup is disabled for launch so encrypted preferences, tokens, and local sync state are not restored across devices.

### Main Workflows

- Project list: empty state, loading state, offline/last-synced indicator.
- Session list: search/filter if feasible; otherwise clear grouping, unread badges, and useful empty states.
- Session detail: transcript loading failure should be visible; composer disabled states should explain offline/auth/sync blockers.
- Prompt submission: immediate local pending state, retry/cancel for failed queued prompt, image attachment errors in plain language.
- Interactive widgets: verify AskUserQuestion, ToolPermission, ExitPlanMode, and GitCommitProposal-like flows if exposed in transcript.
- Settings: account, sync, devices, notifications, analytics, sign out, unpair, version.

### Android Fit and Finish

- Edge-to-edge layout should avoid status/nav bar overlap on small phones and gesture nav.
- Test dark mode and dynamic font sizes.
- Test camera permission denial/permanent denial for QR scanning.
- Confirm WebView transcript performance on midrange Android hardware.
- Confirm notification channel behavior and app notification settings are understandable.

## Blocker 5: Validation Plan

### Automated

- `npm run android:build:transcript`
- `npm run android:test:unit`
- `npm run android:assemble:debug`
- `npm run android:assemble:release`
- new `npm run android:bundle:release`
- Android CI signs and verifies release AAB.
- Gated live collab sync test against `../nimbalyst-collab` for:
  - index sync
  - session sync
  - queued prompt submit
  - session-control response
  - push token registration

### Device Matrix

Minimum practical matrix:

- Android 10/API 29: min SDK behavior, no runtime notification permission.
- Android 13/API 33: notification runtime permission behavior.
- Android 15/API 35 or Android 16 preview/stable device if available: target SDK behavior.
- One low/midrange physical Android phone for WebView/performance.
- One tablet/foldable-class emulator if tablet support is in listing screenshots.

### Manual Smoke Script

1. Fresh install.
2. Pair by QR from desktop.
3. Complete auth callback.
4. Confirm project/session hydration.
5. Open a transcript with historical messages.
6. Submit prompt with no attachment.
7. Submit prompt with image attachment.
8. Answer a tool permission or AskUserQuestion widget.
9. Let desktop produce a message while Android is backgrounded; verify unread state after foreground.
10. Trigger agent completion while desktop is idle; verify push and tap routing.
11. Deny notifications, then recover through Settings.
12. Toggle analytics off and confirm app still works.
13. Sign out and unpair; confirm no stale sessions or credentials remain visible.

### Play Console Validation

- Run internal testing first and inspect Play pre-launch report.
- Fix crashes, ANRs, policy warnings, screenshot issues, and startup failures before closed/open testing.
- If using a new personal developer account, plan for the required closed-test window before production access.

## Rollout Sequence

### Slice 0: Decisions and Setup

- Freeze package id: `com.nimbalyst.app`.
- Decide release label/version strategy.
- Decide whether Android app listing says beta/early access.
- Create Firebase Android app and Play Console app.
- Confirm whether reviewer access uses real pairing, a staging desktop account, or a temporary demo path.

### Slice 1: Push End-to-End

- Install Firebase config path for local/CI builds.
- Configure FCM server secrets in staging.
- Fix Android FCM payload contract.
- Add notification settings/toggle/unregister path.
- Validate grant/deny/toggle/background/killed/tap-routing flows on device.

### Slice 2: Release Build Pipeline

- Add AAB build script and CI artifact.
- Verify Play App Signing/upload key.
- Add version bump checklist.
- Confirm signed AAB uploads to internal testing.

### Slice 3: Polish Pass

- Replace app label/icons/splash/notification icon.
- Harden first-run, auth-expired, offline, empty, and error states.
- Audit backup behavior.
- Run accessibility/dynamic type/dark-mode pass.
- Capture screenshots for the store listing from the polished app, not mockups.

### Slice 4: Internal and Closed Testing

- Internal track with a tiny trusted group first.
- Exercise full smoke script on physical Android.
- Fix Play pre-launch report issues.
- Expand to closed testing once push and account flows are boring.

### Slice 5: Production Rollout

- Submit production with staged rollout.
- Monitor:
  - Play vitals crashes/ANRs
  - Firebase push delivery failures
  - collab server push logs
  - auth callback failures
  - prompt submission failures
  - support email
- Keep first rollout small until pairing/auth/push metrics look clean.

## Suggested "Done Enough" Definition

The launch is ready when:

- A signed release AAB uploads cleanly to Play internal testing.
- A fresh tester can install, pair, authenticate, sync sessions, send a prompt, answer an interactive request, and receive a push without developer help.
- The store listing accurately describes Android scope and does not imply iOS voice parity.
- Data Safety, privacy policy, permissions, and app access instructions are complete.
- No known P0/P1 issues remain in first-run, auth, sync, prompt submission, or push.
- At least one physical-device test run covers Android 13+ notification permission and background/killed push tap routing.
