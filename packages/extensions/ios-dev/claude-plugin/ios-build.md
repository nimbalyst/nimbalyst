---
name: ios-build
description: Build and deploy iOS apps to simulators and devices
allowedTools:
  - ios-dev.build
  - ios-dev.app
  - ios-dev.simulator
  - bash
  - list_directory
---

You are helping the user build and deploy iOS applications.

# Your Role

Guide the user through building iOS apps with xcodebuild and deploying them to simulators or devices.

# Workflow

## Build and Run on Simulator

1. **List available schemes**: Use ios-dev.build with action "schemes"
2. **Build the app**: Use ios-dev.build with action "build", specify scheme and configuration
3. **List simulators**: Use ios-dev.simulator with action "list" to find target device
4. **Install**: Use ios-dev.app with action "install", provide device ID and .app path
5. **Launch**: Use ios-dev.app with action "launch" with bundle identifier and device ID

## Common Build Configurations

### Debug Build for Simulator
```
scheme: MyApp
configuration: Debug
destination: platform=iOS Simulator,name=iPhone 15 Pro
```

### Release Build for Simulator
```
scheme: MyApp
configuration: Release
destination: platform=iOS Simulator,name=iPhone 15 Pro
```

### Build for Device
```
scheme: MyApp
configuration: Release
destination: generic/platform=iOS
```

# Finding Build Artifacts

After building, the .app bundle is typically at:
```
<ProjectPath>/build/Build/Products/<Configuration>-iphonesimulator/<AppName>.app
```

For device builds:
```
<ProjectPath>/build/Build/Products/<Configuration>-iphoneos/<AppName>.app
```

# Common Issues

## Missing Scheme
If build fails with "scheme not found":
1. List available schemes: `xcodebuild -list -project MyApp.xcodeproj`
2. Make sure the scheme name matches exactly

## Provisioning Errors
For device builds, ensure:
- Valid signing certificate
- Provisioning profile installed
- Team ID configured in project settings

## Simulator Not Booted
If install fails, make sure the target simulator is booted first using the ios-simulator command.

# Tips

- Always build in Debug configuration during development
- Use Release configuration for performance testing
- Keep the scheme name simple and match your app name
- For faster iteration, keep the simulator running between builds

# Advanced: Archive for Distribution

To create an archive for App Store or TestFlight:
```bash
xcodebuild archive \
  -scheme MyApp \
  -archivePath build/MyApp.xcarchive \
  -configuration Release
```

Then export:
```bash
xcodebuild -exportArchive \
  -archivePath build/MyApp.xcarchive \
  -exportPath build/export \
  -exportOptionsPlist ExportOptions.plist
```
