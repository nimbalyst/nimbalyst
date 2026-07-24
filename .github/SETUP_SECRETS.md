# GitHub Actions Secrets Setup Guide

This guide explains how to set up the required secrets for building and releasing the Electron app via GitHub Actions.

## Required Secrets

### macOS Code Signing & Notarization

1. **MACOS_CERTIFICATE**
   - Your Developer ID Application certificate exported as a .p12 file and base64 encoded
   - Export from Keychain Access: Select cert → File → Export Items → .p12 format
   - Convert to base64: `base64 -i certificate.p12 | pbcopy`
   - Paste the result as the secret value

2. **MACOS_CERTIFICATE_PWD**
   - Password you set when exporting the .p12 certificate

3. **CSC_NAME**
   - Your signing identity name (e.g., "Gregory Hinkle (3GYP4YJ3DH)")
   - Find it with: `security find-identity -v -p codesigning`

4. **APPLE_ID**
   - Your Apple ID email address used for notarization

5. **APPLE_APP_SPECIFIC_PASSWORD**
   - Generate at https://appleid.apple.com
   - Sign in → Security → App-Specific Passwords → Generate
   - Use "Preditor Notarization" as the label

6. **KEYCHAIN_PASSWORD** (optional)
   - Random password for temporary keychain (workflow will generate one if not provided)

### Windows Code Signing via DigiCert KeyLocker (Optional)

7. **DIGICERT_CLIENT_CERT_BASE64**
   - DigiCert KeyLocker client authentication certificate (.p12), base64-encoded
   - Download from DigiCert ONE: Profile > Admin Profile > Client authentication certificates
   - Convert to base64: `base64 -i client_cert.p12 | pbcopy`

8. **DIGICERT_CLIENT_CERT_PW**
   - Password for the client authentication certificate

9. **DIGICERT_CLIENT_API_TOKEN**
   - API token from DigiCert ONE: Profile > Admin Profile > API key > Create API token
   - Must be scoped to KeyLocker

10. **DIGICERT_KEYPAIR_ALIAS**
    - Keypair alias from DigiCert ONE: KeyLocker > Keypairs (first column)

## How to Add Secrets to GitHub

1. Go to your repository on GitHub
2. Navigate to Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Add each secret with the exact name listed above
5. Paste the corresponding value

## Testing the Workflow

### Manual Build Test
1. Go to Actions tab in your repository
2. Select "Build and Release Electron App" workflow
3. Click "Run workflow"
4. Select whether to create a release (false for testing)
5. Monitor the build progress

### Automatic Release on Tag
1. Create a version tag: `git tag v0.36.5`
2. Push the tag: `git push origin v0.36.5`
3. The workflow will automatically build and create a release

## Auto-Update Configuration

The app is configured to:
- Check for updates every hour when running
- Show a notification when updates are available
- Allow users to manually check via Help → Check for Updates
- Download updates in the background
- Prompt to restart when update is ready

### Update Server
Updates are served from GitHub Releases. The electron-updater will:
1. Check the latest release on your GitHub repository
2. Compare versions with the running app
3. Download the appropriate installer for the platform
4. Apply the update on app restart

## Troubleshooting

### macOS Notarization Issues
- Ensure Apple ID has accepted latest agreements at https://developer.apple.com
- Verify app-specific password is valid and not revoked
- Check that Team ID (3GYP4YJ3DH) matches your certificate

### Build Failures
- Check that all required secrets are set
- Verify certificate hasn't expired
- Ensure certificate passwords are correct
- Check workflow logs for specific error messages

### Auto-Update Not Working
- Verify GitHub token has correct permissions
- Ensure releases are published (not drafts)
- Check app logs for update errors
- Verify publish configuration in package.json matches your repo