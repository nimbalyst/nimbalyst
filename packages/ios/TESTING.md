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
