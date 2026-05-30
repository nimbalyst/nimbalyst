/**
 * Database Browser handlers, SQLite edition.
 *
 * Mirrors the channel surface of `DatabaseBrowserHandlers.ts` (PGLite) so the
 * renderer doesn't have to know which backend is live. The cutover wiring in
 * `initialize.ts` registers exactly one of the two sets based on the resolved
 * backend.
 *
 * NOTE: now backed by `SQLiteDatabaseProxy` — every SQLite call goes through
 * the worker_threads worker, so the main process never blocks. Methods that
 * used to reach for the raw better-sqlite3 handle (`PRAGMA table_info`, the
 * dbstat scan, the instrumentation snapshot) now use explicit proxy methods
 * (`pragmaRead`, `dashboardTableStats`, `getPerformance`). The pure-logic
 * `DatabaseBrowserSqliteBackend` class is kept for unit tests that pass a
 * plain in-process `SQLiteDatabase`; the IPC layer below uses the proxy
 * exclusively.
 */
import { safeHandle } from '../utils/ipcRegistry';
import type { SQLiteDatabase } from '../database/sqlite/SQLiteDatabase';
import type { SQLiteDatabaseProxy } from '../database/sqlite/SQLiteDatabaseProxy';
import type { SQLiteBackupService } from '../services/database/SQLiteBackupService';

/**
 * Backend deps for the IPC layer. Production passes a `SQLiteDatabaseProxy`;
 * unit tests pass an in-process `SQLiteDatabase`. The proxy is a structural
 * superset of the methods the IPC handlers actually need.
 */
export interface SqliteBrowserHandlerDeps {
  /** Live SQLite database handle (in tests) or proxy (in production). */
  sqlite: SQLiteDatabase | SQLiteDatabaseProxy;
  /** Optional backup service reference (deprecated — backup state lives in the worker now). */
  backupService?: SQLiteBackupService | null;
  /** Absolute path of `nimbalyst.sqlite` (kept for log context; the proxy owns WAL stats). */
  sqliteFilePath: string;
}

/**
 * Test-only deps. The backend class is exercised exclusively by unit tests
 * that build a real `SQLiteDatabase`; the production IPC handlers don't
 * route through this class for raw-handle dependent ops anymore. Keeping a
 * separate type avoids dragging proxy-incompatible methods into the
 * production path.
 */
export interface SqliteBrowserBackendDeps {
  sqlite: SQLiteDatabase;
}

type Sanitizer = (s: string) => string;
const sanitize: Sanitizer = (name) => name.replace(/[^a-zA-Z0-9_]/g, '');

/**
 * Pure-logic backend exposed for unit testing. Tests construct it with a
 * real `SQLiteDatabase`, so this class can still reach for getRawHandle
 * when it makes the SQL simpler (e.g. PRAGMA table_info).
 */
export class DatabaseBrowserSqliteBackend {
  constructor(private deps: SqliteBrowserBackendDeps) {}

