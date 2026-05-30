import { safeHandle } from '../utils/ipcRegistry';
import { database } from '../database/initialize';

export function registerDatabaseBrowserHandlers() {
    // Get list of all tables in the database
    safeHandle('database:getTables', async () => {
        try {
            const result = await database.query<{ tablename: string }>(
                `SELECT tablename FROM pg_catalog.pg_tables
                 WHERE schemaname = 'public'
                 ORDER BY tablename`
            );
            return { success: true, tables: result.rows.map(r => r.tablename) };
        } catch (error) {
            console.error('[DatabaseBrowserHandlers] Error fetching tables:', error);
            return { success: false, error: String(error) };
        }
    });

    // Get table schema (columns and types)
    safeHandle('database:getTableSchema', async (event, tableName: string) => {
        try {
            const result = await database.query<{
                column_name: string;
                data_type: string;
                is_nullable: string;
                column_default: string | null;
            }>(
                `SELECT column_name, data_type, is_nullable, column_default
                 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = $1
                 ORDER BY ordinal_position`,
                [tableName]
            );
            return { success: true, columns: result.rows };
        } catch (error) {
            console.error('[DatabaseBrowserHandlers] Error fetching table schema:', error);
            return { success: false, error: String(error) };
        }
    });

    // Get table data with pagination and sorting
    safeHandle('database:getTableData', async (event, tableName: string, limit: number = 100, offset: number = 0, sortColumn?: string, sortDirection?: 'asc' | 'desc') => {
        try {
            // Get total count
            const countResult = await database.query<{ count: string }>(
                `SELECT COUNT(*) as count FROM ${tableName}`
            );
            const totalCount = parseInt(countResult.rows[0].count);

            // Build ORDER BY clause if sorting is specified
            let orderByClause = '';
            if (sortColumn) {
                // Sanitize column name to prevent SQL injection
                const sanitizedColumn = sortColumn.replace(/[^a-zA-Z0-9_]/g, '');
                const direction = sortDirection === 'desc' ? 'DESC' : 'ASC';
                orderByClause = ` ORDER BY "${sanitizedColumn}" ${direction} NULLS LAST`;
            }

            // Get paginated data with optional sorting
            const dataResult = await database.query(
                `SELECT * FROM ${tableName}${orderByClause} LIMIT $1 OFFSET $2`,
                [limit, offset]
            );

            return {
                success: true,
                rows: dataResult.rows,
                totalCount,
                limit,
                offset
            };
        } catch (error) {
            console.error('[DatabaseBrowserHandlers] Error fetching table data:', error);
            return { success: false, error: String(error) };
        }
    });

    // Execute arbitrary SQL query
    safeHandle('database:executeQuery', async (event, sql: string) => {
        try {
            // Safety check: only allow SELECT queries
            const trimmedSQL = sql.trim().toLowerCase();
            if (!trimmedSQL.startsWith('select')) {
                return {
                    success: false,
                    error: 'Only SELECT queries are allowed in the Database Browser.'
                };
            }

            const result = await database.query(sql);

            return {
                success: true,
                rows: result.rows,
                rowCount: result.rows.length
            };
        } catch (error) {
            console.error('[DatabaseBrowserHandlers] Error executing query:', error);
            return { success: false, error: String(error) };
        }
    });

    // Get database stats
    safeHandle('database:getStats', async () => {
        try {
            const stats = await database.getStats();
            return { success: true, stats };
        } catch (error) {
            console.error('[DatabaseBrowserHandlers] Error fetching database stats:', error);
            return { success: false, error: String(error) };
        }
    });

    // Get comprehensive dashboard stats
    safeHandle('database:getDashboardStats', async () => {
        try {
            // Get list of tables first
            const tablesResult = await database.query<{ tablename: string }>(
                `SELECT tablename FROM pg_catalog.pg_tables
                 WHERE schemaname = 'public'
                 ORDER BY tablename`
            );

            // Get row counts and sizes for each table
            const tableStats: Array<{
                name: string;
                rowCount: number;
                size: string;
                sizeBytes: number;
            }> = [];

            for (const table of tablesResult.rows) {
                const tableName = table.tablename;
                try {
                    // Get actual row count
                    const countResult = await database.query<{ count: string }>(
                        `SELECT COUNT(*) as count FROM "${tableName}"`
                    );
                    // Get table size (including TOAST and indexes)
                    const sizeResult = await database.query<{ size: string; size_bytes: string }>(`
                        SELECT
                            pg_size_pretty(pg_total_relation_size('"${tableName}"')) as size,
                            pg_total_relation_size('"${tableName}"') as size_bytes
                    `);

                    tableStats.push({
                        name: tableName,
                        rowCount: parseInt(countResult.rows[0]?.count) || 0,
                        size: sizeResult.rows[0]?.size || '0 bytes',
                        sizeBytes: parseInt(sizeResult.rows[0]?.size_bytes) || 0
                    });
                } catch (err) {
                    // If we fail to get stats for a table, add it with zeros
                    tableStats.push({
                        name: tableName,
                        rowCount: 0,
                        size: '0 bytes',
                        sizeBytes: 0
                    });
                }
            }

            // Sort by size descending
            tableStats.sort((a, b) => b.sizeBytes - a.sizeBytes);

            // Get total database size
            const dbSizeResult = await database.query<{ size: string; size_bytes: string }>(`
                SELECT
                    pg_size_pretty(pg_database_size(current_database())) as size,
                    pg_database_size(current_database()) as size_bytes
            `);

            // Get basic stats (session count, etc.)
            const basicStats = await database.getStats();

            // Get backup status
            const backupService = database.getBackupService();
            let backupStatus = null;
            if (backupService) {
                backupStatus = backupService.getBackupStatus?.() ?? null;
            }

            // Get WAL stats. PGLite runs Postgres in --single mode with no background
            // checkpointer, so WAL only shrinks via explicit CHECKPOINT calls. Surfacing
            // the current size (and the min/max bounds) here makes it possible to spot
            // when the maintenance loop has fallen behind.
            let walStats: {
                fileCount: number;
                totalBytes: number;
                totalSize: string;
                minWalSize: string;
                maxWalSize: string;
                checkpointTimeout: string;
                description: string;
            } | null = null;
            try {
                const walResult = await database.query<{
                    file_count: string;
                    total_bytes: string;
                    total_size: string;
                    min_wal_size: string;
                    max_wal_size: string;
                    checkpoint_timeout: string;
                }>(`
                    SELECT
                        (SELECT count(*) FROM pg_ls_waldir()) as file_count,
                        (SELECT sum(size)::bigint FROM pg_ls_waldir()) as total_bytes,
                        (SELECT pg_size_pretty(sum(size)::bigint) FROM pg_ls_waldir()) as total_size,
                        current_setting('min_wal_size') as min_wal_size,
                        current_setting('max_wal_size') as max_wal_size,
                        current_setting('checkpoint_timeout') as checkpoint_timeout
                `);
                const row = walResult.rows[0];
                if (row) {
                    walStats = {
                        fileCount: parseInt(row.file_count) || 0,
                        totalBytes: parseInt(row.total_bytes) || 0,
                        totalSize: row.total_size || '0 bytes',
                        minWalSize: row.min_wal_size,
                        maxWalSize: row.max_wal_size,
                        checkpointTimeout: row.checkpoint_timeout,
                        description: 'PGLite has no background checkpointer; WAL is trimmed by explicit CHECKPOINT after init, before close, and when size exceeds 200 MB.',
                    };
                }
            } catch (walErr) {
                console.warn('[DatabaseBrowserHandlers] Failed to read WAL stats:', walErr);
            }

            return {
                success: true,
                tableStats,
                totalSize: dbSizeResult.rows[0]?.size || '0 bytes',
                totalSizeBytes: parseInt(dbSizeResult.rows[0]?.size_bytes) || 0,
                basicStats: basicStats,
                backupStatus,
                walStats
            };
        } catch (error) {
            console.error('[DatabaseBrowserHandlers] Error fetching dashboard stats:', error);
            return { success: false, error: String(error) };
        }
    });

    // Get primary key columns for a table
    safeHandle('database:getPrimaryKeys', async (event, tableName: string) => {
        try {
            const result = await database.query<{ column_name: string }>(
                `SELECT a.attname AS column_name
                 FROM pg_index i
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                 WHERE i.indrelid = $1::regclass AND i.indisprimary
                 ORDER BY array_position(i.indkey, a.attnum)`,
                [tableName]
            );
            return { success: true, primaryKeys: result.rows.map(r => r.column_name) };
        } catch (error) {
            console.error('[DatabaseBrowserHandlers] Error fetching primary keys:', error);
            return { success: false, error: String(error) };
        }
    });

    // Update a single cell value
    safeHandle('database:updateCell', async (
        event,
        tableName: string,
        primaryKeys: { column: string; value: any }[],
        columnName: string,
        newValue: any
    ) => {
        try {
            if (!primaryKeys || primaryKeys.length === 0) {
                return { success: false, error: 'Cannot update: table has no primary key' };
            }

            // Sanitize table and column names (allow only alphanumeric and underscores)
            const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, '');
            const safeTable = sanitize(tableName);
            const safeColumn = sanitize(columnName);

            // Build WHERE clause from primary keys
            const whereConditions: string[] = [];
            const params: any[] = [newValue];
            primaryKeys.forEach((pk, idx) => {
                const safePkCol = sanitize(pk.column);
                whereConditions.push(`"${safePkCol}" = $${idx + 2}`);
                params.push(pk.value);
            });

            const sql = `UPDATE "${safeTable}" SET "${safeColumn}" = $1 WHERE ${whereConditions.join(' AND ')}`;
            const result = await database.query(sql, params);

            return {
                success: true,
                rowsAffected: (result as any).affectedRows ?? 1
            };
        } catch (error) {
            console.error('[DatabaseBrowserHandlers] Error updating cell:', error);
            return { success: false, error: String(error) };
        }
    });

    // Startup logging - uncomment if debugging handler registration
    // console.log('[DatabaseBrowserHandlers] Database browser handlers registered');
}
