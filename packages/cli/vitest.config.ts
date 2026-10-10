import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));

export default defineConfig({
  // Same as scripts/build.mjs: VERSION in src/index.ts comes from package.json.
  define: { __NIM_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: [
      // Match the root config: test tracker-core's SOURCE, not its build. The
      // package's `exports` points at a gitignored `dist/`, so without this a
      // project-scoped run either exercises a stale build or fails outright on
      // a clean checkout where nothing has run `tsc -p packages/tracker-core`.
      {
        find: '@nimbalyst/tracker-core',
        replacement: path.join(repoRoot, 'packages/tracker-core/src'),
      },
      // Same for the local wiki library: its `exports` point at a gitignored `dist/`.
      {
        find: '@nimbalyst/local-wiki',
        replacement: path.join(repoRoot, 'packages/local-wiki/src/index.ts'),
      },
      // The Pages tool contract: tool names and schemas for `nim mcp`.
      {
        find: '@nimbalyst/collab-protocol',
        replacement: path.join(repoRoot, 'packages/collab-protocol/src/index.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // better-sqlite3 13 ships Node-API prebuilds, so the workspace install
    // loads under both system Node and Electron and needs no per-runtime
    // rebuild. The shared globalSetup is kept so this project run behaves
    // identically to the root suite: it probes the normal loader first and only
    // falls back to fetching an isolated prebuild for installs that predate the
    // Node-API bump. See db/nativeBinding.ts.
    globalSetup: ['../electron/vitest.globalSetup.ts'],
  },
});
