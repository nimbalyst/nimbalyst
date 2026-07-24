# iOS Marketing Screenshots

Automated App Store screenshot capture using Xcode simulators and a built-in screenshot mode in the app itself. No Fastlane, XCUITest, or third-party tools required -- just a bash script and `xcrun simctl`.

## How It Works

The approach has two halves: **app-side support** for rendering with demo data, and a **shell script** that drives simulators to capture each screen.

### App-Side: Screenshot Mode

The app accepts two launch arguments (DEBUG builds only):

- `--screenshot-mode` -- Boots the app with an in-memory database pre-populated with realistic demo data, bypassing authentication and pairing flows entirely.
- `--screenshot-screen=<name>` -- Routes directly to a specific screen (e.g., `projects`, `sessions`, `detail`, `settings`).

When screenshot mode is active:

1. A `ScreenshotDataProvider` creates an in-memory database and inserts realistic demo content -- projects, sessions, message threads with tool use, varying timestamps grouped into "today", "yesterday", "this week", and "older" buckets.
2. A `ScreenshotHostView` reads the `--screenshot-screen` argument and renders the corresponding view in a `NavigationStack`, with `.preferredColorScheme(.dark)` hardcoded for consistent appearance.
3. `AppState.forScreenshots()` sets `isAuthenticated = true` and `isConnected = true` so all views render as if fully logged in.

This means the app shows a complete, polished UI with no empty states, loading spinners, or auth gates.

### Shell Script: Simulator Automation

A bash script orchestrates the full capture pipeline:

```bash
bash scripts/take-screenshots.sh
bash scripts/take-screenshots.sh --screens=projects,sessions
bash scripts/take-screenshots.sh --simulators="iPhone 15 Pro Max"
```

**Steps:**

1. **Build** the app for the iOS Simulator (`xcodebuild` targeting `generic/platform=iOS Simulator`).
2. **For each simulator** (e.g., iPhone 15 Pro Max, iPad Pro 13"):
  - Boot the simulator (`xcrun simctl boot`)
  - Install the app (`xcrun simctl install`)
  - Set dark appearance (`xcrun simctl ui <udid> appearance dark`)
  - Override the status bar for a clean look:
```bash
     xcrun simctl status_bar <udid> override \
       --time "9:41" --batteryState charged --batteryLevel 100 \
       --wifiBars 3 --cellularBars 4
```
  - **For each screen:**
    - Launch with arguments: `xcrun simctl launch <udid> <bundle-id> --screenshot-mode --screenshot-screen=<name>`
    - Wait for rendering (5 seconds for most screens, 12 seconds for screens with web views)
    - Capture: `xcrun simctl io <udid> screenshot <output-path>`
    - Terminate the app
  - Shut down the simulator

**Output naming:** `{simulator_name}_{screen_name}.png` (e.g., `iphone15promax_sessions.png`).

## Adapting This for Your Project

### 1. Add screenshot mode to your app

Guard it behind `#if```` DEBUG` so it never ships to production:

```swift
private let isScreenshotMode: Bool = {
    #if DEBUG
    return CommandLine.arguments.contains("--screenshot-mode")
    #else
    return false
    #endif
}()

init() {
    if isScreenshotMode {
        _appState = StateObject(wrappedValue: AppState.forScreenshots())
    } else {
        _appState = StateObject(wrappedValue: AppState())
    }
}
```

### 2. Create a demo data provider

Build a struct that populates an in-memory database with realistic content. Make timestamps relative to `Date()` so screenshots always look fresh. Cover edge cases your marketing wants to highlight -- active sessions, completed items, different states.

### 3. Create a screenshot host view

Route `--screenshot-screen=<name>` to each view you want to capture. Force a consistent color scheme.

### 4. Write the capture script

The core loop is straightforward:

```bash
for SCREEN in projects sessions detail settings; do
    xcrun simctl launch "$UDID" "$BUNDLE_ID" \
        --screenshot-mode "--screenshot-screen=$SCREEN"
    sleep 5
    xcrun simctl io "$UDID" screenshot "output/${SIM_NAME}_${SCREEN}.png"
    xcrun simctl terminate "$UDID" "$BUNDLE_ID"
done
```

### 5. Handle slow-loading content

If any screen uses a web view or async data loading, increase the sleep duration for that screen. There is no callback mechanism from the app to the script, so timing-based waits are the pragmatic solution.

## Tradeoffs

**Advantages:**
- Zero external dependencies (no Fastlane, no snapshot gem, no XCUITest)
- Fast iteration -- change demo data, rebuild, re-run
- Deterministic output -- same data every time, no flaky network calls
- Works in CI with headless simulators

**Limitations:**
- Timing-based waits can be fragile for slow-loading screens
- No interaction capture (scrolling, taps, transitions) -- static screenshots only
- Must manually keep demo data up to date as the UI evolves
