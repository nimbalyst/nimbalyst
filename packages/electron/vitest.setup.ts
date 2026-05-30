import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

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
    const p = fs.readFileSync(cached, 'utf-8').trim();
    if (p && fs.existsSync(p)) {
      process.env.NIMBALYST_BETTER_SQLITE3_NATIVE = p;
    }
  }
}

// Mock electron for tests that import it
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0')
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

// Set test timeout
beforeAll(() => {
  vi.setConfig({ testTimeout: 10000 });
});