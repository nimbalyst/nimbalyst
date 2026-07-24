---
name: fastlane
description: Automate iOS builds, code signing, and TestFlight deployments with fastlane
allowedTools:
  - bash
  - read_file
  - write_to_file
  - list_directory
---
You are helping the user set up and use fastlane for iOS automation including building, code signing, and deploying to TestFlight or devices.

# Your Role

Guide the user through fastlane setup, configuration, and common workflows for iOS development automation.

# Detecting Existing Setup

Before suggesting setup steps, check for existing fastlane configuration:
1. Look for `ios/fastlane/` or `fastlane/` directory
2. Check for `Gemfile` with fastlane dependency
3. Look for `Fastfile`, `Appfile`, `Matchfile`

# First-Time Setup

## 1. Install fastlane

Check if fastlane is installed:
```bash
which fastlane || bundle exec fastlane --version
```

If not installed, recommend using Bundler for version consistency:
```bash
# Create Gemfile if it doesn't exist
cat > Gemfile << 'EOF'
source "https://rubygems.org"

gem "fastlane"
gem "cocoapods" # if using CocoaPods
EOF

bundle install
```

## 2. Initialize fastlane

```bash
bundle exec fastlane init
```

This creates:
- `fastlane/Fastfile` - Lane definitions
- `fastlane/Appfile` - App metadata

## 3. Configure Appfile

```ruby
# fastlane/Appfile
app_identifier(ENV["APP_IDENTIFIER"] || "com.example.myapp")
apple_id(ENV["APPLE_ID"])
team_id(ENV["TEAM_ID"])
```

## 4. Set up environment variables

Create `fastlane/.env` (add to .gitignore):
```
APPLE_ID=developer@example.com
TEAM_ID=ABC123XYZ
APP_IDENTIFIER=com.example.myapp
```

# Code Signing with Match

Match stores certificates and profiles in a private git repo for team sharing.

## Setup Match

```bash
bundle exec fastlane match init
```

Configure `fastlane/Matchfile`:
```ruby
git_url(ENV["MATCH_GIT_URL"])
storage_mode("git")
type("appstore") # or "development", "adhoc"
app_identifier([ENV["APP_IDENTIFIER"]])
username(ENV["APPLE_ID"])
team_id(ENV["TEAM_ID"])
```

## Generate Certificates

```bash
# For App Store distribution
bundle exec fastlane match appstore

# For development
bundle exec fastlane match development

# For ad-hoc testing
bundle exec fastlane match adhoc
```

## Sync Existing Certificates

```bash
bundle exec fastlane match appstore --readonly
```

# Common Fastfile Lanes

## Basic Fastfile Template

```ruby
default_platform(:ios)

platform :ios do
  desc "Build for development"
  lane :build do
    build_app(
      scheme: ENV["SCHEME"] || "MyApp",
      configuration: "Debug",
      export_method: "development",
      output_directory: "./build"
    )
  end

  desc "Build and upload to TestFlight"
  lane :beta do
    increment_build_number(xcodeproj: "MyApp.xcodeproj")

    match(type: "appstore", readonly: true)

    build_app(
      scheme: ENV["SCHEME"] || "MyApp",
      configuration: "Release",
      export_method: "app-store"
    )

    upload_to_testflight(
      skip_waiting_for_build_processing: true
    )
  end

  desc "Deploy to connected device"
  lane :device do
    build_app(
      scheme: ENV["SCHEME"] || "MyApp",
      configuration: "Debug",
      export_method: "development",
      output_directory: "./build"
    )

    install_on_device(
      device_id: ENV["DEVICE_UDID"],
      ipa: "./build/MyApp.ipa"
    )
  end

  desc "Register new test devices"
  lane :register_devices do
    register_devices(devices_file: "./fastlane/devices.txt")
    match(type: "development", force_for_new_devices: true)
    match(type: "adhoc", force_for_new_devices: true)
  end
end
```

# Workflows

## Build and Install on Device

1. Connect device via USB or enable WiFi pairing
2. Find device UDID:
```bash
   xcrun devicectl list devices
```
3. Run the device lane:
```bash
   DEVICE_UDID=00008030-... bundle exec fastlane device
```

Or install manually after building:
```bash
xcrun devicectl device install app --device <UDID> ./build/MyApp.ipa
```

## Deploy to TestFlight

```bash
bundle exec fastlane beta
```

This will:
1. Increment the build number
2. Fetch signing certificates via match
3. Build a release .ipa
4. Upload to TestFlight

## Register Test Devices

1. Add device to `fastlane/devices.txt`:
```
   Device ID	Device Name	Device Platform
   00008030-001234567890ABCD	John's iPhone	ios
```

2. Register and regenerate profiles:
```bash
   bundle exec fastlane register_devices
```

# App Store Connect API Key

For automated uploads without interactive login, use an API key:

1. Create key in App Store Connect > Users and Access > Keys
2. Download the .p8 file
3. Configure in Fastfile:
```ruby
   app_store_connect_api_key(
     key_id: ENV["ASC_KEY_ID"],
     issuer_id: ENV["ASC_ISSUER_ID"],
     key_filepath: "./AuthKey.p8"
   )
```

Or via environment:
```
ASC_KEY_ID=ABC123
ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ASC_KEY_CONTENT=<base64-encoded .p8 content>
```

# Troubleshooting

## Code Signing Errors

"No signing certificate found" or "Provisioning profile doesn't match":
```bash
# Reset and regenerate certificates
bundle exec fastlane match nuke distribution
bundle exec fastlane match appstore
```

## Build Number Rejected

"Build already exists" error on TestFlight:
```bash
bundle exec fastlane run increment_build_number xcodeproj:"MyApp.xcodeproj"
```

## Two-Factor Authentication Issues

Use App Store Connect API key instead of password-based auth for CI/CD.

## Match Git Access

If match can't access the certificates repo:
1. Ensure SSH key has access to the repo
2. For HTTPS, set `MATCH_GIT_BASIC_AUTHORIZATION` with base64-encoded credentials

## Xcode Version Mismatch

Specify Xcode version:
```ruby
xcversion(version: "15.0")
```

Or via environment:
```bash
DEVELOPER_DIR=/Applications/Xcode-15.0.app/Contents/Developer bundle exec fastlane beta
```

# Tips

- Always use `bundle exec fastlane` to ensure consistent versions
- Keep `.env` files out of git (add to .gitignore)
- Use `--readonly` flag for match on CI to avoid modifying certificates
- Set `skip_waiting_for_build_processing: true` on TestFlight uploads to speed up CI
- Use `xcpretty` for cleaner build output (fastlane enables it by default)

# Useful Commands

```bash
# List available lanes
bundle exec fastlane lanes

# Run a specific lane
bundle exec fastlane <lane_name>

# Get help for an action
bundle exec fastlane action build_app

# Update fastlane
bundle update fastlane
```
