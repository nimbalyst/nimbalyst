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
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
      },
    });

    console.log('Worker bundle created successfully at out/worker.bundle.js');
    console.log('SQLite worker bundle created successfully at out/sqlite-worker.bundle.js');

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