#!/usr/bin/env node
/**
 * Two steps:
 *
 * 1. Regenerate `src/builtinCatalog.json` by running the desktop's own
 *    `parseBuiltinTrackers()` (runtime `ModelLoader.ts`) over the bundled
 *    builtin YAML. The JSON is committed: a runtime test compares it with
 *    `parseBuiltinTrackers()`, so a YAML edit that skipped this step fails the
 *    gate instead of letting the server and desktops drift.
 * 2. Bundle `src/index.ts` into one Worker-safe ESM file. Parsing at step 1
 *    keeps the YAML parser's work out of the Worker; what ships is data.
 *
 * `--catalog-only` stops after step 1. The bundle fails if React, CSS or any
 * `.tsx` module reaches the graph.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.resolve(packageRoot, '..');

// The workspace packages' `exports` point at `dist/`, which may not be built;
// both steps read their sources directly.
const alias = {
  '@nimbalyst/tracker-schema': path.join(packagesDir, 'tracker-schema/src/index.ts'),
  '@nimbalyst/tracker-core': path.join(packagesDir, 'tracker-core/src/index.ts'),
};

/** Vite's `?raw` suffix, which `ModelLoader.ts` uses for the builtin YAML. */
const rawTextPlugin = {
  name: 'raw-text',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-text',
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

async function generateCatalog() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'tracker-builtins-'));
  const outfile = path.join(tmp, 'catalog.mjs');
  try {
    await build({
      stdin: {
        contents: `export { parseBuiltinTrackers } from ${JSON.stringify(path.join(packagesDir, 'runtime/src/plugins/TrackerPlugin/models/ModelLoader.ts'))};`,
        resolveDir: packageRoot,
        loader: 'ts',
      },
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      alias,
      plugins: [rawTextPlugin],
      logLevel: 'warning',
    });
    const { parseBuiltinTrackers } = await import(pathToFileURL(outfile).href);
    // A JSON round trip, so the file holds exactly what a consumer reads back.
    const models = JSON.parse(JSON.stringify(parseBuiltinTrackers()));
    await writeFile(path.join(packageRoot, 'src/builtinCatalog.json'), `${JSON.stringify(models, null, 2)}\n`);
    console.log(`[tracker-builtins] src/builtinCatalog.json ${models.length} types: ${models.map((m) => m.type).join(', ')}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const FORBIDDEN_INPUT = /(\.tsx$|\.css$|node_modules\/(react|react-dom|jotai|lexical|@lexical)\/)/;

async function bundle() {
  const result = await build({
    absWorkingDir: packageRoot,
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    mainFields: ['module', 'main'],
    conditions: ['production', 'import', 'default'],
    define: { 'process.env.NODE_ENV': '"production"' },
    alias,
    minify: true,
    sourcemap: true,
    metafile: true,
    legalComments: 'none',
    logLevel: 'warning',
  });

  const forbidden = Object.keys(result.metafile.inputs).filter((input) => FORBIDDEN_INPUT.test(input));
  if (forbidden.length > 0) {
    console.error('[tracker-builtins] forbidden modules reached the Worker bundle:');
    for (const input of forbidden) console.error(`  ${input}`);
    process.exit(1);
  }

  const bytes = result.metafile.outputs['dist/index.js'].bytes;
  console.log(`[tracker-builtins] dist/index.js ${(bytes / 1024).toFixed(0)} KiB, ${Object.keys(result.metafile.inputs).length} inputs`);
}

await generateCatalog();
if (!process.argv.includes('--catalog-only')) await bundle();
