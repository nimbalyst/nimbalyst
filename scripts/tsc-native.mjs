#!/usr/bin/env node
/**
 * Runs the native TypeScript 7 compiler with the given arguments, from the
 * caller's working directory.
 *
 * Typecheck scripts use this instead of `tsc`: the `typescript` package stays
 * on 6.x because typescript-eslint, tsup, vite-plugin-dts and the guard scripts
 * in this directory need the JS compiler API, which 7.0 does not ship.
 *
 * The root depends on the per-platform `@typescript/typescript-<os>-<arch>`
 * packages rather than on `typescript@7` itself: with the hoisted linker every
 * package shares the root `node_modules/.bin`, and a second package declaring
 * a `tsc` bin silently took over `tsc` for the build scripts too. The lookup
 * below is the one `typescript@7`'s own `lib/getExePath.js` does.
 *
 * Measured 2026-10-18: electron's `tsc --noEmit` went from 25.5s on 5.9.3 to
 * 2.9s on 7.0.2.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
let packageJson;
try {
  packageJson = createRequire(import.meta.url).resolve(`${platformPackage}/package.json`);
} catch {
  console.error(`[tsc-native] ${platformPackage} is not installed. Add it to optionalDependencies in the root package.json if this platform should be supported.`);
  process.exit(1);
}
const exe = path.join(path.dirname(packageJson), 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
if (!existsSync(exe)) {
  console.error(`[tsc-native] Executable not found: ${exe}`);
  process.exit(1);
}
const result = spawnSync(exe, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
