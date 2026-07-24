# Code Signing and Notarization Guide

This guide explains how to build, sign, and notarize the Nimbalyst for macOS distribution.

## Prerequisites

1. **Apple Developer Account**: Required for code signing certificates
2. **Developer ID Application Certificate**: Install in your macOS Keychain
3. **App-Specific Password**: Generate at https://appleid.apple.com

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your Apple credentials:

```bash
cp .env.example .env
```

Edit `.env`:
```env
APPLE_ID=your-apple-id@example.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

### 3. Verify Certificate

Make sure your Developer ID Application certificate is in your keychain:

```bash
security find-identity -v -p codesigning
```

You should see something like:
```
1) XXXXXXXXXX "Developer ID Application: Your Name (3GYP4YJ3DH)"
```

## Build Commands

### Local Development Build (No Notarization)
Use this for testing signed builds locally:
```bash
npm run build:mac:local
```

### Production Build (With Notarization)
Use this for distribution:
```bash
npm run build:mac:notarized
```

### Standard Signed Build
Signs but doesn't require notarization to succeed:
```bash
npm run build:mac
```

## What Gets Signed

The build process will:
1. **Sign the main app** with your Developer ID certificate
2. **Apply hardened runtime** for notarization compatibility
3. **Sign all frameworks and binaries** within the app bundle
4. **Notarize with Apple** (unless skipped)
5. **Staple the notarization ticket** to the app

## Entitlements

The app uses these entitlements (configured in `build/entitlements.mac.plist`):
- `com.apple.security.app-sandbox`: App sandboxing
- `com.apple.security.network.client`: Network access for AI features
- `com.apple.security.files.user-selected.read-write`: File access
- `com.apple.security.cs.allow-jit`: JavaScript performance
- `com.apple.security.cs.debugger`: Development debugging

## Troubleshooting

### Certificate Not Found
If you get "Developer ID Application" not found:
1. Make sure you have the certificate installed
2. Check that it's not expired
3. Try specifying the full identity string in package.json

### Notarization Fails
Common issues:
- **Invalid credentials**: Check your APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD
- **Network issues**: Notarization requires internet access
- **Entitlements issues**: Check console output for specific entitlement errors

### App Translocation
Even without signing, the app should work thanks to `pathToFileURL` fixes. But signing prevents translocation entirely.

## Verification

After building, verify the signature:

```bash
# Check code signature
codesign -dv --verbose=4 "release/mac/Nimbalyst.app"

# Verify notarization
spctl -a -vvv -t exec "release/mac/Nimbalyst.app"
```

## Distribution

The signed and notarized app will be in:
```
release/mac/Nimbalyst.app
```

You can:
1. Zip it for direct distribution
2. Create a DMG with `create-dmg` or similar tools
3. Upload to a distribution service

## Team Configuration

Current configuration:
- **Team ID**: 3GYP4YJ3DH
- **App ID**: com.nimbalyst.electron
- **Product Name**: Nimbalyst