  async listTables(): Promise<string[]> {
    const result = await this.deps.sqlite.queryReadOnly<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         AND name NOT LIKE '\\_%' ESCAPE '\\'
       ORDER BY name`,
    );
    return result.rows.map((r) => r.name);
  }

  getTableSchema(tableName: string) {
    const handle = this.deps.sqlite.getRawHandle();
    if (!handle) throw new Error('SQLite handle unavailable');
    const safeName = sanitize(tableName);
    const rows = handle.prepare(`PRAGMA table_info(${safeName})`).all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }[];
    return rows.map((r) => ({
      column_name: r.name,
      data_type: r.type,
      is_nullable: r.notnull ? 'NO' : 'YES',
      column_default: r.dflt_value,
    }));
  }

  getPrimaryKeys(tableName: string): string[] {
    const handle = this.deps.sqlite.getRawHandle();
    if (!handle) throw new Error('SQLite handle unavailable');
    const safeName = sanitize(tableName);
    const rows = handle.prepare(`PRAGMA table_info(${safeName})`).all() as {
      name: string;
      pk: number;
    }[];
    return rows.filter((r) => r.pk > 0).sort((a, b) => a.pk - b.pk).map((r) => r.name);
  }

  async getTotalDbBytes(): Promise<number> {
    const handle = this.deps.sqlite.getRawHandle();
    if (!handle) throw new Error('SQLite handle unavailable');
    const pageCount = Number(handle.pragma('page_count', { simple: true }) ?? 0);
    const pageSize = Number(handle.pragma('page_size', { simple: true }) ?? 0);
    return pageCount * pageSize;
  }

  async getTableSizeBytes(tableName: string): Promise<number> {
    const handle = this.deps.sqlite.getRawHandle();
    if (!handle) throw new Error('SQLite handle unavailable');
    try {
      const r = handle
        .prepare(`SELECT sum(pgsize) AS s FROM dbstat WHERE name = ?`)
        .get(tableName) as { s: number | null } | undefined;
      return Number(r?.s ?? 0);
    } catch {
      return 0;
    }
  }
}

/**
 * Register IPC handlers. The `sqlite` dep must be a proxy in production.
 * Casts to proxy where proxy-only methods are needed; the dashboard and
 * performance handlers depend on the worker for non-blocking execution.
 */
export function registerDatabaseBrowserSqliteHandlers(deps: SqliteBrowserHandlerDeps): void {
  const { sqlite } = deps;
  const proxy = sqlite as SQLiteDatabaseProxy;

  safeHandle('database:getTables', async () => {
    try {
      const result = await sqlite.queryReadOnly<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
           AND name NOT LIKE '\\_%' ESCAPE '\\'
         ORDER BY name`,
      );
      return { success: true, tables: result.rows.map((r) => r.name) };
    } catch (error) {
      console.error('[DatabaseBrowserSqliteHandlers] getTables error:', error);
      return { success: false, error: String(error) };
    }
  });

  safeHandle('database:getTableSchema', async (_event, tableName: string) => {
    try {
      const safeName = tableName.replace(/[^a-zA-Z0-9_]/g, '');
      const r = await sqlite.queryReadOnly<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>(`PRAGMA table_info("${safeName}")`);
      const columns = r.rows.map((row) => ({
        column_name: row.name,
        data_type: row.type,
        is_nullable: row.notnull ? 'NO' : 'YES',
        column_default: row.dflt_value,
      }));
      return { success: true, columns };
    } catch (error) {
      console.error('[DatabaseBrowserSqliteHandlers] getTableSchema error:', error);
      return { success: false, error: String(error) };
    }
  });

  safeHandle(
    'database:getTableData',
    async (
      _event,
      tableName: string,
      limit = 100,
      offset = 0,
      sortColumn?: string,
      sortDirection?: 'asc' | 'desc',
    ) => {
      try {
        const safeName = sanitize(tableName);
        const countRes = await sqlite.queryReadOnly<{ c: number }>(
          `SELECT COUNT(*) AS c FROM "${safeName}"`,
        );
        const totalCount = Number(countRes.rows[0]?.c ?? 0);

        let orderByClause = '';
        if (sortColumn) {
          const safeCol = sanitize(sortColumn);
          const direction = sortDirection === 'desc' ? 'DESC' : 'ASC';
          orderByClause = ` ORDER BY "${safeCol}" IS NULL, "${safeCol}" ${direction}`;
        }

        const dataRes = await sqlite.queryReadOnly(
          `SELECT * FROM "${safeName}"${orderByClause} LIMIT ? OFFSET ?`,
          [limit, offset],
        );
        return {
          success: true,
          rows: dataRes.rows,
          totalCount,
          limit,
          offset,
        };
      } catch (error) {
        console.error('[DatabaseBrowserSqliteHandlers] getTableData error:', error);
        return { success: false, error: String(error) };
      }
    },
  );

  safeHandle('database:executeQuery', async (_event, sql: string) => {
    try {
      const trimmed = sql.trim().toLowerCase();
      if (!trimmed.startsWith('select') && !trimmed.startsWith('with')) {
        return {
          success: false,
          error: 'Only SELECT (or WITH ... SELECT) queries are allowed.',
        };
      }
      const result = await sqlite.queryReadOnly(sql);
      return { success: true, rows: result.rows, rowCount: result.rows.length };
    } catch (error) {
      console.error('[DatabaseBrowserSqliteHandlers] executeQuery error:', error);
      return { success: false, error: String(error) };
    }
  });

  safeHandle('database:getStats', async () => {
    try {
      const stats = await sqlite.getStats();
      return { success: true, stats };
    } catch (error) {
      console.error('[DatabaseBrowserSqliteHandlers] getStats error:', error);
      return { success: false, error: String(error) };
    }
  });

  // The heavy lifting lives in the worker: one dbstat aggregate pass groups
  // by btree name, sizes from SUM(pgsize), rows from SUM(ncell). Backup
  // status is included by the worker via its in-worker SQLiteBackupService.
  safeHandle('database:getDashboardStats', async () => {
    try {
      const result = (await proxy.dashboardTableStats()) as {
        tableStats: Array<{ name: string; rowCount: number; size: string; sizeBytes: number }>;
        totalSize: string;
        totalSizeBytes: number;
        walStats: unknown;
        basicStats: { ai_sessions_count?: string; history_count?: string } & Record<string, unknown>;
      };
      // Backup status is owned by the worker now; fan-in here so the renderer
      // payload shape stays identical to the PGLite-side handler.
      let backupStatus: unknown = null;
      try {
        backupStatus = await proxy.getBackupStatusAsync();
      } catch {
        backupStatus = null;
      }
      return {
        success: true,
        ...result,
        backupStatus,
      };
    } catch (error) {
      console.error('[DatabaseBrowserSqliteHandlers] getDashboardStats error:', error);
      return { success: false, error: String(error) };
    }
  });

  safeHandle('database:getPrimaryKeys', async (_event, tableName: string) => {
    try {
      const safeName = tableName.replace(/[^a-zA-Z0-9_]/g, '');
      const r = await sqlite.queryReadOnly<{ name: string; pk: number }>(
        `PRAGMA table_info("${safeName}")`,
      );
      const primaryKeys = r.rows
        .filter((row) => row.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((row) => row.name);
      return { success: true, primaryKeys };
    } catch (error) {
      console.error('[DatabaseBrowserSqliteHandlers] getPrimaryKeys error:', error);
      return { success: false, error: String(error) };
    }
  });

  safeHandle(
    'database:updateCell',
    async (
      _event,
      tableName: string,
      primaryKeys: { column: string; value: unknown }[],
      columnName: string,
      newValue: unknown,
    ) => {
      try {
        if (!primaryKeys || primaryKeys.length === 0) {
          return { success: false, error: 'Cannot update: table has no primary key' };
        }
        const safeTable = sanitize(tableName);
        const safeColumn = sanitize(columnName);
        const whereParts: string[] = [];
        const params: unknown[] = [newValue];
        for (const pk of primaryKeys) {
          whereParts.push(`"${sanitize(pk.column)}" = ?`);
          params.push(pk.value);
        }
        const sql = `UPDATE "${safeTable}" SET "${safeColumn}" = ? WHERE ${whereParts.join(' AND ')}`;
        const result = await sqlite.query(sql, params);
        return {
          success: true,
          rowsAffected: (result as { rowsAffected?: number }).rowsAffected ?? 1,
        };
      } catch (error) {
        console.error('[DatabaseBrowserSqliteHandlers] updateCell error:', error);
        return { success: false, error: String(error) };
      }
    },
  );

  // Performance snapshot now comes from the worker so we don't reach for
  // `sqlite.getInstrumentation()` (which doesn't exist on the proxy).
  safeHandle('database:getPerformance', async (_event, opts?: { slowLimit?: number }) => {
    try {
      const slowLimit = opts?.slowLimit ?? 50;
      const result = await proxy.getPerformance(slowLimit);
      return { success: true, snapshot: result.snapshot, slowQueries: result.slowQueries };
    } catch (error) {
      console.error('[DatabaseBrowserSqliteHandlers] getPerformance error:', error);
      return { success: false, error: String(error) };
    }
  });
}
