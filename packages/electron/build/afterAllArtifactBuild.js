const fs = require('fs');
const path = require('path');

/**
 * Creates backwards-compatible copies of artifacts without the architecture suffix.
 *
 * electron-updater requires architecture suffixes (arm64/x64) in filenames to correctly
 * route updates to the right architecture. However, we previously published builds
 * without the suffix (e.g., Nimbalyst-macOS.dmg, Nimbalyst-Linux.AppImage), and
 * existing download links reference these names. The historical unsuffixed artifacts
 * were arm64 on macOS and x64 on Linux, so those are the arches that get copied.
 *
 * This hook creates copies (not renames) so both naming schemes work:
 * - Nimbalyst-macOS-arm64.dmg (used by electron-updater for auto-updates)
 * - Nimbalyst-macOS.dmg (copy, for backwards-compatible download links)
 * - Nimbalyst-Linux-x64.AppImage (used by electron-updater for auto-updates)
 * - Nimbalyst-Linux.AppImage (copy, for backwards-compatible download links)
 *
 * The latest-mac.yml / latest-linux.yml only reference the arch-suffixed files,
 * so electron-updater is unaffected by these copies.
 *
 * (Windows is handled in CI instead, because the copy must be made from the
 * signed installer.)
 */
exports.default = async function (buildResult) {
  const { artifactPaths } = buildResult;

  console.log('afterAllArtifactBuild: Creating backwards-compatible copies...');

  const allPaths = [...artifactPaths];

  for (const artifactPath of artifactPaths) {
    const basename = path.basename(artifactPath);

    // Skip blockmap files - they're architecture-specific checksums
    if (basename.endsWith('.blockmap')) {
      continue;
    }

    // Create a copy without the architecture suffix, matching the arch the
    // unsuffixed name historically pointed at on each platform
    let newBasename;
    if (basename.includes('macOS') && basename.includes('-arm64.')) {
      newBasename = basename.replace('-arm64.', '.');
    } else if (basename.includes('Linux') && basename.includes('-x64.')) {
      newBasename = basename.replace('-x64.', '.');
    } else {
      continue;
    }
    const newPath = path.join(path.dirname(artifactPath), newBasename);

    console.log(`  Copying ${basename} -> ${newBasename}`);
    fs.copyFileSync(artifactPath, newPath);

    allPaths.push(newPath);
  }

  console.log('afterAllArtifactBuild: Complete');

  // Return all paths (originals + copies) for publishing
  return allPaths;
};
