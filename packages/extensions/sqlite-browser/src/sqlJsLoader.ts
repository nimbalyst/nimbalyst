import initSqlJs, { type InitSqlJsStatic, type SqlJsStatic } from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url&inline';

type SqlJsLoader = () => Promise<SqlJsStatic>;

/**
 * Create a cached SQL.js loader backed by the exact WASM that shipped with
 * the installed package. Extension modules run from blob URLs, so the WASM
 * must stay inlined instead of resolving as a relative build asset.
 */
export function createSqlJsLoader(
  initializer: InitSqlJsStatic = initSqlJs,
  wasmUrl: string = sqlWasmUrl,
): SqlJsLoader {
  let pending: Promise<SqlJsStatic> | null = null;

  return () => {
    if (pending) return pending;

    const next = initializer({
      locateFile: () => wasmUrl,
    });
    pending = next;

    // Do not permanently cache a network, decode, or instantiation failure.
    void next.catch(() => {
      if (pending === next) pending = null;
    });

    return next;
  };
}

export const getSqlJs = createSqlJsLoader();
