import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '.env') });

// Per-worker re-export of the Node-ABI better-sqlite3 binary that
// vitest.globalSetup.ts cached. Worker processes don't inherit globalSetup
// env mutations, so we read it from the disk cache the global setup wrote.
if (!process.env.NIMBALYST_BETTER_SQLITE3_NATIVE) {
  const cached = path.join(
    __dirname,
    'node_modules',
    '.cache',
    'nimbalyst-better-sqlite3-node',
    'binary-path.txt',
  );
  if (fs.existsSync(cached)) {
    // Only adopt the pointer when it names a binary matching the currently
    // installed better-sqlite3 version AND this Node's ABI -- a stale pointer
    // from a previous version would otherwise load a mismatched .node and
    // crash the worker. Resolution is best-effort: better-sqlite3 may be
    // hoisted to the repo root rather than sitting in packages/electron, and a
    // throw here would take down every test file with an opaque ENOENT.
    let expectedBinaryName: string | null = null;
    try {
      const req = createRequire(path.join(__dirname, 'package.json'));
      const version = JSON.parse(
        fs.readFileSync(req.resolve('better-sqlite3/package.json'), 'utf-8'),
      ).version;
      expectedBinaryName = `better_sqlite3-v${version}-modules${process.versions.modules}-${process.platform}-${process.arch}.node`;
    } catch {
      // better-sqlite3 not resolvable -- leave the env var unset and let the
      // package's own loader deal with it.
    }

    const p = fs.readFileSync(cached, 'utf-8').trim();
    if (expectedBinaryName && p && path.basename(p) === expectedBinaryName && fs.existsSync(p)) {
      process.env.NIMBALYST_BETTER_SQLITE3_NATIVE = p;
    }
  }
}

// Mock electron for tests that import it
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    // Lifecycle event registration: several main-process modules call
    // `app.on('before-quit', ...)` at import time (e.g. WindowManager via
    // WorkspaceWatcher). Stub the EventEmitter-style surface so importing them
    // under test doesn't throw "app.on is not a function".
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
    isReady: vi.fn(() => true)
  },
  ipcRenderer: {
    send: vi.fn(),
    on: vi.fn(),
    invoke: vi.fn()
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn()
  }
}));
