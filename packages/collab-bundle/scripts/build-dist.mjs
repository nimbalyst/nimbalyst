#!/usr/bin/env node

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const vitePackageRoot = path.dirname(require.resolve('vite/package.json'));
const viteCli = path.join(vitePackageRoot, 'bin/vite.js');

// Vite treats an inherited NODE_ENV as authoritative, even for `vite build`.
// Run the distribution build in a controlled environment so an editor process
// exporting NODE_ENV=development cannot produce development JSX artifacts.
const build = spawnSync(process.execPath, [viteCli, 'build'], {
  cwd: packageRoot,
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: 'inherit',
});

if (build.error) throw build.error;
process.exit(build.status ?? 1);
