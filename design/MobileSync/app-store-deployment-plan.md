---
planStatus:
  planId: plan-ios-app-store-deployment
  title: iOS App Store Deployment Plan
  status: planned
  planType: deployment
  priority: high
  owner: ghinkle
  stakeholders: []
  tags: [mobile, ios, app-store, testflight, deployment]
  created: "2026-02-15"
  updated: "2026-02-15"
  progress: 0
---

# iOS App Store Deployment Plan

## Prerequisites

### Already Complete
- [x] Native SwiftUI app with full sync functionality (65 tests passing)
- [x] Stytch OAuth authentication (Google Sign-In)
- [x] APNs push notifications (production entitlement)
- [x] App icon and splash screen assets
- [x] Production logging cleanup
- [x] Security review of encryption implementation
- [x] Development team configured (X8S24QHAT9)
- [x] Bundle ID: `com.nimbalyst.app`
- [x] XcodeGen project configuration (`project.yml`)

### Needs Completion Before Submission
- [ ] Privacy Policy URL (required by App Store)
- [ ] Support URL (required by App Store)
- [ ] App screenshots for all required device sizes
- [ ] App Store description and keywords

## Phase 1: App Store Connect Setup

### 1.1 Create App Record
- [ ] Log into [App Store Connect](https://appstoreconnect.apple.com)
- [ ] Create new app: **Nimbalyst** (or check name availability)
- [ ] Bundle ID: `com.nimbalyst.app`
- [ ] SKU: `nimbalyst-ios`
- [ ] Primary language: English (US)
- [ ] Primary category: Developer Tools
- [ ] Secondary category: Productivity

### 1.2 App Information
- [ ] Name: Nimbalyst
- [ ] Subtitle: AI Workspace Companion (max 30 chars)
- [ ] Privacy Policy URL: `https://nimbalyst.com/privacy` (need to create)
- [ ] License Agreement: Standard EULA or custom

### 1.3 Pricing
- [ ] Price: Free (initially, companion app to desktop)
- [ ] Availability: All territories

## Phase 2: Provisioning & Certificates

### 2.1 Certificates
The team ID `X8S24QHAT9` should already have:
- [ ] iOS Distribution Certificate (Apple Distribution)
- [ ] APNs Push Certificate (production) -- already configured via entitlements

### 2.2 Provisioning Profiles
- [ ] App Store Distribution provisioning profile for `com.nimbalyst.app`
- [ ] Verify: Xcode's Automatic Signing can handle this if `CODE_SIGN_STYLE: Automatic` is set (it is)
- [ ] For CI: May need manual provisioning profiles with match/fastlane

### 2.3 Entitlements Verification
Current entitlements (`NimbalystApp.entitlements`):
- `aps-environment: production` -- Push notifications

Additional capabilities to register in App Store Connect if needed:
- [ ] Push Notifications (already configured)
- [ ] Associated Domains (if deep linking from web, `nimbalyst://` scheme is URL type, not associated domain)

## Phase 3: Build & Archive

### 3.1 Transcript Web Bundle
The transcript web app must be built before archiving:
```bash
cd packages/ios
npx vite build --config vite.config.transcript.ts
```
This is handled automatically by the pre-build script in `project.yml`.

### 3.2 Archive for Distribution
```bash
# From packages/ios/NimbalystApp/
xcodegen generate
xcodebuild archive \
  -project NimbalystApp.xcodeproj \
  -scheme NimbalystApp \
  -archivePath build/NimbalystApp.xcarchive \
  -destination "generic/platform=iOS" \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM=X8S24QHAT9
```

Or via Xcode: Product > Archive.

### 3.3 Export for App Store
```bash
xcodebuild -exportArchive \
  -archivePath build/NimbalystApp.xcarchive \
  -exportPath build/export \
  -exportOptionsPlist ExportOptions.plist
```

`ExportOptions.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>X8S24QHAT9</string>
    <key>uploadBitcode</key>
    <false/>
    <key>uploadSymbols</key>
    <true/>
</dict>
</plist>
```

## Phase 4: TestFlight Beta

### 4.1 Upload Build
- [ ] Upload via Xcode Organizer or `xcrun altool`
- [ ] Wait for build processing (usually 15-30 minutes)

### 4.2 Internal Testing
- [ ] Add internal testers (team members with App Store Connect access)
- [ ] Verify on physical devices:
  - iPhone (compact layout)
  - iPad (split view layout)
- [ ] Test matrix:
  - [ ] QR pairing flow
  - [ ] Google OAuth login
  - [ ] Project/session list sync
  - [ ] Session transcript rendering (WKWebView)
  - [ ] Send prompt from mobile
  - [ ] Interactive widget responses (permissions, questions)
  - [ ] Push notification receipt and deep-linking
  - [ ] Unread state tracking
  - [ ] Pull-to-refresh
  - [ ] Offline viewing of cached sessions
  - [ ] Unpair/re-pair flow

### 4.3 External Testing (Optional)
- [ ] Create external test group
- [ ] Write beta description and what to test
- [ ] Submit for Beta App Review (required for external testers)
- [ ] Distribute to external beta testers

## Phase 5: App Store Submission

### 5.1 App Store Metadata

#### Screenshots (Required)
Generate for all required sizes:
- [ ] 6.9" (iPhone 16 Pro Max) -- 1320 x 2868
- [ ] 6.7" (iPhone 15 Plus) -- 1290 x 2796
- [ ] 6.5" (iPhone 11 Pro Max) -- 1242 x 2688
- [ ] 5.5" (iPhone 8 Plus) -- 1242 x 2208
- [ ] iPad Pro 13" -- 2048 x 2732
- [ ] iPad Pro 11" -- 1668 x 2388

Recommended screenshots:
1. Session list with projects
2. Session transcript with code rendering
3. Interactive prompt (permission or question widget)
4. iPad split view
5. QR pairing screen

#### Description
```
Nimbalyst brings your AI coding sessions to your pocket. View and interact
with your desktop AI sessions from anywhere.

- View all your AI sessions across projects
- Send prompts and respond to AI questions on the go
- Review code changes and approve tool permissions
- Receive push notifications when your AI agent needs input
- Native iOS experience with instant offline access

Nimbalyst for iOS is a companion app that syncs with Nimbalyst desktop.
A desktop installation is required for full functionality.
```

#### Keywords
`ai, coding, developer, assistant, claude, code, workspace, ide, sessions, sync`

### 5.2 App Review Compliance

#### Export Compliance (Encryption)
The app uses AES-256-GCM encryption for data sync. Apple requires:
- [ ] Answer "Yes" to "Does your app use encryption?"
- [ ] Qualifies for exemption under Category 5 Part 2 (mass-market encryption)
- [ ] File a self-classification report at [BIS SNAP-R](https://www.bis.doc.gov/index.php/policy-guidance/encryption/4-reports-and-reviews/a-annual-self-classification) if not already done
- [ ] Alternatively, declare that encryption is used solely for authentication and data protection (standard iOS exemption)

#### Privacy Declarations (App Privacy Labels)
Data collected and linked to identity:
- [ ] **Email Address** -- used for authentication (Stytch OAuth)
- [ ] **User ID** -- used for sync room routing

Data not linked to identity:
- [ ] **Device ID** -- used for push notification routing
- [ ] **Usage Data** -- crash reports (if enabled)

Data NOT collected:
- [ ] Location, contacts, health, financial, browsing history, search history, identifiers (IDFA)

#### Content Ratings
- [ ] Age Rating: 4+ (no objectionable content)

### 5.3 Submit for Review
- [ ] Select the build uploaded to TestFlight
- [ ] Add App Review notes explaining:
  - The app requires a Nimbalyst desktop installation to function
  - QR code pairing is required for initial setup
  - Provide a demo account or video showing the pairing flow
- [ ] Submit for review

### 5.4 Review Expectations
- Typical review time: 24-48 hours
- Potential rejection reasons to preempt:
  - **"App requires external hardware/software"** -- Mitigate by explaining it's a companion app (like Apple Watch apps require iPhone). Include clear messaging in the app about the desktop requirement.
  - **"Incomplete information"** -- Include detailed review notes and a video walkthrough.
  - **"Login required"** -- Provide a demo/test account or clearly explain the QR pairing requirement.

## Phase 6: Post-Launch

### 6.1 Monitoring
- [ ] Monitor crash reports in Xcode Organizer
- [ ] Monitor App Store reviews
- [ ] Track install/session metrics

### 6.2 Future Updates
- Voice mode integration
- Widget for quick session status
- Shortcuts integration
- Apple Watch companion (session notifications)

## CI/CD Considerations (Future)

### Fastlane Setup
For automated builds and submissions:
```ruby
# Fastfile
default_platform(:ios)

platform :ios do
  desc "Build and upload to TestFlight"
  lane :beta do
    # Build transcript web bundle first
    sh("cd ../.. && npx vite build --config vite.config.transcript.ts")

    build_app(
      project: "NimbalystApp.xcodeproj",
      scheme: "NimbalystApp",
      export_method: "app-store"
    )

    upload_to_testflight(
      skip_waiting_for_build_processing: true
    )
  end

  desc "Submit to App Store"
  lane :release do
    build_app(
      project: "NimbalystApp.xcodeproj",
      scheme: "NimbalystApp",
      export_method: "app-store"
    )

    deliver(
      submit_for_review: true,
      automatic_release: false
    )
  end
end
```

### GitHub Actions
```yaml
name: iOS Release
on:
  push:
    tags: ['ios-v*']
jobs:
  build:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: cd packages/ios && npx vite build --config vite.config.transcript.ts
      - run: cd packages/ios/NimbalystApp && xcodegen generate
      - uses: Apple-Actions/import-codesign-certs@v3
      - run: xcodebuild archive ...
      - run: xcrun altool --upload-app ...
```

## Timeline

| Step | Duration |
|------|----------|
| App Store Connect setup | 1 day |
| Provisioning & first archive | 1 day |
| Internal TestFlight testing | 3-5 days |
| Fix any issues found | 1-3 days |
| App Store metadata & screenshots | 1 day |
| Submit for review | 1 day |
| Apple review | 1-3 days |
| **Total** | **~2 weeks** |
