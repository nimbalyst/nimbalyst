// afterPack.js - Post-packaging hook
// Prunes unused platform binaries to reduce app size, then validates that
// every dynamically-imported SDK and every spawnable native binary actually
// resolves from inside the packaged tree. The validator catches the failure
// class where the build is green but the feature is broken in production
// because the SDK's package.json/exports map is missing or unresolvable --
// something `validate-extra-resources.js` (input-only validation) cannot
// detect.

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

exports.default = async function(context) {
  const { appOutDir, packager } = context;

  const { Arch } = require('builder-util');
  const archNum = context.arch ?? packager.arch;
  const arch = archNum != null ? Arch[archNum] : process.arch;
  // Map electron-builder platform names to Node.js platform names
  const platformMap = { mac: 'darwin', windows: 'win32', linux: 'linux' };
  const platformName = platformMap[packager.platform.name] || packager.platform.name;

  // Find the resources dir - path varies by platform
  const resourcesDir = packager.platform.name === 'mac'
    ? path.join(appOutDir, `${packager.appInfo.productName}.app`, 'Contents/Resources')
    : path.join(appOutDir, 'resources');

  // Prune unused platform binaries from claude-agent-sdk vendor/ripgrep directory
  // The SDK vendors ripgrep binaries for all 6 platform/arch combos (~61MB total).
  // We only need the one matching the build target.
  const keepDir = `${arch}-${platformName}`;
  const vendorRipgrepDir = path.join(resourcesDir, 'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep');

  if (fs.existsSync(vendorRipgrepDir)) {
    const entries = fs.readdirSync(vendorRipgrepDir, { withFileTypes: true });
    let removedCount = 0;
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== keepDir) {
        fs.rmSync(path.join(vendorRipgrepDir, entry.name), { recursive: true });
        removedCount++;
      }
    }
    console.log(`AfterPack: Pruned ${removedCount} unused ripgrep platform dirs (kept ${keepDir})`);
  }

  // Prune non-target-platform SDK native binary packages.
  // npm installs all optional deps; we only need the one for the build target.
  // Each platform binary is ~200-245MB, so removing the others saves significant space.
  const targetPlatformPackage = `claude-agent-sdk-${platformName}-${arch}`;
  const unpackedNodeModules = path.join(resourcesDir, 'app.asar.unpacked/node_modules/@anthropic-ai');

  if (fs.existsSync(unpackedNodeModules)) {
    const entries = fs.readdirSync(unpackedNodeModules, { withFileTypes: true });
    let removedCount = 0;
    let removedSize = 0;
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('claude-agent-sdk-') && entry.name !== targetPlatformPackage) {
        const dirPath = path.join(unpackedNodeModules, entry.name);
        const dirSize = getDirSize(dirPath);
        fs.rmSync(dirPath, { recursive: true });
        removedCount++;
        removedSize += dirSize;
      }
    }
    if (removedCount > 0) {
      console.log(`AfterPack: Pruned ${removedCount} non-target SDK platform packages (kept ${targetPlatformPackage}, saved ${Math.round(removedSize / 1024 / 1024)}MB)`);
    }
  }

  // Also check the asar files list for platform packages
  const asarNodeModules = path.join(resourcesDir, 'app/node_modules/@anthropic-ai');
  if (fs.existsSync(asarNodeModules)) {
    const entries = fs.readdirSync(asarNodeModules, { withFileTypes: true });
    let removedCount = 0;
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('claude-agent-sdk-') && entry.name !== targetPlatformPackage) {
        fs.rmSync(path.join(asarNodeModules, entry.name), { recursive: true });
        removedCount++;
      }
    }
    if (removedCount > 0) {
      console.log(`AfterPack: Pruned ${removedCount} non-target SDK platform packages from asar`);
    }
  }

  // Ensure node-pty's `spawn-helper` is executable in the packaged tree.
  // node-pty ships via extraResources to resources/node-pty; the macOS/Linux
  // PTY path execs prebuilds/<platform-arch>/spawn-helper, and the copy into
  // the app bundle can drop the execute bit -> runtime `posix_spawnp failed`
  // and the genuine `claude` CLI terminal never starts. chmod it back here.
  // (Windows uses conpty/winpty and has no spawn-helper.)
  if (platformName === 'darwin' || platformName === 'linux') {
    const prebuildsDir = path.join(resourcesDir, 'node-pty/prebuilds');
    let fixedCount = 0;
    if (fs.existsSync(prebuildsDir)) {
      for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const helper = path.join(prebuildsDir, entry.name, 'spawn-helper');
        if (fs.existsSync(helper)) {
          fs.chmodSync(helper, 0o755);
          fixedCount++;
        }
      }
    }
    console.log(`AfterPack: ensured execute bit on ${fixedCount} node-pty spawn-helper binary(ies)`);
  }

  // Validate the packaged tree by exercising real ESM `import()` against
  // app.asar.unpacked/node_modules and verifying every native binary is
  // present + executable. Fails the build on any miss -- this is the gate
  // that catches the "build green, feature broken" failure class.
  const packagedAppPath = packager.platform.name === 'mac'
    ? path.join(appOutDir, `${packager.appInfo.productName}.app`)
    : appOutDir;

  // Pass the target platform/arch explicitly. The validator otherwise has
  // to guess from appOutDir, which silently falls back to the host arch
  // when electron-builder uses an unsuffixed output dir (e.g. release/mac/
  // for the default x64 mac build on an arm64 runner). That false negative
  // is exactly what `afterPack` already knows authoritatively from context.
  console.log(`AfterPack: Validating packaged SDKs at ${packagedAppPath} (${platformName}-${arch})`);
  const validatorScript = path.join(__dirname, 'validate-packaged-sdks.js');
  const result = spawnSync(
    process.execPath,
    [validatorScript, packagedAppPath, '--platform', platformName, '--arch', arch],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(
      `AfterPack: validate-packaged-sdks reported missing runtime dependencies in the packaged app. ` +
      `The build cannot continue -- shipping it would produce a broken release. See output above.`,
    );
  }

  // Validate that the built-in extensions actually landed in the packaged
  // tree. electron-builder's extraResources copy of packages/extensions is
  // filter-driven and can silently produce NOTHING (e.g. the minimatch 10.2.3
  // regression where `**/`-prefixed globs stopped partial-matching top-level
  // dirs, so every extension dir was pruned). That shipped ~2.5 months of
  // releases with zero bundled extensions. Assert the output here so it fails
  // the build instead of silently shipping.
  validateBundledExtensions(resourcesDir);

  console.log('AfterPack: Complete');
};

