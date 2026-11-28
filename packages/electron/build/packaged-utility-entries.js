/**
 * Utility-process entries main starts with `utilityProcess.fork` from inside
 * app.asar, and the check that each one, and every chunk it requires, was
 * packaged. A missing entry passes every other build step: main only fails to
 * start the child at runtime, and falls back without telling anyone.
 *
 * Runs on the asar file list (`@electron/asar` listPackage), because
 * `fs.existsSync` cannot see inside the archive.
 */

const path = require('path');

/** asar paths, relative to the archive root, with `/` separators. */
const UTILITY_PROCESS_ENTRIES = ['out/main/gitRunner.js'];

const REQUIRE_RELATIVE = /\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

function normalize(file) {
  return file.split(/[\\/]+/).filter(Boolean).join('/');
}

/**
 * @param {string[]} files asar paths, e.g. from `asar.listPackage`
 * @param {(file: string) => string} readFile reads a packaged file by asar path
 * @param {string[]} [entries]
 * @returns {string[]} one line per missing file
 */
function findMissingUtilityEntries(files, readFile, entries = UTILITY_PROCESS_ENTRIES) {
  const present = new Set(files.map(normalize));
  const missing = [];
  for (const entry of entries) {
    if (!present.has(entry)) {
      missing.push(entry);
      continue;
    }
    const code = readFile(entry);
    for (const match of code.matchAll(REQUIRE_RELATIVE)) {
      const required = path.posix.normalize(path.posix.join(path.posix.dirname(entry), match[1]));
      if (!present.has(required)) missing.push(`${required} (required by ${entry})`);
    }
  }
  return missing;
}

module.exports = { UTILITY_PROCESS_ENTRIES, findMissingUtilityEntries };
