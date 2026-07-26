# Android Marketing Screenshots and Video

Play Store screenshot and screencast capture for the Android app, using an emulator plus a debug-only screenshot mode inside the app. No Fastlane or third-party tooling — two bash scripts and `adb`. This mirrors [IOS_MARKETING_SCREENSHOTS.md](./IOS_MARKETING_SCREENSHOTS.md); read that first if you want the reasoning behind the approach.

## Quick start

```bash
npm run android:screenshots                                    # all six listing screens
npm run android:screenshots -- --screens=sessions,detail        # a subset
npm run android:screenshots -- --device=emulator-5554           # use a device that's already up
npm run android:walkthrough                                     # scripted demo video
npm run android:walkthrough -- --manual --duration=120           # record a real device you drive
```

Output lands in `packages/android/screenshots/` (gitignored — these are build artifacts, upload them to Play Console rather than committing them).

## How it works

### App side: screenshot mode

`MainActivity` checks two launch-intent extras and, when present, renders a single screen over seeded demo data instead of the normal pairing/login gate:

```bash
adb shell am start -n com.nimbalyst.app/.MainActivity \
  --ez screenshot_mode true --es screenshot_screen sessions
```

The implementation lives in the **debug source set** (`app/src/debug/java/com/nimbalyst/app/screenshots/`), with an inert stub of the same API in `app/src/release/java/`. That's the Android equivalent of iOS's `#if DEBUG`: demo data and the fake paired state cannot reach a release build, and `MainActivity` still compiles against both variants.

When screenshot mode is on:

1. `ScreenshotMode.apply()` writes placeholder pairing credentials (so the app renders as paired and authenticated) and calls `SyncManager.enterScreenshotMode()`, which freezes a "desktop connected" state and makes every network entry point inert. Nothing opens a socket.
2. Demo projects, sessions, and a full transcript are seeded into Room through the same repository calls sync uses, so the screens observe them through their normal flows.
3. `ScreenshotHost` renders the requested screen.

`SyncManager.enterScreenshotMode()` additionally checks `FLAG_DEBUGGABLE` at runtime and no-ops otherwise.

### Screens

| `--screens` value | What it shows |
| --- | --- |
| `pairing` | QR pairing / onboarding |
| `projects` | Project list with the green desktop-connected indicator |
| `sessions` | Time-grouped session list with unread dots, phase labels, running spinner |
| `detail` | Session transcript (WebView) with text, code, and tool blocks |
| `composer` | Same screen with a draft prompt in the composer |
| `settings` | Account, connected devices, notifications, analytics |
| `walkthrough` | The whole app with real navigation — used by the video script, not for stills |

### Script side

`packages/android/scripts/take-screenshots.sh` builds the transcript bundle and debug APK, boots an AVD (or uses `--device`), then for each screen force-stops the app, launches it with the extras, waits, and captures with `adb exec-out screencap -p`.

It also does the emulator hygiene that makes captures reproducible: SystemUI demo mode for a clean status bar (9:41, full battery and signal, no notification icons), animations off, and Digital Wellbeing disabled — on a freshly booted image it likes to throw an ANR dialog over the app mid-capture.

The first cold start after an install is slow enough to capture the splash screen instead of the UI, so the script does one warm-up launch before capturing anything.

## Video

`packages/android/scripts/record-walkthrough.sh` records with `adb screenrecord` (180s hard cap per recording), pulls the file, and re-encodes to H.264 with ffmpeg.

- **Demo mode (default)** boots the emulator into the `walkthrough` screen — the full app with real navigation over demo data — and drives a scripted tour with `adb input`: project list, session list, transcript, composer. Tap coordinates assume a 1080x2220 phone; adjust them for another device.
- **`--manual`** just records for `--duration` seconds while you drive a real device. Use this for the reviewer screencast, which needs the genuine paired flow (QR pairing against a desktop, a real prompt, a push notification) — screenshot mode never talks to a server, so it cannot demonstrate that.

**Play Console takes a YouTube URL, not a video file.** The store listing's promo video field and any link you put in the App access review notes both need the video hosted elsewhere; upload the mp4 (unlisted is fine) and paste the link.

## Play Console asset requirements

From [android-play-store-listing.md](../design/MobileSync/android-play-store-listing.md): 512x512 app icon, 1024x500 feature graphic, 2-8 phone screenshots. Tablet screenshots are only needed if the listing claims tablet support. Confirm the current pixel and aspect-ratio limits in Play Console at upload time — Google changes them.

## Adding a screen

1. Add a case to `ScreenshotScreen` and `ScreenshotMode.resolveScreen()` in the debug source set.
2. Route it in `ScreenshotHost`.
3. Add any content it needs to `ScreenshotDemoData` (the builders are pure and unit-tested in `ScreenshotDemoDataTest`).
4. Add the name to `ALL_SCREENS` in `take-screenshots.sh`.
