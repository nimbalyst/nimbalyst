#!/usr/bin/env node

/**
 * Build script to bundle the PGLite worker with its dependencies
 * This creates a self-contained worker file that can run outside app.asar
 */

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

async function buildWorker() {
  const outDir = path.join(__dirname, '../out');

  // Ensure output directory exists
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, '../src/main/database/worker.js')],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: path.join(outDir, 'worker.bundle.js'),
      external: [
        'electron',
        'worker_threads',
        'path',
        'fs',
        'crypto'
      ],
      minify: false,
      sourcemap: false,
      format: 'cjs',
      loader: {
        '.node': 'file',
        '.data': 'binary',  // Embed .data files as binary
        '.wasm': 'binary',  // Embed .wasm files as binary
      },
      define: {
        // Make sure process.env is available
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
      },
    });

    // ------------------------------------------------------------------------
    // SQLite worker bundle — hosts better-sqlite3 + WriteCoordinator +
    // Instrumentation + SQLiteBackupService in a worker_threads worker so the
    // main process never blocks on a synchronous SQLite call.
    //
    // `better-sqlite3` and `electron` stay external: the binary lives in
    // node_modules at runtime and the worker shouldn't drag Electron into
    // the bundle. Schema .sql files are loaded from disk at runtime via
    // MigrationRunner so we don't embed them.
    // ------------------------------------------------------------------------
    await esbuild.build({
      entryPoints: [
        path.join(__dirname, '../src/main/database/sqlite/worker/sqliteWorker.ts'),
      ],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: path.join(outDir, 'sqlite-worker.bundle.js'),
      external: [
        'electron',
        'worker_threads',
        'path',
        'fs',
        'fs/promises',
        'crypto',
        'better-sqlite3',
      ],
      minify: false,
      sourcemap: process.env.NODE_ENV !== 'production',
      format: 'cjs',
      loader: { '.node': 'file' },
      // PGLite's ESM build references its WASM/data files via
      // `new URL("./pglite.wasm", import.meta.url)`. When esbuild bundles ESM
      // into CJS it emits `var import_meta = {}`, making `import_meta.url`
      // undefined and the `new URL(...)` call throw `Invalid URL` the first
      // time PGLite is constructed in the packaged app. Force resolution to
      // PGLite's CJS bundle, which uses an internal `__filename`-based polyfill
      // for `import.meta.url` and resolves `pglite.wasm` / `pglite.data` from
      // the same directory as the worker bundle (where we copy them below).
      alias: {
        '@electric-sql/pglite': path.join(
          __dirname,
          '../../../node_modules/@electric-sql/pglite/dist/index.cjs',
        ),
        // The worker imports a couple of leaf modules from the runtime
        // (`storage/toolOutputRetention`, ...). Those deep subpaths are not in
        // the runtime's `exports` map, so node resolution would fall back to
        // the `@nimbalyst/runtime` barrel — which drags Lexical, CSS and
        // `?raw` YAML imports into this CJS bundle and fails the build. Alias
        // the package to its source tree the way electron.vite.config.ts does,
        // so a deep import stays a single leaf module.
        '@nimbalyst/runtime': path.join(__dirname, '../../runtime/src'),
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
      },
    });

    // ------------------------------------------------------------------------
    // SQLite backup verification worker — a short-lived thread that opens one
    // backup file read-only, runs the structural check, posts the result and
    // exits. Split out of the SQLite worker because that check is synchronous
    // and multi-GB: run in-thread it stops the query message loop for a minute
    // or more. Ships beside sqlite-worker.bundle.js; the spawner locates it
    // relative to its own bundle.
    // ------------------------------------------------------------------------
    await esbuild.build({
      entryPoints: [
        path.join(__dirname, '../src/main/database/sqlite/worker/sqliteVerifyWorker.ts'),
      ],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: path.join(outDir, 'sqlite-verify-worker.bundle.js'),
      external: ['worker_threads', 'path', 'fs', 'better-sqlite3'],
      minify: false,
      sourcemap: process.env.NODE_ENV !== 'production',
      format: 'cjs',
      loader: { '.node': 'file' },
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
      },
    });

    // ------------------------------------------------------------------------
    // Recovery verification worker. Distinct from the backup verifier above:
    // that one runs `quick_check` to confirm a backup copied cleanly, which is
    // not enough to authorize replacing a live database. This one runs the full
    // `integrity_check` plus the required-schema and content-indicator checks
    // that gate a destructive restore, and it has to stay off both the main
    // thread and the query-serving thread for the same reason.
    // ------------------------------------------------------------------------
    await esbuild.build({
      entryPoints: [
        path.join(__dirname, '../src/main/database/recovery/recoveryVerifyWorker.ts'),
      ],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: path.join(outDir, 'sqlite-recovery-verify-worker.bundle.js'),
      external: ['worker_threads', 'path', 'fs', 'better-sqlite3'],
      minify: false,
      sourcemap: process.env.NODE_ENV !== 'production',
      format: 'cjs',
      loader: { '.node': 'file' },
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
      },
    });

    await esbuild.build({
      entryPoints: [
        path.join(__dirname, '../src/main/workers/historyDiffWorker.ts'),
      ],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: path.join(outDir, 'history-diff-worker.bundle.js'),
      external: ['worker_threads'],
      minify: false,
      sourcemap: process.env.NODE_ENV !== 'production',
      format: 'cjs',
    });

    // Animation GIF encoder — palette derivation and LZW encoding for
    // .anim.json exports. Off-thread because both are synchronous JS measured
    // in tens of seconds on a ten-second animation, which stops every IPC call
    // in the app while it runs.
    await esbuild.build({
      entryPoints: [
        path.join(__dirname, '../src/main/workers/gifEncodeWorker.ts'),
      ],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: path.join(outDir, 'gif-encode-worker.bundle.js'),
      external: ['worker_threads'],
      minify: false,
      sourcemap: process.env.NODE_ENV !== 'production',
      format: 'cjs',
    });

    // Reads + sha256-hashes markdown files for ProjectFileSync's manifest off
    // the main thread. Node builtins only — nothing to keep external beyond the
    // worker plumbing itself.
    await esbuild.build({
      entryPoints: [
        path.join(__dirname, '../src/main/workers/projectManifestWorker.ts'),
      ],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: path.join(outDir, 'project-manifest-worker.bundle.js'),
      external: ['worker_threads'],
      minify: false,
      sourcemap: process.env.NODE_ENV !== 'production',
      format: 'cjs',
    });

    console.log('Worker bundle created successfully at out/worker.bundle.js');
    console.log('SQLite worker bundle created successfully at out/sqlite-worker.bundle.js');
    console.log('SQLite verify worker bundle created successfully at out/sqlite-verify-worker.bundle.js');
    console.log('Recovery verify worker bundle created successfully at out/sqlite-recovery-verify-worker.bundle.js');
    console.log('History diff worker bundle created successfully at out/history-diff-worker.bundle.js');
    console.log('GIF encode worker bundle created successfully at out/gif-encode-worker.bundle.js');
    console.log('Project manifest worker bundle created successfully at out/project-manifest-worker.bundle.js');

    // Copy PGLite runtime files that are loaded dynamically at runtime
    // The binary loader embeds some files, but PGLite loads these via fs.readFile
    const pgliteDistDir = path.join(__dirname, '../../../node_modules/@electric-sql/pglite/dist');
    const filesToCopy = ['pglite.data', 'pglite.wasm'];

    for (const file of filesToCopy) {
      const src = path.join(pgliteDistDir, file);
      const dest = path.join(outDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log(`Copied ${file} to out/`);
      } else {
        console.warn(`Warning: ${file} not found at ${src}`);
      }
    }
  } catch (error) {
    console.error('Failed to build worker bundle:', error);
    process.exit(1);
  }
}

buildWorker();
