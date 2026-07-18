import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = path.join(repoRoot, 'packages', 'electron');
const errors = [];

for (const configName of ['vitest.config.js', 'vitest.config.ts']) {
  if (existsSync(path.join(electronDir, configName))) {
    errors.push(`Remove stale Electron config: packages/electron/${configName}`);
  }
}

const rootScripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts ?? {};
const electronScripts = JSON.parse(readFileSync(path.join(electronDir, 'package.json'), 'utf8')).scripts ?? {};
const requiredRootScripts = {
  'test:electron': 'vitest --config ./vitest.config.ts packages/electron/src',
  'test:electron:ui': 'vitest --config ./vitest.config.ts --ui packages/electron/src',
  'test:electron:coverage': 'vitest --config ./vitest.config.ts --coverage packages/electron/src',
  'test:electron:ai': 'vitest --config ./vitest.config.ts packages/runtime/src/ai/providers/__tests__',
};
const requiredElectronScripts = {
  test: 'npm --prefix ../.. run test:electron --',
  'test:ui': 'npm --prefix ../.. run test:electron:ui --',
  'test:watch': 'npm --prefix ../.. run test:electron --',
  'test:coverage': 'npm --prefix ../.. run test:electron:coverage --',
  'test:ai': 'npm --prefix ../.. run test:electron:ai --',
  'test:ai:watch': 'npm --prefix ../.. run test:electron:ai --',
};

for (const [name, command] of Object.entries(requiredRootScripts)) {
  if (rootScripts[name] !== command) errors.push(`Root script ${name} must be exactly "${command}".`);
}
for (const [name, command] of Object.entries(requiredElectronScripts)) {
  if (electronScripts[name] !== command) errors.push(`Electron script ${name} must be exactly "${command}".`);
}

if (errors.length) {
  console.error('[check-vitest-config-routing] Vitest routing drift detected:\n');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log('[check-vitest-config-routing] OK -- Electron tests use the root vitest.config.ts route.');
