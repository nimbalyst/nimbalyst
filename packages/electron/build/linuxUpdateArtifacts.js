'use strict';

/**
 * Which Linux artifacts belong in latest-linux.yml, and in what order.
 *
 * electron-updater ships one updater per Linux package type (AppImageUpdater,
 * DebUpdater) and each one picks its own artifact out of the single
 * latest-linux.yml channel file by matching the file extension. Listing only
 * the AppImage -- all this did before we started shipping a .deb for #1430 --
 * leaves a .deb install with no matching entry, so it silently never updates.
 *
 * Kept out of generate-update-yml.js because that script runs its whole
 * pipeline on require (and process.exit(1)s on a missing release directory),
 * so nothing in it can be exercised from a test.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Package types to publish, in channel-file order. The first artifact that is
 * actually present becomes the channel file's top-level `path`/`sha512`, so the
 * AppImage stays first: already-installed AppImage clients keep reading exactly
 * the shape they read before the .deb existed.
 */
const LINUX_ARTIFACT_EXTENSIONS = ['AppImage', 'deb'];

/**
 * The filenames to look for, mirroring the `artifactName` template in
 * package.json ("${productName}-Linux.${ext}").
 */
function linuxArtifactFileNames(productName) {
  return LINUX_ARTIFACT_EXTENSIONS.map((extension) => `${productName}-Linux.${extension}`);
}

/**
 * Collect the Linux artifacts present in `releaseDir`, in channel-file order.
 *
 * An absent artifact is skipped rather than fatal: the per-platform CI job and
 * the release job both call this, and only the latter has every package type on
 * disk at once.
 */
function collectLinuxArtifacts(releaseDir, productName) {
  const artifacts = [];

  for (const fileName of linuxArtifactFileNames(productName)) {
    const filePath = path.join(releaseDir, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const contents = fs.readFileSync(filePath);
    artifacts.push({
      url: fileName,
      sha512: crypto.createHash('sha512').update(contents).digest('base64'),
      size: contents.length,
    });
  }

  return artifacts;
}

/**
 * Serialize the channel file. `artifacts` must already be in channel-file order.
 */
function buildLinuxChannelYaml(version, artifacts, releaseDate) {
  if (artifacts.length === 0) {
    throw new Error('buildLinuxChannelYaml requires at least one artifact');
  }

  const primary = artifacts[0];

  let yaml = `version: ${version}\n`;
  yaml += 'files:\n';
  for (const artifact of artifacts) {
    yaml += `  - url: ${artifact.url}\n`;
    yaml += `    sha512: ${artifact.sha512}\n`;
    yaml += `    size: ${artifact.size}\n`;
  }
  yaml += `path: ${primary.url}\n`;
  yaml += `sha512: ${primary.sha512}\n`;
  yaml += `releaseDate: '${releaseDate}'\n`;

  return yaml;
}

module.exports = {
  LINUX_ARTIFACT_EXTENSIONS,
  linuxArtifactFileNames,
  collectLinuxArtifacts,
  buildLinuxChannelYaml,
};
