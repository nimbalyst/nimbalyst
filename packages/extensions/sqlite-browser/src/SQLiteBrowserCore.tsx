/**
 * SQLite Browser Core Component
 *
 * Shared UI component for browsing SQLite databases.
 * Used by both the panel (with file picker) and custom editor (with file path).
 */

import { useState, useEffect, useId, useCallback } from 'react';
import initSqlJs, { type Database } from 'sql.js';
import { registerDatabase, unregisterDatabase, setDisplayCallback, type DisplayQueryResult } from './databaseRegistry';
import { getQueryHistory, addQueryToHistory, type QueryHistoryEntry } from './queryHistory';

// ============================================================================
// Types
// ============================================================================

export interface DatabaseInfo {
  name: string;
  path: string;
  tables: string[];
}

export interface TableSchema {
  name: string;
  type: string;
  notnull: boolean;
  dflt_value: string | null;
  pk: boolean;
}

export interface QueryResult {
  columns: string[];
  values: any[][];
  rowCount: number;
}

/** Extension storage interface (subset of ExtensionStorage) */
interface StorageService {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): Promise<void>;
}

export interface SQLiteBrowserCoreProps {
  /** Database info if already loaded, or null to show empty state */
  database: DatabaseInfo | null;
  /** The sql.js Database instance */
  db: Database | null;
  /** Loading state */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Called when close button is clicked (panel only) */
  onClose?: () => void;
  /** Called when open button is clicked (panel only) */
  onOpenClick?: () => void;
  /** AI context setter (optional) */
  onAIContextChange?: (context: Record<string, unknown> | null) => void;
  /** Whether to show the header with open/close buttons */
  showHeader?: boolean;
  /** Additional content to render in empty state (e.g., recent databases) */
  emptyStateExtra?: React.ReactNode;
  /** Storage service for persisting query history */
  storage?: StorageService;
  /**
   * Read-only mode. Hides the Query pane (SQL textarea + run button) so
   * the browser reads as a clean table viewer. The data is always
   * inspect-only in this codebase -- this flag is purely a UI affordance.
   */
  readOnly?: boolean;
}

// ============================================================================
// Utilities
// ============================================================================

// Cache the SQL.js instance
let sqlPromise: Promise<any> | null = null;

export async function getSqlJs() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      // Load sql-wasm.wasm from CDN
      locateFile: (file: string) => `https://sql.js.org/dist/${file}`,
    });
  }
  return sqlPromise;
}

// Get file name from path
export function getFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

// ============================================================================
// Component
// ============================================================================

