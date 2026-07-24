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

  if (publisherNames.length === 0) {
    throw new Error(
      'Missing build.win.signtoolOptions.publisherName in packages/electron/package.json. ' +
      'Windows auto-update verification relies on this value being bundled into app-update.yml.'
    );
  }

  console.log(
    `Windows auto-update signing config verified: ${publisherNames.join(', ')}`
  );
}

if (require.main === module) {
  validateWindowsUpdaterConfig();
}

module.exports = {
  getWindowsPublisherNames,
  validateWindowsUpdaterConfig
};
