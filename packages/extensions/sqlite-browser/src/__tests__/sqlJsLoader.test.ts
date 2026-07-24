import { describe, expect, it, vi } from 'vitest';
import type { InitSqlJsStatic, SqlJsStatic } from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url&inline';
import { createSqlJsLoader } from '../sqlJsLoader';

describe('SQLite Browser SQL.js loader', () => {
  it('inlines the matching browser WASM for blob-loaded extensions', () => {
    expect(sqlWasmUrl).toMatch(/^data:application\/wasm;base64,/);
  });

  it('shares an in-flight initialization and points SQL.js at the embedded WASM', async () => {
    const sql = { Database: class {} } as unknown as SqlJsStatic;
    let resolveInitialization: ((value: SqlJsStatic) => void) | undefined;
    const initializer = vi.fn((config: { locateFile: (file: string) => string }) => {
      expect(config.locateFile('sql-wasm-browser.wasm')).toBe('data:application/wasm;base64,exact-build');
      return new Promise<SqlJsStatic>((resolve) => {
        resolveInitialization = resolve;
      });
    }) as unknown as InitSqlJsStatic;
    const loadSqlJs = createSqlJsLoader(initializer, 'data:application/wasm;base64,exact-build');

    const first = loadSqlJs();
    const second = loadSqlJs();

    expect(second).toBe(first);
    expect(initializer).toHaveBeenCalledTimes(1);

    resolveInitialization?.(sql);
    await expect(first).resolves.toBe(sql);
  });

  it('retries after a failed initialization instead of caching the rejection', async () => {
    const failure = new Error('WASM initialization failed');
    const sql = { Database: class {} } as unknown as SqlJsStatic;
    const initializer = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(sql) as unknown as InitSqlJsStatic;
    const loadSqlJs = createSqlJsLoader(initializer, 'data:application/wasm;base64,exact-build');

    await expect(loadSqlJs()).rejects.toBe(failure);
    await expect(loadSqlJs()).resolves.toBe(sql);
    expect(initializer).toHaveBeenCalledTimes(2);
  });
});