export function SQLiteBrowserCore({
  database,
  db,
  loading,
  error,
  onClose,
  onOpenClick,
  onAIContextChange,
  showHeader = true,
  emptyStateExtra,
  storage,
  readOnly = false,
}: SQLiteBrowserCoreProps) {
  // Unique ID for this component instance (for AI tool registration)
  const instanceId = useId();

  // Table browser state
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableSchema, setTableSchema] = useState<TableSchema[]>([]);
  const [tableData, setTableData] = useState<QueryResult | null>(null);

  // Query state
  const [query, setQuery] = useState('');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryTime, setQueryTime] = useState<number | null>(null);

  // View mode
  const [viewMode, setViewMode] = useState<'browse' | 'query'>('browse');

  // If the host flips to read-only while we're in the query pane, fall back
  // to browse mode so the hidden Query button can't leave us stranded.
  useEffect(() => {
    if (readOnly && viewMode === 'query') setViewMode('browse');
  }, [readOnly, viewMode]);

  // Query history
  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Load query history when database changes
  useEffect(() => {
    if (database?.path) {
      const history = getQueryHistory(storage, database.path);
      setQueryHistory(history);
    } else {
      setQueryHistory([]);
    }
  }, [database?.path, storage]);

  // Handler for AI-dispatched query results
  // Populates the query input and displays results using the same UI as manual queries
  const handleAiQueryResult = useCallback((result: DisplayQueryResult) => {
    setQuery(result.sql); // Put the SQL in the editable textarea
    setViewMode('query'); // Switch to query view
    setQueryTime(result.executionTime);

    if (result.error) {
      setQueryError(result.error);
      setQueryResult(null);
    } else {
      setQueryError(null);
      setQueryResult({
        columns: result.columns,
        values: result.values,
        rowCount: result.rowCount,
      });
    }

    // Save to query history
    if (database?.path && result.sql.trim()) {
      addQueryToHistory(storage, database.path, result.sql).then(() => {
        // Refresh history list
        setQueryHistory(getQueryHistory(storage, database.path));
      });
    }
  }, [database?.path, storage]);

  // Register/unregister database for AI tools
  useEffect(() => {
    if (db && database) {
      registerDatabase(instanceId, db, database.name, database.tables);
      setDisplayCallback(instanceId, handleAiQueryResult);
    }
    return () => {
      setDisplayCallback(instanceId, undefined);
      unregisterDatabase(instanceId);
    };
  }, [db, database, instanceId, handleAiQueryResult]);

  // Reset state when database changes
  useEffect(() => {
    setSelectedTable(null);
    setTableSchema([]);
    setTableData(null);
    setQueryResult(null);
    setQueryError(null);
  }, [database?.path]);

  const handleTableSelect = useCallback((tableName: string) => {
    if (!db) return;

    setSelectedTable(tableName);
    setQueryError(null);

    try {
      // Get table schema
      const schemaResult = db.exec(`PRAGMA table_info("${tableName}")`);
      let schema: TableSchema[] = [];
      if (schemaResult.length > 0) {
        schema = schemaResult[0].values.map((row: any[]) => ({
          name: row[1] as string,
          type: row[2] as string,
          notnull: row[3] === 1,
          dflt_value: row[4] as string | null,
          pk: row[5] === 1,
        }));
        setTableSchema(schema);
      }

      // Get table data (limited to 100 rows)
      const dataResult = db.exec(`SELECT * FROM "${tableName}" LIMIT 100`);
      if (dataResult.length > 0) {
        setTableData({
          columns: dataResult[0].columns,
          values: dataResult[0].values,
          rowCount: dataResult[0].values.length,
        });
      } else {
        setTableData({
          columns: [],
          values: [],
          rowCount: 0,
        });
      }

      // Update AI context with selected table info
      onAIContextChange?.({
        databaseName: database?.name,
        databasePath: database?.path,
        tables: database?.tables,
        tableCount: database?.tables.length,
        selectedTable: tableName,
        selectedTableSchema: schema.map(col => ({
          name: col.name,
          type: col.type,
          nullable: !col.notnull,
          primaryKey: col.pk,
        })),
      });
    } catch (err) {
      console.error('Failed to load table:', err);
      setQueryError(err instanceof Error ? err.message : 'Failed to load table');
    }
  }, [db, database, onAIContextChange]);

  // Handler for selecting a query from history
  const handleSelectHistoryQuery = useCallback((entry: QueryHistoryEntry) => {
    setQuery(entry.sql);
    setShowHistory(false);
  }, []);

  // Format relative time for history display
  const formatRelativeTime = (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  const handleRunQuery = useCallback(() => {
    if (!db || !query.trim()) return;

    setQueryError(null);
    setQueryResult(null);

    const startTime = performance.now();

    try {
      const result = db.exec(query);
      const endTime = performance.now();
      setQueryTime(endTime - startTime);

      if (result.length > 0) {
        setQueryResult({
          columns: result[0].columns,
          values: result[0].values,
          rowCount: result[0].values.length,
        });
      } else {
        // Query executed but returned no results (e.g., UPDATE, INSERT)
        setQueryResult({
          columns: [],
          values: [],
          rowCount: 0,
        });
      }

      // Save to query history on successful execution
      if (database?.path) {
        addQueryToHistory(storage, database.path, query).then(() => {
          setQueryHistory(getQueryHistory(storage, database.path));
        });
      }
    } catch (err) {
      console.error('Query error:', err);
      setQueryError(err instanceof Error ? err.message : 'Query failed');
      setQueryTime(null);
    }
  }, [db, query, database?.path, storage]);

  const renderDataTable = (result: QueryResult) => {
    if (result.columns.length === 0) {
      return <p className="text-nim-muted m-0 p-4">Query executed successfully (no rows returned)</p>;
    }

    return (
      <div className="flex-1 overflow-auto border border-nim rounded">
        <table className="w-full border-collapse text-xs font-mono">
          <thead>
            <tr>
              {result.columns.map((col, i) => (
                <th key={i} className="sticky top-0 bg-nim-secondary p-2 text-left border-b border-nim font-semibold">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.values.map((row, rowIdx) => (
              <tr key={rowIdx} className="hover:bg-nim-hover">
                {row.map((cell, cellIdx) => (
                  <td key={cellIdx} className="p-2 border-b border-nim whitespace-nowrap max-w-[300px] overflow-hidden text-ellipsis">
                    {cell === null ? (
                      <span className="text-nim-faint italic">NULL</span>
                    ) : typeof cell === 'object' ? (
                      <span className="text-nim-muted italic">[BLOB]</span>
                    ) : (
                      String(cell)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full bg-nim text-nim">
      {showHeader && (
        <div className="flex items-center justify-between p-3 border-b border-nim shrink-0">
          <h3 className="m-0 text-sm font-semibold">SQLite Browser</h3>
          <div className="flex gap-2">
            {onOpenClick && (
              <button
                className="px-3 py-1.5 text-xs font-medium border-none rounded cursor-pointer bg-[var(--nim-primary)] text-white transition-all hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
                onClick={onOpenClick}
                disabled={loading}
              >
                {loading ? 'Loading...' : 'Open Database'}
              </button>
            )}
            {database && onClose && (
              <button
                className="px-3 py-1.5 text-xs font-medium border border-nim rounded cursor-pointer bg-nim-tertiary text-nim transition-all hover:bg-[var(--nim-bg-hover)]"
                onClick={onClose}
              >
                Close
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-hidden flex flex-col">
        {error && (
          <div className="p-3 mx-4 my-2 bg-[rgba(239,68,68,0.1)] border border-[var(--nim-error)] rounded text-[var(--nim-error)]">
            <p>{error}</p>
          </div>
        )}

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-nim-muted">
            <p>Loading database...</p>
          </div>
        ) : !database ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="mb-4 text-nim-faint">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M21 5v14c0 1.65-4.03 3-9 3s-9-1.35-9-3V5" />
                <path d="M21 12c0 1.65-4.03 3-9 3s-9-1.35-9-3" />
              </svg>
            </div>
            <p className="m-0 mb-2 text-base font-medium text-nim">No database selected</p>
            <p className="m-0 mb-6 text-[13px] text-nim-muted max-w-[300px]">
              {onOpenClick
                ? 'Click "Open Database" to browse a SQLite database file'
                : 'Open a .db or .sqlite file to browse its contents'}
            </p>
            {onOpenClick && (
              <button
                className="px-5 py-2.5 text-[13px] font-medium border-none rounded cursor-pointer bg-[var(--nim-primary)] text-white transition-all hover:opacity-90"
                onClick={onOpenClick}
              >
                Open Database
              </button>
            )}
            {emptyStateExtra}
          </div>
        ) : (
          <div className="flex-1 flex overflow-hidden">
            {/* Sidebar with query and tables */}
            <div className="w-[220px] min-w-[180px] border-r border-nim flex flex-col overflow-hidden bg-nim-secondary">
              <div className="p-3 border-b border-nim">
                <h4 className="m-0 mb-1 text-[13px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis" title={database.path}>{database.name}</h4>
                <span className="text-[11px] text-nim-muted">{database.tables.length} table(s)</span>
              </div>

              {/* Query section. Hidden in read-only mode so the browser
               * reads as a clean table viewer without the SQL editor. */}
              {!readOnly && (
                <div className="p-2 border-b border-nim">
                  <button
                    className={`flex items-center gap-2 w-full p-2 text-xs font-medium text-left border-none rounded cursor-pointer transition-all ${viewMode === 'query' ? 'bg-[var(--nim-primary)] text-white' : 'bg-transparent text-nim hover:bg-nim-hover'}`}
                    onClick={() => {
                      setViewMode('query');
                      setSelectedTable(null);
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                      <polyline points="4 17 10 11 4 5" />
                      <line x1="12" y1="19" x2="20" y2="19" />
                    </svg>
                    Query
                  </button>
                </div>
              )}

              {/* Tables section */}
              <div className="border-b border-nim last:border-b-0 flex-1 flex flex-col overflow-hidden">
                <div className="px-3 py-1 pb-2 text-[10px] font-semibold uppercase tracking-wider text-nim-faint">Tables</div>
                <div className="flex-1 overflow-y-auto">
                  {database.tables.map((table) => (
                    <button
                      key={table}
                      className={`block w-full p-1.5 px-3 my-px text-xs font-mono text-left border-none rounded cursor-pointer transition-all ${selectedTable === table && viewMode === 'browse' ? 'bg-[var(--nim-primary)] text-white' : 'bg-transparent text-nim hover:bg-nim-hover'}`}
                      onClick={() => {
                        setViewMode('browse');
                        handleTableSelect(table);
                      }}
                    >
                      {table}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Main content area */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {viewMode === 'browse' ? (
                <div className="flex-1 flex flex-col overflow-hidden p-4 gap-4">
                  {selectedTable ? (
                    <>
                      <div className="shrink-0">
                        <h5 className="m-0 mb-2 text-xs font-semibold text-nim-muted">Schema: {selectedTable}</h5>
                        <div className="flex flex-wrap gap-2">
                          {tableSchema.map((col) => (
                            <div key={col.name} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-nim-secondary rounded text-xs">
                              <span className="font-mono font-medium">
                                {col.pk && <span className="inline-block px-1 py-0.5 mr-1 text-[9px] font-semibold bg-[var(--nim-primary)] text-white rounded-sm">PK</span>}
                                {col.name}
                              </span>
                              <span className="text-nim-muted text-[11px]">{col.type}</span>
                              {col.notnull && <span className="text-[10px] text-[var(--nim-warning)]">NOT NULL</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                        <h5 className="m-0 mb-2 text-xs font-semibold text-nim-muted">Data (showing up to 100 rows)</h5>
                        {tableData && renderDataTable(tableData)}
                      </div>
                    </>
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-nim-muted">
                      <p>Select a table or Query from the sidebar</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex-1 flex flex-col overflow-hidden p-4 gap-4">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-end mb-2">
                      <div className="relative">
                        <button
                          className="px-3 py-1.5 text-xs font-medium border border-nim rounded cursor-pointer bg-nim-secondary text-nim transition-all hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                          onClick={() => setShowHistory(!showHistory)}
                          disabled={queryHistory.length === 0}
                          title={queryHistory.length === 0 ? 'No query history' : `${queryHistory.length} recent queries`}
                        >
                          History ({queryHistory.length})
                        </button>
                        {showHistory && queryHistory.length > 0 && (
                          <div className="absolute top-full right-0 z-[100] w-[400px] max-h-[300px] overflow-y-auto mt-1 bg-nim border border-nim rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.15)]">
                            {queryHistory.map((entry, index) => (
                              <button
                                key={index}
                                className="flex flex-col items-start w-full p-2.5 px-3 bg-transparent border-none border-b border-nim last:border-b-0 cursor-pointer text-left transition-all hover:bg-nim-hover"
                                onClick={() => handleSelectHistoryQuery(entry)}
                              >
                                <span className="text-xs font-mono text-nim whitespace-nowrap overflow-hidden text-ellipsis w-full">
                                  {entry.sql.length > 80 ? entry.sql.substring(0, 80) + '...' : entry.sql}
                                </span>
                                <span className="text-[10px] text-nim-faint mt-1">
                                  {formatRelativeTime(entry.timestamp)}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <textarea
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Enter SQL query..."
                      spellCheck={false}
                      onFocus={() => setShowHistory(false)}
                      className="w-full min-h-[100px] p-3 text-[13px] font-mono bg-nim-secondary border border-nim rounded text-nim resize-y focus:outline-none focus:border-[var(--nim-border-focus)]"
                    />
                    <button
                      className="self-start px-5 py-2 text-sm font-medium rounded cursor-pointer bg-[var(--nim-primary)] text-white border-none transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={handleRunQuery}
                      disabled={!query.trim()}
                    >
                      Run Query
                    </button>
                  </div>
                  {queryError && (
                    <div className="p-3 mx-0 my-0 bg-[rgba(239,68,68,0.1)] border border-[var(--nim-error)] rounded text-[var(--nim-error)]">
                      <p>{queryError}</p>
                    </div>
                  )}
                  {queryResult && (
                    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                      <div className="text-xs text-nim-muted mb-2 shrink-0">
                        {queryResult.rowCount} row(s) returned
                        {queryTime !== null && ` in ${queryTime.toFixed(1)}ms`}
                      </div>
                      {renderDataTable(queryResult)}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
