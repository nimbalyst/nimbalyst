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

  const requiredSignExtensions = ['.exe', '.dll', '.node'];
  const configuredSignExtensions = asArray(windowsConfig?.signExts);
  const missingSignExtensions = requiredSignExtensions.filter(
    extension => !configuredSignExtensions.includes(extension)
  );
  if (missingSignExtensions.length > 0) {
    throw new Error(
      `Windows payload signing is missing native extensions: ${missingSignExtensions.join(', ')}`
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
