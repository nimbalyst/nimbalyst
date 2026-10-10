/**
 * Build `nim` as a self-contained bundle.
 *
 * The CLI is published to npm as ONE artifact. Everything it needs from this
 * monorepo -- `@nimbalyst/tracker-core` (the tracker record/lifecycle/key/release
 * semantics the app and the CLI must agree on), `@nimbalyst/local-wiki` (the
 * local wiki file format) and the page tool contract from `@nimbalyst/collab-protocol` --
 * is inlined into `dist` at build time. Nothing in this repo that is not
 * published to npm may appear in the tarball's `dependencies`, and inlining is
 * what guarantees that: a published `nim` carries the exact tracker semantics
 * it was compiled against, so there is no second artifact to keep in step and
 * no version pair that can drift.
 *
 * Only `better-sqlite3` stays external, and only because it is native: the npm
 * channel needs npm to fetch the prebuild for the host, and the bundled channel
 * loads the app's own copy by absolute path (see db/nativeBinding.ts). Every
 * other import is inlined, which is also what makes the bundled entry runnable
 * from `<Resources>/nim/dist/bin/`, where the only node_modules in scope is the
 * app's and it contains no js-yaml.
 *
 * Declarations still come from tsc. `types` is `dist/index.d.ts`, which
 * declares only `main` and `VERSION` and so references nothing from a package
 * a consumer will not have.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(packageDir, 'dist');
// `nim --version`, `nim mcp`'s serverInfo and the wiki-web install hint all read
// this, so it comes from package.json rather than a constant someone must bump.
const { version } = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));

rmSync(dist, { recursive: true, force: true });

// Types first: tsc also type-checks the emit, so a broken build fails here
// rather than producing a bundle nobody checked.
execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    '-p',
    'tsconfig.json',
    '--emitDeclarationOnly',
    // tsconfig turns these on for the editor; tsc refuses both alongside
    // --emitDeclarationOnly, and the bundles below carry no source anyway.
    '--sourceMap',
    'false',
    '--declarationMap',
    'false',
  ],
  { cwd: packageDir, stdio: 'inherit' },
);

await build({
  absWorkingDir: packageDir,
  entryPoints: ['src/index.ts', 'src/bin/cli.ts', 'src/bin/cli-bundled.ts'],
  outdir: 'dist',
  outbase: 'src',
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Matches `engines.node`. better-sqlite3 13's prebuilds are Node-API 10 and
  // segfault rather than erroring on an older host, so this floor is load-bearing.
  target: 'node22',
  external: ['better-sqlite3'],
  define: { __NIM_VERSION__: JSON.stringify(version) },
  // Each entry is bundled independently rather than sharing chunks: the two bin
  // entries differ only in whether they declare the bundled SQLite channel
  // before anything opens a database, and that declaration is module state.
  // Independent bundles cannot get a half-declared channel across a shared chunk.
  splitting: false,
  logLevel: 'info',
});

// The output is ESM in `.js` files, and Node decides that from the nearest
// package.json, not from the file. The npm channel inherits `"type": "module"`
// from this package -- but the desktop app copies `dist` out on its own, and
// under `<Resources>/nim/` the nearest package.json is whatever happens to be
// above it. Node then parses the entry as CommonJS and dies on the first
// `import`. Declaring the format inside `dist` makes it travel with the code.
writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
