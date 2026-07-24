const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function(context) {
  const { appOutDir, packager, arch } = context;
  
  if (packager.platform.name !== 'mac') {
    return;
  }

  // Check if we have signing certificates - if not, skip signing-related operations
  const hasSigningCredentials = process.env.CSC_LINK || process.env.CSC_KEY_PASSWORD || process.env.CSC_NAME;
  if (!hasSigningCredentials) {
    console.log('AfterSign: No signing credentials found, skipping certificate-dependent operations');
  }

  console.log('AfterSign: Starting JAR cleanup process...');
  console.log('AfterSign: appOutDir =', appOutDir);
  console.log('AfterSign: productName =', packager.appInfo.productName);
  
  const appPath = path.join(appOutDir, `${packager.appInfo.productName}.app`);
  console.log('AfterSign: appPath =', appPath);
  
  // Try multiple possible paths for the claude-agent-sdk module
  const possiblePaths = [
    path.join(appPath, 'Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk'),
    path.join(appPath, 'Contents/Resources/app/node_modules/@anthropic-ai/claude-agent-sdk'),
    path.join(appPath, 'Contents/Resources/node_modules/@anthropic-ai/claude-agent-sdk')
  ];

  let claudeCodePath = null;
  for (const testPath of possiblePaths) {
    console.log('AfterSign: Checking path:', testPath);
    if (fs.existsSync(testPath)) {
      claudeCodePath = testPath;
      console.log('AfterSign: Found Claude Agent SDK at:', claudeCodePath);
      break;
    }
  }

  if (!claudeCodePath) {
    console.log('AfterSign: Claude Agent SDK path not found in any of the expected locations');
    return;
  }

  // Remove ALL JAR files from the vendor directory since they may contain unsigned native code
  const vendorPath = path.join(claudeCodePath, 'vendor');
  if (fs.existsSync(vendorPath)) {
    console.log('AfterSign: Removing all JAR files from vendor directory...');
    
    function removeJarsRecursively(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          removeJarsRecursively(fullPath);
        } else if (entry.name.endsWith('.jar')) {
          console.log('AfterSign: Removing JAR:', fullPath);
          fs.unlinkSync(fullPath);
        }
      }
    }
    
    removeJarsRecursively(vendorPath);
    
    // Sign ripgrep binaries if we have signing credentials
    if (hasSigningCredentials && packager.platform.name === 'mac') {
      console.log('AfterSign: Signing ripgrep binaries...');
      // Use target architecture from electron-builder context, not host architecture
      // electron-builder arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64, 4=universal
      const targetArch = arch === 3 ? 'arm64' : 'x64';
      console.log('AfterSign: Target architecture:', targetArch, '(context.arch =', arch, ')');
      const rgBinaryDir = targetArch === 'arm64' ? 'arm64-darwin' : 'x64-darwin';
      const rgPath = path.join(vendorPath, 'ripgrep', rgBinaryDir, 'rg');
      
      if (fs.existsSync(rgPath)) {
        try {
          // Sign the ripgrep binary with hardened runtime
          const signingIdentity = process.env.CSC_NAME || 'Developer ID Application';
          const entitlementsPath = path.join(__dirname, 'entitlements.mac.plist');
          execSync(`codesign --force --sign "${signingIdentity}" --entitlements "${entitlementsPath}" --options runtime "${rgPath}"`, { stdio: 'inherit' });
          console.log('AfterSign: Successfully signed ripgrep binary with hardened runtime');
        } catch (error) {
          console.error('AfterSign: Failed to sign ripgrep binary:', error);
        }
      } else {
        console.log('AfterSign: Ripgrep binary not found at:', rgPath);
      }
    }
  }
  
  console.log('AfterSign: JAR cleanup complete');
  
  // After modifying any files, we need to re-sign the entire app bundle
  if (hasSigningCredentials && packager.platform.name === 'mac') {
    console.log('AfterSign: Re-signing the entire app bundle after modifications...');
    try {
      const signingIdentity = process.env.CSC_NAME || 'Developer ID Application';
      const entitlementsPath = path.join(__dirname, 'entitlements.mac.plist');
      
      // Re-sign the main app bundle with deep codesigning to update all nested resources
      execSync(`codesign --deep --force --sign "${signingIdentity}" --entitlements "${entitlementsPath}" --options runtime "${appPath}"`, { stdio: 'inherit' });
      console.log('AfterSign: Successfully re-signed app bundle');
    } catch (error) {
      console.error('AfterSign: Failed to re-sign app bundle:', error);
      throw error;
    }
  }
  
  // Now handle notarization (only if not skipped)
  if (process.env.SKIP_NOTARIZE !== 'true') {
    const notarizeModule = require('./notarize.js');
    await notarizeModule.default(context);
  } else {
    console.log('AfterSign: Skipping notarization (SKIP_NOTARIZE=true)');
  }
};