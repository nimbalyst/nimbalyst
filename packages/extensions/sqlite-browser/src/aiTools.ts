/**
 * AI Tools for SQLite Browser
 *
 * Provides Claude with tools to query and analyze SQLite databases.
 */

import { getActiveDatabase, getAllDatabases, dispatchDisplayQuery } from './databaseRegistry';

/**
 * AI tool definitions
 */
export const aiTools = [
  {
    name: 'sqlite_list_databases',
    access: { kind: 'filesystem' } as const,
    description: 'List all currently open SQLite databases in the browser',
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    handler: async () => {
      const databases = getAllDatabases();

      if (databases.length === 0) {
        return {
          success: false,
          error: 'No databases are currently open. Ask the user to open a database file first.',
        };
      }

      return {
        success: true,
        data: {
          databases: databases.map(db => ({
            name: db.name,
            tables: db.tables,
          })),
        },
      };
    },
  },

  {
    name: 'sqlite_list_tables',
    access: { kind: 'filesystem' } as const,
    description: 'List all tables in the currently open SQLite database',
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    handler: async () => {
      const entry = getActiveDatabase();
      if (!entry) {
        return {
          success: false,
          error: 'No database is currently open. Ask the user to open a database file first.',
        };
      }

      return {
        success: true,
        data: {
          database: entry.name,
          tables: entry.tables,
        },
      };
    },
  },

  {
    name: 'sqlite_describe_table',
    access: { kind: 'filesystem' } as const,
    description: 'Get the schema (columns, types, constraints) of a table',
    parameters: {
      type: 'object' as const,
      properties: {
        table: {
          type: 'string' as const,
          description: 'Name of the table to describe',
        },
      },
      required: ['table'],
    },
    handler: async (params: { table: string }) => {
      const entry = getActiveDatabase();
      if (!entry) {
        return {
          success: false,
          error: 'No database is currently open.',
        };
      }

      try {
        const result = entry.db.exec(`PRAGMA table_info("${params.table}")`);

        if (result.length === 0) {
          return {
            success: false,
            error: `Table "${params.table}" not found`,
          };
        }

        const columns = result[0].values.map((row: any[]) => ({
          name: row[1],
          type: row[2],
          notnull: row[3] === 1,
          defaultValue: row[4],
          primaryKey: row[5] === 1,
        }));

        // Also get foreign keys
        const fkResult = entry.db.exec(`PRAGMA foreign_key_list("${params.table}")`);
        const foreignKeys = fkResult.length > 0
          ? fkResult[0].values.map((row: any[]) => ({
              column: row[3],
              referencesTable: row[2],
              referencesColumn: row[4],
            }))
          : [];

        // Get indexes
        const indexResult = entry.db.exec(`PRAGMA index_list("${params.table}")`);
        const indexes = indexResult.length > 0
          ? indexResult[0].values.map((row: any[]) => ({
              name: row[1],
              unique: row[2] === 1,
            }))
          : [];

        return {
          success: true,
          data: {
            table: params.table,
            columns,
            foreignKeys,
            indexes,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to describe table',
        };
      }
    },
  },

  {
    name: 'sqlite_query',
    access: { kind: 'filesystem' } as const,
    description: 'Execute a SQL query on the database. Use this for SELECT queries to retrieve data.',
    parameters: {
      type: 'object' as const,
      properties: {
        sql: {
          type: 'string' as const,
          description: 'SQL query to execute (SELECT only for safety)',
        },
        limit: {
          type: 'number' as const,
          description: 'Maximum number of rows to return (default: 100)',
        },
      },
      required: ['sql'],
    },
    handler: async (params: { sql: string; limit?: number }) => {
      const entry = getActiveDatabase();
      if (!entry) {
        return {
          success: false,
          error: 'No database is currently open.',
        };
      }

      // Safety check: only allow SELECT queries
      const trimmedSql = params.sql.trim().toUpperCase();
      if (!trimmedSql.startsWith('SELECT') && !trimmedSql.startsWith('PRAGMA') && !trimmedSql.startsWith('EXPLAIN')) {
        return {
          success: false,
          error: 'Only SELECT, PRAGMA, and EXPLAIN queries are allowed for safety. Use sqlite_execute for modifications.',
        };
      }

      try {
        const limit = params.limit || 100;
        let sql = params.sql;

        // Add LIMIT if not present and not a PRAGMA
        if (!trimmedSql.startsWith('PRAGMA') && !trimmedSql.includes('LIMIT')) {
          sql = `${params.sql} LIMIT ${limit}`;
        }

        const startTime = performance.now();
        const result = entry.db.exec(sql);
        const endTime = performance.now();

        if (result.length === 0) {
          return {
            success: true,
            data: {
              columns: [],
              rows: [],
              rowCount: 0,
              executionTime: endTime - startTime,
            },
          };
        }

        return {
          success: true,
          data: {
            columns: result[0].columns,
            rows: result[0].values,
            rowCount: result[0].values.length,
            executionTime: endTime - startTime,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Query failed',
        };
      }
    },
  },

  {
    name: 'sqlite_count',
    access: { kind: 'filesystem' } as const,
    description: 'Get the row count for a table, optionally with a WHERE clause',
    parameters: {
      type: 'object' as const,
      properties: {
        table: {
          type: 'string' as const,
          description: 'Name of the table',
        },
        where: {
          type: 'string' as const,
          description: 'Optional WHERE clause (without the WHERE keyword)',
        },
      },
      required: ['table'],
    },
    handler: async (params: { table: string; where?: string }) => {
      const entry = getActiveDatabase();
      if (!entry) {
        return {
          success: false,
          error: 'No database is currently open.',
        };
      }

      try {
        const whereClause = params.where ? ` WHERE ${params.where}` : '';
        const sql = `SELECT COUNT(*) as count FROM "${params.table}"${whereClause}`;
        const result = entry.db.exec(sql);

        return {
          success: true,
          data: {
            table: params.table,
            count: result[0].values[0][0],
            filter: params.where || null,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Count failed',
        };
      }
    },
  },

  {
    name: 'sqlite_sample',
    access: { kind: 'filesystem' } as const,
    description: 'Get a random sample of rows from a table',
    parameters: {
      type: 'object' as const,
      properties: {
        table: {
          type: 'string' as const,
          description: 'Name of the table',
        },
        count: {
          type: 'number' as const,
          description: 'Number of rows to sample (default: 10)',
        },
      },
      required: ['table'],
    },
    handler: async (params: { table: string; count?: number }) => {
      const entry = getActiveDatabase();
      if (!entry) {
        return {
          success: false,
          error: 'No database is currently open.',
        };
      }

      try {
        const count = params.count || 10;
        const sql = `SELECT * FROM "${params.table}" ORDER BY RANDOM() LIMIT ${count}`;
        const result = entry.db.exec(sql);

        if (result.length === 0) {
          return {
            success: true,
            data: {
              columns: [],
              rows: [],
              rowCount: 0,
            },
          };
        }

        return {
          success: true,
          data: {
            table: params.table,
            columns: result[0].columns,
            rows: result[0].values,
            rowCount: result[0].values.length,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Sample failed',
        };
      }
    },
  },

  {
    name: 'sqlite_analyze',
    access: { kind: 'filesystem' } as const,
    description: 'Get statistics about a column (distinct values, null count, min/max for numeric)',
    parameters: {
      type: 'object' as const,
      properties: {
        table: {
          type: 'string' as const,
          description: 'Name of the table',
        },
        column: {
          type: 'string' as const,
          description: 'Name of the column to analyze',
        },
      },
      required: ['table', 'column'],
    },
    handler: async (params: { table: string; column: string }) => {
      const entry = getActiveDatabase();
      if (!entry) {
        return {
          success: false,
          error: 'No database is currently open.',
        };
      }

      try {
        const { table, column } = params;

        // Get basic stats
        const statsResult = entry.db.exec(`
          SELECT
            COUNT(*) as total,
            COUNT("${column}") as non_null,
            COUNT(DISTINCT "${column}") as distinct_count
          FROM "${table}"
        `);

        const stats: any = {
          table,
          column,
          totalRows: statsResult[0].values[0][0],
          nonNullCount: statsResult[0].values[0][1],
          nullCount: (statsResult[0].values[0][0] as number) - (statsResult[0].values[0][1] as number),
          distinctCount: statsResult[0].values[0][2],
        };

        // Try to get min/max (works for numeric and text)
        try {
          const minMaxResult = entry.db.exec(`
            SELECT MIN("${column}"), MAX("${column}")
            FROM "${table}"
            WHERE "${column}" IS NOT NULL
          `);
          if (minMaxResult.length > 0) {
            stats.min = minMaxResult[0].values[0][0];
            stats.max = minMaxResult[0].values[0][1];
          }
        } catch {
          // Min/max might fail for some types
        }

        // Get top 5 most common values
        try {
          const topValuesResult = entry.db.exec(`
            SELECT "${column}", COUNT(*) as count
            FROM "${table}"
            WHERE "${column}" IS NOT NULL
            GROUP BY "${column}"
            ORDER BY count DESC
            LIMIT 5
          `);
          if (topValuesResult.length > 0) {
            stats.topValues = topValuesResult[0].values.map((row: any[]) => ({
              value: row[0],
              count: row[1],
            }));
          }
        } catch {
          // Top values might fail for some types
        }

        return {
          success: true,
          data: stats,
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Analysis failed',
        };
      }
    },
  },

  {
    name: 'sqlite_schema',
    access: { kind: 'filesystem' } as const,
    description: 'Get the full database schema including all tables and their relationships',
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    handler: async () => {
      const entry = getActiveDatabase();
      if (!entry) {
        return {
          success: false,
          error: 'No database is currently open.',
        };
      }

      try {
        const schema: any = {
          database: entry.name,
          tables: [],
        };

        for (const tableName of entry.tables) {
          // Get columns
          const colResult = entry.db.exec(`PRAGMA table_info("${tableName}")`);
          const columns = colResult.length > 0
            ? colResult[0].values.map((row: any[]) => ({
                name: row[1],
                type: row[2],
                notnull: row[3] === 1,
                primaryKey: row[5] === 1,
              }))
            : [];

          // Get foreign keys
          const fkResult = entry.db.exec(`PRAGMA foreign_key_list("${tableName}")`);
          const foreignKeys = fkResult.length > 0
            ? fkResult[0].values.map((row: any[]) => ({
                column: row[3],
                referencesTable: row[2],
                referencesColumn: row[4],
              }))
            : [];

          // Get row count
          const countResult = entry.db.exec(`SELECT COUNT(*) FROM "${tableName}"`);
          const rowCount = countResult[0].values[0][0];

          schema.tables.push({
            name: tableName,
            columns,
            foreignKeys,
            rowCount,
          });
        }

        return {
          success: true,
          data: schema,
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to get schema',
        };
      }
    },
  },

  {
    name: 'sqlite_display_query',
    access: { kind: 'filesystem' } as const,
    description: 'Execute a SQL query and display the results directly in the SQLite editor UI. Use this to show query results to the user in the database browser interface rather than as text output.',
    parameters: {
      type: 'object' as const,
      properties: {
        sql: {
          type: 'string' as const,
          description: 'SQL query to execute (SELECT only for safety)',
        },
        limit: {
          type: 'number' as const,
          description: 'Maximum number of rows to return (default: 100)',
        },
      },
      required: ['sql'],
    },
    handler: async (params: { sql: string; limit?: number }) => {
      const entry = getActiveDatabase();
      if (!entry) {
        return {
          success: false,
          error: 'No database is currently open.',
        };
      }

      // Safety check: only allow SELECT queries
      const trimmedSql = params.sql.trim().toUpperCase();
      if (!trimmedSql.startsWith('SELECT') && !trimmedSql.startsWith('PRAGMA') && !trimmedSql.startsWith('EXPLAIN')) {
        return {
          success: false,
          error: 'Only SELECT, PRAGMA, and EXPLAIN queries are allowed for safety.',
        };
      }

      try {
        const limit = params.limit || 100;
        let sql = params.sql;

        // Add LIMIT if not present and not a PRAGMA
        if (!trimmedSql.startsWith('PRAGMA') && !trimmedSql.includes('LIMIT')) {
          sql = `${params.sql} LIMIT ${limit}`;
        }

        const startTime = performance.now();
        const result = entry.db.exec(sql);
        const endTime = performance.now();
        const executionTime = endTime - startTime;

        let columns: string[] = [];
        let values: any[][] = [];
        let rowCount = 0;

        if (result.length > 0) {
          columns = result[0].columns;
          values = result[0].values;
          rowCount = result[0].values.length;
        }

        // Dispatch to the editor UI
        const dispatched = dispatchDisplayQuery({
          sql: params.sql,
          columns,
          values,
          rowCount,
          executionTime,
        });

        if (!dispatched) {
          return {
            success: false,
            error: 'No SQLite editor is currently open to display the results. Open a .db or .sqlite file first.',
          };
        }

        return {
          success: true,
          data: {
            message: `Query results displayed in SQLite editor (${rowCount} row(s) in ${executionTime.toFixed(1)}ms)`,
            rowCount,
            executionTime,
          },
        };
      } catch (err) {
        // Dispatch error to the UI as well
        dispatchDisplayQuery({
          sql: params.sql,
          columns: [],
          values: [],
          rowCount: 0,
          executionTime: 0,
          error: err instanceof Error ? err.message : 'Query failed',
        });

        return {
          success: false,
          error: err instanceof Error ? err.message : 'Query failed',
        };
      }
    },
  },
];
