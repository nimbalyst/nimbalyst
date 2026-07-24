const fs = require('fs');
const path = require('path');

/**
 * Creates backwards-compatible copies of arm64 Mac artifacts without the architecture suffix.
 *
 * electron-updater requires architecture suffixes (arm64/x64) in filenames to correctly
 * route updates to the right architecture. However, we previously published arm64 builds
 * without the suffix (e.g., Nimbalyst-macOS.dmg), and existing download links reference
 * these names.
 *
 * This hook creates copies (not renames) so both naming schemes work:
 * - Nimbalyst-macOS-arm64.dmg (used by electron-updater for auto-updates)
 * - Nimbalyst-macOS.dmg (copy, for backwards-compatible download links)
 *
 * The latest-mac.yml only references the arch-suffixed files, so electron-updater
 * is unaffected by these copies.
 */
exports.default = async function (buildResult) {
  const { artifactPaths } = buildResult;

  console.log('afterAllArtifactBuild: Creating backwards-compatible copies...');

  const allPaths = [...artifactPaths];

  for (const artifactPath of artifactPaths) {
    const basename = path.basename(artifactPath);

    // Only process arm64 macOS artifacts (dmg and zip)
    if (!basename.includes('macOS') || !basename.includes('-arm64.')) {
      continue;
    }

    // Skip blockmap files - they're architecture-specific checksums
    if (basename.endsWith('.blockmap')) {
      continue;
    }

    // Create a copy without the architecture suffix
    const newBasename = basename.replace('-arm64.', '.');
    const newPath = path.join(path.dirname(artifactPath), newBasename);

    console.log(`  Copying ${basename} -> ${newBasename}`);
    fs.copyFileSync(artifactPath, newPath);

    allPaths.push(newPath);
  }

  console.log('afterAllArtifactBuild: Complete');

  // Return all paths (originals + copies) for publishing
  return allPaths;
};
