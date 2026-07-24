const { notarize } = require('@electron/notarize');
const path = require('path');

// Store original SKIP_NOTARIZE value before dotenv potentially overrides it
const skipNotarize = process.env.SKIP_NOTARIZE;

// Load environment variables from .env file
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (e) {
  // dotenv might not be installed, that's ok
}

// Restore SKIP_NOTARIZE if it was set before dotenv
if (skipNotarize) {
  process.env.SKIP_NOTARIZE = skipNotarize;
}

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  
  // Only notarize on macOS
  if (electronPlatformName !== 'darwin') {
    return;
  }

  // Skip notarization only if explicitly disabled
  if (process.env.SKIP_NOTARIZE === 'true') {
    console.log('Skipping notarization (SKIP_NOTARIZE=true)');
    return;
  }

  // Check if we have the required credentials
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
    console.log('Skipping notarization: APPLE_ID or APPLE_APP_SPECIFIC_PASSWORD not set');
    console.log('To notarize, set these environment variables:');
    console.log('  APPLE_ID - Your Apple ID email');
    console.log('  APPLE_APP_SPECIFIC_PASSWORD - App-specific password from appleid.apple.com');
    
    // Only fail if notarization is required
    if (process.env.REQUIRE_NOTARIZE === 'true') {
      throw new Error('Notarization credentials not configured');
    }
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log('Notarizing application...');
  console.log('App path:', appPath);
  console.log('Apple ID:', process.env.APPLE_ID);
  console.log('Team ID: 3GYP4YJ3DH');

  try {
    await notarize({
      tool: 'notarytool',
      appPath: appPath,
      teamId: '3GYP4YJ3DH',
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    });
    
    console.log('Notarization complete');
  } catch (error) {
    console.error('Notarization failed:', error);
    // Don't fail the build if notarization fails
    // This allows you to still build locally without notarizing
    if (process.env.REQUIRE_NOTARIZE === 'true') {
      throw error;
    }
  }
};