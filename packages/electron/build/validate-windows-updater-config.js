#!/usr/bin/env node

const path = require('path');

const packageJson = require(path.join(__dirname, '..', 'package.json'));

function asArray(value) {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function getWindowsPublisherNames() {
  return asArray(packageJson.build?.win?.signtoolOptions?.publisherName).filter(Boolean);
}

function validateWindowsUpdaterConfig() {
  const publisherNames = getWindowsPublisherNames();
  const windowsConfig = packageJson.build?.win;
  const signtoolOptions = windowsConfig?.signtoolOptions;

  if (publisherNames.length === 0) {
    throw new Error(
      'Missing build.win.signtoolOptions.publisherName in packages/electron/package.json. ' +
      'Windows auto-update verification relies on this value being bundled into app-update.yml.'
    );
  }

  if (signtoolOptions?.sign !== 'build/sign-windows.js') {
    throw new Error(
      'Windows release builds must delegate signing to build/sign-windows.js so the app payload is signed before NSIS packaging.'
    );
  }

  // signExts makes electron-builder invoke the DigiCert signer once per matching
  // file in the staged payload. Setting it to the native extensions cost 59
  // KeyLocker calls per x64 build and burned the whole yearly signing allocation
  // in a week. Windows trust only needs Nimbalyst.exe, the uninstaller and the
  // installer signed; bundled third-party binaries already carry their own
  // publisher's signature and must not be re-signed with ours.
  const configuredSignExtensions = asArray(windowsConfig?.signExts);
  if (configuredSignExtensions.length > 0) {
    throw new Error(
      `build.win.signExts must not be set (found: ${configuredSignExtensions.join(', ')}). ` +
      'Payload-wide signing multiplies DigiCert KeyLocker calls by ~30x per build.'
    );
  }

  const signingHashAlgorithms = asArray(signtoolOptions?.signingHashAlgorithms);
  if (signingHashAlgorithms.length !== 1 || signingHashAlgorithms[0] !== 'sha256') {
    throw new Error('Windows DigiCert signing must use one SHA-256 signing pass');
  }

  console.log(
    `Windows payload and updater signing config verified: ${publisherNames.join(', ')}`
  );
}

if (require.main === module) {
  validateWindowsUpdaterConfig();
}

module.exports = {
  getWindowsPublisherNames,
  validateWindowsUpdaterConfig
};
