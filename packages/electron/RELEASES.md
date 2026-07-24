# Nimbalyst Release Guide

## Overview

Nimbalyst uses an automated release system that builds, signs, notarizes, and distributes the application through GitHub Releases. The auto-update system allows users to seamlessly receive updates.

## Release Process

### 1. Version Bump

Update the version in `packages/electron/package.json`:

```json
{
  "version": "0.36.6"  // Increment as appropriate
}
```

### 2. Commit Changes

```bash
git add packages/electron/package.json
git commit -m "chore: bump version to v0.36.6"
git push
```

### 3. Create Release Tag

```bash
# Create and push a version tag
git tag v0.36.6
git push origin v0.36.6
```

This triggers the GitHub Actions workflow automatically.

### 4. GitHub Actions Workflow

The workflow (`/.github/workflows/electron-build.yml`) automatically:

1. **Builds** for all platforms (macOS, Windows, Linux)
2. **Signs** the macOS app with Developer ID certificate
3. **Notarizes** the macOS app with Apple
4. **Creates** GitHub Release with all artifacts
5. **Publishes** update manifests for auto-updater

## Auto-Update System

### How It Works

1. **Checking for Updates**
  - Automatic checks every 60 minutes (production only)
  - Manual checks via Help → "Check for Updates..."
  - Compares current version with latest GitHub Release

2. **Update Flow**
```javascript
   Check → Found → Prompt to Download → Download Progress → Prompt to Restart → Install
```

3. **Configuration** (`packages/electron/package.json`)
```json
   "publish": [
     {
       "provider": "github",
       "owner": "nimbalyst",
       "repo": "nimbalyst"
     }
   ]
```

### Update Service Features

- **Non-intrusive**: Prompts before downloading
- **Progress tracking**: Shows download progress
- **Flexible timing**: User chooses when to restart
- **Automatic installation**: Updates apply on next launch
- **Error handling**: Graceful fallback if updates fail

## Platform-Specific Details

### macOS

- **Formats**: `.dmg` (installer), `.zip` (archive)
- **Signing**: Uses Developer ID Application certificate
- **Notarization**: Required for macOS 10.15+
- **Update manifest**: `latest-mac.yml`

### Windows

- **Format**: `.exe` (NSIS installer)
- **Signing**: Uses code signing certificate (if configured)
- **Update manifest**: `latest.yml`

### Linux

- **Format**: `.AppImage` (portable application)
- **No signing required**
- **Update manifest**: `latest-linux.yml`

## Build Commands

### Local Development

```bash
# Development mode with hot reload
npm run dev

# Build without packaging
npm run build
```

### Production Builds

```bash
# macOS (local, unsigned)
npm run build:mac:local

# macOS (signed and notarized)
npm run build:mac:notarized

# Windows
npm run build:win

# Linux
npm run build:linux
```

## Release Artifacts

Each release includes:

```javascript
Release v0.36.6/
├── Preditor-0.36.6.dmg           # macOS installer
├── Preditor-0.36.6-mac.zip       # macOS archive
├── Preditor-0.36.6.exe           # Windows installer
├── Preditor-0.36.6.AppImage      # Linux portable app
├── latest-mac.yml                 # macOS update manifest
├── latest.yml                     # Windows update manifest
└── latest-linux.yml               # Linux update manifest
```

## Version Numbering

Follow semantic versioning (MAJOR.MINOR.PATCH):

- **MAJOR**: Breaking changes, major redesigns
- **MINOR**: New features, significant improvements
- **PATCH**: Bug fixes, minor improvements

Examples:
- `0.36.5` → `0.36.6` (bug fix)
- `0.36.6` → `0.37.0` (new feature)
- `0.37.0` → `1.0.0` (major release)

## Environment Variables

### Required for macOS Signing & Notarization

```bash
# Apple Developer credentials
APPLE_ID=your-apple-id@example.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
APPLE_TEAM_ID=3GYP4YJ3DH

# Certificate info
CSC_NAME="Developer ID Application: Gregory Hinkle (3GYP4YJ3DH)"
MACOS_CERTIFICATE=base64-encoded-p12
MACOS_CERTIFICATE_PWD=certificate-password
```

### GitHub Secrets Configuration

Set in repository Settings → Secrets:

- `APPLE_ID` - Apple Developer account email
- `APPLE_APP_SPECIFIC_PASSWORD` - App-specific password
- `MACOS_CERTIFICATE` - Base64-encoded .p12 certificate
- `MACOS_CERTIFICATE_PWD` - Certificate password
- `WINDOWS_CERTIFICATE` - Base64-encoded .pfx certificate (optional)
- `WINDOWS_CERTIFICATE_PWD` - Certificate password (optional)

## Troubleshooting

### Build Failures

1. **Certificate issues**
```bash
   # Verify certificate locally
   security find-identity -v -p codesigning
```

2. **Notarization failures**
  - Check Apple Developer account status
  - Verify app-specific password is valid
  - Ensure bundle ID matches certificate

3. **Auto-update not working**
  - Verify GitHub Release is published (not draft)
  - Check update manifest files are present
  - Ensure version number is higher than current

### Testing Updates

1. **Test locally** (without publishing)
```bash
   # Build and generate update files
   npm run build:mac:local
   
   # Serve update files locally
   npx http-server release -p 8080
   
   # Point app to local server (dev only)
```

2. **Test with pre-release**
  - Tag with pre-release version: `v0.37.0-beta.1`
  - Workflow creates pre-release on GitHub
  - Test with beta users before stable release

## Manual Release Process

If automation fails, create release manually:

1. Build locally for each platform
2. Sign and notarize macOS build
3. Create GitHub Release
4. Upload all artifacts and `.yml` files
5. Publish release (not draft)

## Release Checklist

- [ ] Version bumped in package.json
- [ ] Changes committed and pushed
- [ ] Tag created and pushed
- [ ] GitHub Actions workflow successful
- [ ] Release appears on GitHub
- [ ] Update manifests present
- [ ] Test auto-update from previous version
- [ ] Release notes accurate

## Support

### Logs

- **Main process**: `~/Library/Logs/Nimbalyst/main.log`
- **Updater logs**: Included in main.log
- **Development**: Check console output

### User-Facing Update Issues

Users can:
1. Check for updates manually: Help → Check for Updates
2. Download directly from GitHub Releases page
3. Check current version: Help → About

### Development Resources

- [electron-updater docs](https://www.electron.build/auto-update)
- [electron-builder docs](https://www.electron.build/)
- [GitHub Releases API](https://docs.github.com/en/rest/releases)