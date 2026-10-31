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
 * The same argument applies across architectures: an arm64 install with no
 * arm64 entry either never updates or is offered an x64 binary it cannot run.
 * electron-updater matches the `arch` field against the running process, so
 * every published artifact is listed as its own (package type, arch) pair --
 * the shape latest.yml (Windows) and latest-mac.yml already use.
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
 * Architectures to publish, in channel-file order within a package type. x64
 * leads so that it wins the top-level `path`/`sha512` fallback, matching
 * generateWindowsYml.
 */
const LINUX_ARTIFACT_ARCHITECTURES = ['x64', 'arm64'];

/**
 * The (file name, arch) pairs to look for, mirroring the `artifactName`
 * template in package.json ("${productName}-Linux-${arch}.${ext}").
 *
 * Ordered by package type first and architecture second, so the AppImage heads
 * the list whenever one was built at all -- including a release that carries an
 * arm64 AppImage alongside an x64 .deb.
 */
function linuxArtifactTargets(productName) {
  const targets = [];

  for (const extension of LINUX_ARTIFACT_EXTENSIONS) {
    for (const arch of LINUX_ARTIFACT_ARCHITECTURES) {
      targets.push({
        fileName: `${productName}-Linux-${arch}.${extension}`,
        arch,
      });
    }
  }

  return targets;
}

/**
 * Collect the Linux artifacts present in `releaseDir`, in channel-file order.
 *
 * An absent artifact is skipped rather than fatal: the per-platform CI job and
 * the release job both call this, and only the latter has every package type
 * and architecture on disk at once.
 */
function collectLinuxArtifacts(releaseDir, productName) {
  const artifacts = [];

  for (const { fileName, arch } of linuxArtifactTargets(productName)) {
    const filePath = path.join(releaseDir, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const contents = fs.readFileSync(filePath);
    artifacts.push({
      url: fileName,
      sha512: crypto.createHash('sha512').update(contents).digest('base64'),
      size: contents.length,
      arch,
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
    if (artifact.arch) {
      yaml += `    arch: ${artifact.arch}\n`;
    }
  }
  yaml += `path: ${primary.url}\n`;
  yaml += `sha512: ${primary.sha512}\n`;
  yaml += `releaseDate: '${releaseDate}'\n`;

  return yaml;
}

module.exports = {
  LINUX_ARTIFACT_EXTENSIONS,
  LINUX_ARTIFACT_ARCHITECTURES,
  linuxArtifactTargets,
  collectLinuxArtifacts,
  buildLinuxChannelYaml,
};
