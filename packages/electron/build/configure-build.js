#!/usr/bin/env node

/**
 * Configure build settings based on environment
 * This script modifies electron-builder configuration dynamically
 * to handle signing and notarization when credentials are available
 */

const fs = require('fs');
const path = require('path');

function configureBuild() {
  console.log('Configuring build for current environment...');
  
  // Check if signing is explicitly disabled
  const signingDisabled = process.env.CSC_DISABLE === 'true';
  const skipNotarize = process.env.SKIP_NOTARIZE === 'true';
  
  // Check if we have Apple signing credentials
  // CSC_IDENTITY_AUTO_DISCOVERY tells electron-builder to find certs in keychain
  const hasAppleCertificate = !!(process.env.CSC_LINK || process.env.APPLE_CERTIFICATE || process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false');
  const hasAppleId = !!(process.env.APPLE_ID);
  const hasTeamId = !!(process.env.APPLE_TEAM_ID);
  const hasAppPassword = !!(process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_APP_PASSWORD);
  
  const canSign = !signingDisabled && hasAppleCertificate;
  const canNotarize = canSign && hasAppleId && hasTeamId && hasAppPassword && !skipNotarize;
  
  console.log('Environment check:');
  console.log(`  - Signing Disabled: ${signingDisabled ? '✓' : '✗'}`);
  console.log(`  - Skip Notarize: ${skipNotarize ? '✓' : '✗'}`);
  console.log(`  - Apple Certificate: ${hasAppleCertificate ? '✓' : '✗'}`);
  console.log(`  - Apple ID: ${hasAppleId ? '✓' : '✗'}`);
  console.log(`  - Team ID: ${hasTeamId ? '✓' : '✗'}`);
  console.log(`  - App Password: ${hasAppPassword ? '✓' : '✗'}`);
  console.log(`  - Can Sign: ${canSign ? '✓' : '✗'}`);
  console.log(`  - Can Notarize: ${canNotarize ? '✓' : '✗'}`);
  
  // Read the package.json file
  const packageJsonPath = path.join(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  // Only auto-bump for local development builds, never in CI
  // This prevents version chaos in releases
  const shouldAutoBump = process.env.AUTO_BUMP_PATCH === 'true' && !process.env.CI;
  if (shouldAutoBump) {
    const current = packageJson.version || '0.0.0';
    const parts = current.split('.').map(n => parseInt(n, 10));
    while (parts.length < 3) parts.push(0);
    
    // Add build metadata instead of changing version
    // This keeps the base version stable but adds a unique identifier
    const buildId = new Date().toISOString().replace(/[:-]/g, '').split('.')[0];
    const newVersion = `${current}+dev.${buildId}`;
    
    console.log(`Development build version: ${newVersion}`);
    packageJson.version = newVersion;
    // Also set buildVersion so CFBundleVersion increments on macOS
    packageJson.build = packageJson.build || {};
    packageJson.build.buildVersion = current; // Keep base version for CFBundleVersion
  } else {
    console.log(`Using package version: ${packageJson.version}`);
  }
  
  // Configure macOS build settings
  if (!packageJson.build || !packageJson.build.mac) {
    console.error('Error: No macOS build configuration found in package.json');
    process.exit(1);
  }
  
  if (!canSign) {
    // When we can't sign, disable hardened runtime and related features
    console.log('Configuring for unsigned build...');
    packageJson.build.mac.hardenedRuntime = false;
    packageJson.build.mac.gatekeeperAssess = false;
    // Remove signing-related entitlements when not signing
    delete packageJson.build.mac.entitlements;
    delete packageJson.build.mac.entitlementsInherit;
  } else {
    // When we can sign, enable hardened runtime with proper entitlements
    console.log('Configuring for signed build with hardened runtime...');
    packageJson.build.mac.hardenedRuntime = true;
    packageJson.build.mac.gatekeeperAssess = false;
    packageJson.build.mac.entitlements = 'build/entitlements.mac.plist';
    packageJson.build.mac.entitlementsInherit = 'build/entitlements.mac.plist';
    
    // Disable electron-builder's built-in notarization when SKIP_NOTARIZE is set
    if (skipNotarize) {
      console.log('Disabling electron-builder notarization (SKIP_NOTARIZE=true)');
      packageJson.build.mac.notarize = false;
    } else if (canNotarize) {
      console.log('Notarization will be handled by afterSign.js');
    }
  }
  
  // Write the updated package.json back
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  
  console.log('Build configuration updated successfully!');
  console.log(`Hardened Runtime: ${packageJson.build.mac.hardenedRuntime ? 'enabled' : 'disabled'}`);
  console.log(`Entitlements: ${packageJson.build.mac.entitlements || 'none'}`);
}

// Load environment variables from .env file if it exists
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (e) {
  // dotenv might not be installed or .env might not exist, that's ok
}

if (require.main === module) {
  configureBuild();
}

module.exports = { configureBuild };
