/**
 * GUI git clients do not inherit a shell's version manager: an IDE launched
 * from the Dock resolves node through the manager's `default` alias, which can
 * be older than the version the terminal uses. With engine-strict=true that
 * surfaces as an `npm ci` EBADENGINE failure, which the pre-push hook used to
 * report as lockfile drift (2026-08-01: WebStorm ran the hook under node 22
 * and blamed package-lock.json, which was in sync).
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Minimum major version in a `>=N` engines range, or null if not that shape. */
export function minimumMajor(range) {
  const match = /^>=\s*v?(\d+)/.exec(String(range ?? '').trim());
  return match ? Number(match[1]) : null;
}

/** Returns one message per engine the running toolchain is too old for. */
export function findToolchainProblems({ engines = {}, node, npm } = {}) {
  return [
    ['node', node],
    ['npm', npm],
  ].flatMap(([name, actual]) => {
    const min = minimumMajor(engines[name]);
    if (min === null || !actual) return [];
    const major = Number(String(actual).replace(/^v/, '').split('.')[0]);
    if (!Number.isFinite(major) || major >= min) return [];
    return [`${name} ${actual} is older than the required >=${min}`];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { engines } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const problems = findToolchainProblems({
    engines,
    node: process.versions.node,
    npm: process.argv[2],
  });

  if (problems.length > 0) {
    console.error('[check-toolchain] ERROR: wrong Node/npm toolchain for this repository.');
    for (const problem of problems) console.error(`[check-toolchain]   ${problem}`);
    console.error(`[check-toolchain] node resolved to: ${process.execPath}`);
    console.error('[check-toolchain] This is a PATH problem, not a lockfile problem. GUI git clients');
    console.error('[check-toolchain] (IDEs launched from the Dock) skip your shell config and fall back');
    console.error('[check-toolchain] to your version manager\'s default alias. Point that default at the');
    console.error('[check-toolchain] version in .nvmrc (e.g. `fnm default v24`, `nvm alias default 24`)');
    console.error('[check-toolchain] and restart the client, or push from a terminal.');
    process.exit(1);
  }
}
