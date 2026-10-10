# Android Marketing Screenshots and Video

Play Store screenshot and screencast capture for the Android app, using an emulator plus a debug-only screenshot mode inside the app. No Fastlane or third-party tooling — two bash scripts and `adb`. This mirrors [IOS_MARKETING_SCREENSHOTS.md](./IOS_MARKETING_SCREENSHOTS.md); read that first if you want the reasoning behind the approach.

## Quick start

```bash
pnpm run android:screenshots                                    # every listing screen
pnpm run android:screenshots --screens=sessions,detail        # a subset
pnpm run android:screenshots --device=emulator-5554           # use a device that's already up
pnpm run android:screenshots --avd=Nimbalyst_Tablet_10in --out=/tmp/tablet-10   # tablet set into its own folder
pnpm run android:walkthrough                                     # scripted demo video
pnpm run android:walkthrough --manual --duration=120           # record a real device you drive
```

Output lands in `packages/android/screenshots/` (gitignored — these are build artifacts, upload them to Play Console rather than committing them), or in the folder given by `--out`.

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
2. Demo projects, sessions (including a meta agent with nested workers, a workstream, and a shared worktree), and a full transcript are seeded into Room through the same repository calls sync uses, so the screens observe them through their normal flows.
3. The desktop settings the phone keeps (model list, default model, Meta Agent gate) are written through `SettingsSyncApplier`. `SyncManager` reads them at process start, so they appear from the second launch; the script's warm-up launch covers that.
4. `ScreenshotDocuments` installs the real `DocumentSyncManager` with an in-process socket that answers the sync request with demo files encrypted under the demo key, so the Files tab and the editor run their normal sync path without a server.
5. `ScreenshotHost` hides the navigation bars (a large-screen launcher pins a taskbar of other apps' icons along the bottom) and renders the requested screen. Workspace screens run the real app shell (`NimbalystAndroidApp`) with the navigation preset, so a tablet at 700dp or wider shows the list and the detail side by side; on a tablet the session screens also select the showcase session so the detail pane is never empty.

`SyncManager.enterScreenshotMode()` additionally checks `FLAG_DEBUGGABLE` at runtime and no-ops otherwise.

### Screens

| `--screens` value | What it shows |
| --- | --- |
| `pairing` | QR pairing / onboarding |
| `projects` | Project list with the computer picker in the toolbar |
| `sessions` | Session list with the meta agent, workstream, and worktree groups expanded |
| `detail` | Session transcript (WebView) with text, code, and tool blocks |
| `composer` | Same screen with a draft prompt in the composer |
| `newsession` | New-session model picker over the session list |
| `computers` | Computer picker open: desktop, headless sandbox, offline desktop |
| `files` | The project's Files tab with two folders expanded |
| `document` | `plans/dark-mode.md` open in the document editor |
| `settings` | Account, connected devices, notifications, analytics |
| `walkthrough` | The whole app with real navigation — used by the video script, not for stills |

### Script side

`packages/android/scripts/take-screenshots.sh` builds the transcript bundle and debug APK, boots an AVD (or uses `--device`), then for each screen force-stops the app, launches it with the extras, waits, and captures with `adb exec-out screencap -p`.

Screens that need a tap the launch intent cannot express (expanding groups, switching to Files, opening the create menu or the computer picker) are driven by the script: it finds the target by visible text or content description in a `uiautomator dump` and taps its center, so the same steps work at any screen size. If you rename one of those strings, update `drive_screen` in the script.

After each capture the script flattens the PNG to 24-bit (Play rejects alpha) with ImageMagick and warns if the size breaks Play's limits.

It also does the emulator hygiene that makes captures reproducible: SystemUI demo mode for a clean status bar (9:41, full battery and signal, no notification icons), window and transition animations off, and Digital Wellbeing disabled — on a freshly booted image it likes to throw an ANR dialog over the app mid-capture. Three settings exist for this app specifically:

- The animator scale stays at 1. Compose drives progress spinners from it, and at 0 a running session's spinner renders as a stray dot. A spinner can still be caught at the short end of its arc; retake that screen if it reads as a dot.
- Night mode is on. The app is dark only but keeps the default system-bar style, so on a light-mode image the status bar icons are dark against the dark app.
- The one-time "Viewing full screen" confirmation is pre-dismissed; otherwise it covers the first capture and blocks the `uiautomator` taps.

The first cold start after an install is slow enough to capture the splash screen instead of the UI, so the script does one warm-up launch before capturing anything.

## Video

`packages/android/scripts/record-walkthrough.sh` records with `adb screenrecord` (180s hard cap per recording), pulls the file, and re-encodes to H.264 with ffmpeg.

- **Demo mode (default)** boots the emulator into the `walkthrough` screen — the full app with real navigation over demo data — and drives a scripted tour with `adb input`: project list, session list, transcript, composer. Tap coordinates assume a 1080x2220 phone; adjust them for another device.
- **`--manual`** just records for `--duration` seconds while you drive a real device. Use this for the reviewer screencast, which needs the genuine paired flow (QR pairing against a desktop, a real prompt, a push notification) — screenshot mode never talks to a server, so it cannot demonstrate that.

**Play Console takes a YouTube URL, not a video file.** The store listing's promo video field and any link you put in the App access review notes both need the video hosted elsewhere; upload the mp4 (unlisted is fine) and paste the link.

## Play Console asset requirements

From [android-play-store-listing.md](../design/MobileSync/android-play-store-listing.md): 512x512 app icon, 1024x500 feature graphic, 2-8 phone screenshots. Tablet screenshots are only needed if the listing claims tablet support.

Screenshot rules as of 2026-10 ([Play help](https://support.google.com/googleplay/android-developer/answer/9866151)), confirm at upload time since Google changes them:

- JPEG or 24-bit PNG, no alpha. Up to 8 per device type.
- Phone: each side 320-3840px, and the long side at most twice the short side. A 1080x2220 phone (2.06:1) fails this, so capture on a 16:9 phone.
- 7-inch and 10-inch tablets (large screens): each side 1080-7680px, 16:9 landscape or 9:16 portrait, at least 4 screenshots.

### AVDs

The captures use three AVDs on the `android-34` `google_apis` arm64 image, sized so the output is already 16:9 and needs no cropping:

| AVD | Base profile | Screen | Density | Layout |
| --- | --- | --- | --- | --- |
| `Nimbalyst_Phone_1080x1920` | `pixel_2` | 1080x1920 | 420 | phone |
| `Nimbalyst_Tablet_7in` | `Nexus 7 2013` | 1920x1080 landscape | 320 (960dp wide) | list + detail |
| `Nimbalyst_Tablet_10in` | `pixel_tablet` | 2560x1440 landscape | 320 (1280dp wide) | list + detail |

To recreate one: `avdmanager create avd -n <name> -k "system-images;android-34;google_apis;arm64-v8a" -d <profile>`, then in `~/.android/avd/<name>.avd/config.ini` set `hw.lcd.width`, `hw.lcd.height`, `hw.lcd.density`, `hw.initialOrientation=landscape` (tablets), `skin.name=<W>x<H>`, `skin.path=_no_skin`, and `hw.gpu.enabled=yes`.

Tablets use landscape because both panes need the width: in portrait a 7-inch tablet is under 700dp and falls back to the phone layout.

## Adding a screen

1. Add a case to `ScreenshotScreen` and `ScreenshotMode.resolveScreen()` in the debug source set.
2. Route it in `ScreenshotHost`.
3. Add any content it needs to `ScreenshotDemoData` (the builders are pure and unit-tested in `ScreenshotDemoDataTest`).
4. Add the name to `ALL_SCREENS` in `take-screenshots.sh`, and to `drive_screen` if it needs taps after launch.
