/**
 * Static check that every module packaged into app.asar can resolve the
 * dependencies its package.json declares, using Node's lookup rule (walk up
 * through enclosing node_modules directories). Runs on the asar file list, so
 * it needs no Electron and no extraction.
 *
 * Why this exists: electron-builder collects the production tree itself, and a
 * collector bug can package the wrong version of a module while every SDK and
 * native-binary check still passes. Under pnpm's hoisted layout it shipped
 * p-limit@3 where p-locate needed p-limit@2 and dropped yocto-queue, so
 * electron-store's `conf` could not load.
 */

const path = require('path');

// Dependencies a packaged module declares but never loads at runtime.
const NOT_LOADED_AT_RUNTIME = {
  // Used only by ripgrep's postinstall binary download, which never runs in the app.
  '@vscode/ripgrep': ['https-proxy-agent', 'proxy-from-env', 'yauzl'],
};

/** `/node_modules/a/node_modules/@s/b/package.json` -> { dir, name } or null. */
function parseManifestPath(file) {
  const normalized = file.split(path.sep).join('/');
  const match = /^(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\/package\.json$/.exec(normalized);
  return match ? { dir: match[1], name: match[2] } : null;
}

/**
 * @param {string[]} files asar paths, e.g. from `asar.listPackage`
 * @param {(manifestPath: string) => object | null} readManifest
 * @returns {string[]} one message per dependency that does not resolve
 */
function findUnresolvedDependencies(files, readManifest) {
  const packageDirs = new Set();
  const manifests = [];
  for (const file of files) {
    const parsed = parseManifestPath(file);
    if (!parsed) continue;
    packageDirs.add(parsed.dir);
    manifests.push({ ...parsed, file: file.split(path.sep).join('/') });
  }

  const problems = [];
  for (const { dir, name, file } of manifests) {
    const manifest = readManifest(file);
    if (!manifest || manifest.name !== name) continue;
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (NOT_LOADED_AT_RUNTIME[name]?.includes(dep)) continue;
      if (!resolves(dir, dep, packageDirs)) {
        problems.push(`${dir.replace(/^\//, '')} requires ${dep}@${manifest.dependencies[dep]}, which is not packaged where Node can find it`);
      }
    }
  }
  return problems;
}

function resolves(fromDir, dep, packageDirs) {
  let current = fromDir;
  while (true) {
    if (packageDirs.has(`${current}/node_modules/${dep}`)) return true;
    const index = current.lastIndexOf('/node_modules/');
    if (index === -1) return packageDirs.has(`/node_modules/${dep}`);
    current = current.slice(0, index);
  }
}

module.exports = { findUnresolvedDependencies };