// Assert every buildable source extension made it into resources/extensions
// with its manifest.json (and dist/ when the source has one). Throws on any
// miss. Derives the expected set from packages/extensions so it auto-adapts
// as extensions are added/removed -- no hardcoded id list to drift.
exports.validateBundledExtensions = validateBundledExtensions;
function validateBundledExtensions(resourcesDir) {
  const sourceExtDir = path.join(__dirname, '..', '..', 'extensions');
  const packagedExtDir = path.join(resourcesDir, 'extensions');

  if (!fs.existsSync(sourceExtDir)) {
    console.log('AfterPack: no packages/extensions source dir found, skipping bundled-extensions check');
    return;
  }

  const expected = fs.readdirSync(sourceExtDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(sourceExtDir, e.name, 'manifest.json')))
    .map((e) => e.name);

  if (expected.length === 0) {
    console.log('AfterPack: no source extensions with a manifest.json, skipping bundled-extensions check');
    return;
  }

  const missing = [];
  for (const name of expected) {
    const manifestOk = fs.existsSync(path.join(packagedExtDir, name, 'manifest.json'));
    const sourceHasDist = fs.existsSync(path.join(sourceExtDir, name, 'dist'));
    const distOk = !sourceHasDist || fs.existsSync(path.join(packagedExtDir, name, 'dist'));
    if (!manifestOk || !distOk) {
      missing.push(`${name}${!manifestOk ? ' (manifest.json)' : ''}${manifestOk && !distOk ? ' (dist/)' : ''}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `AfterPack: ${missing.length} of ${expected.length} built-in extensions are missing from the packaged app ` +
      `at ${packagedExtDir}. The build cannot continue -- shipping it would produce a release with broken/absent ` +
      `extensions (e.g. Project Memory).\n` +
      `Missing: ${missing.join(', ')}\n` +
      `Likely cause: the extraResources copy of packages/extensions produced nothing or a partial set ` +
      `(historically a minimatch version regression breaking '**/' glob partial-matching -- keep app-builder-lib's ` +
      `minimatch pinned >= 10.2.5).`
    );
  }

  console.log(`AfterPack: verified ${expected.length} built-in extensions bundled into ${path.basename(resourcesDir)}/extensions`);
}

function getDirSize(dirPath) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += getDirSize(fullPath);
      } else {
        size += fs.statSync(fullPath).size;
      }
    }
  } catch {}
  return size;
}
