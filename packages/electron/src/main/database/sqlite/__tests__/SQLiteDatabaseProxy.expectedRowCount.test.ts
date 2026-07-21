import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electronShell = vi.hoisted(() => {
  const noop = () => undefined;
  return {
    app: {
      getAppPath: () => `${process.cwd()}\\packages\\electron`,
      getPath: () => `${process.cwd()}\\.tmp-electron-path`,
      isPackaged: false,
      quit: noop,
    },
    BrowserWindow: { getAllWindows: () => [], fromId: () => null },
  };
});
const loggerFacade = vi.hoisted(() => {
  const sink = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
  return { logger: { main: sink, database: sink } };
});

vi.mock('electron', () => electronShell);
vi.mock('../../../utils/logger', () => loggerFacade);
import { SQLiteDatabaseProxy } from '../SQLiteDatabaseProxy';

describe('SQLiteDatabaseProxy expectedRowCount transport', () => {
  let proxy: SQLiteDatabaseProxy | undefined;
  let dbDir: string | undefined;

  afterEach(async () => {
    await proxy?.close().catch(() => undefined);
    if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('rolls back a guarded prefix inside the real sqlite worker', async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim364-sqlite-proxy-'));
    proxy = new SQLiteDatabaseProxy({
      dbDir,
      schemaDir: path.resolve(__dirname, '../schemas'),
      requestTimeoutMs: 10_000,
    });
    await proxy.initialize();
    await proxy.exec('CREATE TABLE tx_guard (id TEXT PRIMARY KEY, value TEXT)');

    await expect(proxy.runTransaction([
      { sql: "INSERT INTO tx_guard(id, value) VALUES ($1, $2) RETURNING id", params: ['a', 'prefix'], expectedRowCount: 1 },
      { sql: "UPDATE tx_guard SET value = $1 WHERE id = $2 RETURNING id", params: ['miss', 'missing'], expectedRowCount: 1 },
    ])).rejects.toThrow('transaction expected row count mismatch at statement 1: expected 1, got 0');

    const result = await proxy.query<{ id: string }>('SELECT id FROM tx_guard WHERE id = $1', ['a']);
    expect(result.rows).toEqual([]);
  });
});
