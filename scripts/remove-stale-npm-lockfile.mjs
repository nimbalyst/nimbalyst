import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Removes npm's hidden lockfile (node_modules/.package-lock.json) left behind
// by installs from before the repo moved to pnpm. Vite hashes the FIRST
// lockfile it finds to decide whether its optimized-deps cache is stale, and
// that npm file sorts ahead of pnpm's. pnpm never updates it, so a stale copy
// froze the dev server's dep cache: a dependency bump kept serving the old
// bundle until the cache was cleared by hand. Runs via the `prepare`
// lifecycle on `pnpm install`; it is an install artifact, never user data.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const candidates = [path.join(repoRoot, 'node_modules', '.package-lock.json')];
const packagesDir = path.join(repoRoot, 'packages');
if (existsSync(packagesDir)) {
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      candidates.push(path.join(packagesDir, entry.name, 'node_modules', '.package-lock.json'));
    }
  }
}

for (const file of candidates) {
  if (existsSync(file)) {
    rmSync(file);
    console.log(`[stale-npm-lockfile] Removed ${path.relative(repoRoot, file)}`);
  }
}
