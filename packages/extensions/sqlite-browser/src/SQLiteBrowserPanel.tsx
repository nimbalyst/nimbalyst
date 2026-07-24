/**
 * SQLite Browser Panel Component
 *
 * Panel wrapper for browsing SQLite databases.
 * Uses native Electron file dialog and persists recent databases.
 */

import { useState, useEffect, useCallback } from 'react';
import type { PanelHostProps } from '@nimbalyst/extension-sdk';
import type { Database } from 'sql.js';
import { SQLiteBrowserCore, getSqlJs, getFileName, type DatabaseInfo } from './SQLiteBrowserCore';

// Storage keys
const STORAGE_KEY_RECENT_DBS = 'recentDatabases';
const STORAGE_KEY_CURRENT_DB = 'currentDatabasePath';
const MAX_RECENT_DATABASES = 10;

interface RecentDatabase {
  path: string;
  name: string;
  lastOpened: number;
}

export function SQLiteBrowserPanel({ host }: PanelHostProps) {
  const [database, setDatabase] = useState<DatabaseInfo | null>(null);
  const [db, setDb] = useState<Database | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentDatabases, setRecentDatabases] = useState<RecentDatabase[]>([]);

  // Load recent databases from storage on mount
  useEffect(() => {
    const stored = host.storage.get<RecentDatabase[]>(STORAGE_KEY_RECENT_DBS);
    if (stored && Array.isArray(stored)) {
      setRecentDatabases(stored);
    }
  }, [host.storage]);

  // Add database to recent list
  const addToRecentDatabases = useCallback(async (filePath: string, fileName: string) => {
    const newEntry: RecentDatabase = {
      path: filePath,
      name: fileName,
      lastOpened: Date.now(),
    };

    // Update recent list - remove existing entry if present, add to front
    const filtered = recentDatabases.filter(db => db.path !== filePath);
    const updated = [newEntry, ...filtered].slice(0, MAX_RECENT_DATABASES);

    setRecentDatabases(updated);
    await host.storage.set(STORAGE_KEY_RECENT_DBS, updated);
    await host.storage.set(STORAGE_KEY_CURRENT_DB, filePath);
  }, [recentDatabases, host.storage]);

  // Remove database from recent list
  const removeFromRecentDatabases = useCallback(async (filePath: string) => {
    const updated = recentDatabases.filter(db => db.path !== filePath);
    setRecentDatabases(updated);
    await host.storage.set(STORAGE_KEY_RECENT_DBS, updated);
  }, [recentDatabases, host.storage]);

  // Load database from file path
  const loadDatabaseFromPath = useCallback(async (filePath: string) => {
    setError(null);
    setLoading(true);

    try {
      // Read file content via Electron API
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI) {
        throw new Error('Electron API not available');
      }

      const result = await electronAPI.readFileContent(filePath, { binary: true });
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to read file');
      }

      // Convert base64 to Uint8Array
      const binaryString = atob(result.content);
      const data = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        data[i] = binaryString.charCodeAt(i);
      }

      const SQL = await getSqlJs();

      // Close existing database
      db?.close();

      const newDb = new SQL.Database(data);
      setDb(newDb);

      const tablesResult = newDb.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );

      const tables = tablesResult.length > 0
        ? tablesResult[0].values.map((row: any[]) => row[0] as string)
        : [];

      const fileName = getFileName(filePath);

      setDatabase({
        name: fileName,
        path: filePath,
        tables,
      });

      // Update AI context with database info
      host.ai?.setContext({
        databaseName: fileName,
        databasePath: filePath,
        tables,
        tableCount: tables.length,
      });

      // Add to recent databases
      await addToRecentDatabases(filePath, fileName);
    } catch (err) {
      console.error('Failed to load database:', err);
      setError(err instanceof Error ? err.message : 'Failed to load database');
      setDatabase(null);
    } finally {
      setLoading(false);
    }
  }, [db, addToRecentDatabases, host.ai]);

  // Cleanup database on unmount
  useEffect(() => {
    return () => {
      db?.close();
    };
  }, [db]);

  // Load last opened database on mount
  useEffect(() => {
    const currentPath = host.storage.get<string>(STORAGE_KEY_CURRENT_DB);
    if (currentPath && !database) {
      loadDatabaseFromPath(currentPath);
    }
  }, [host.storage, database, loadDatabaseFromPath]);

  const handleOpenClick = async () => {
    try {
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI) {
        setError('Electron API not available');
        return;
      }

      const result = await electronAPI.openFileDialog({
        title: 'Open SQLite Database',
        buttonLabel: 'Open',
        filters: [
          { name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return;
      }

      const filePath = result.filePaths[0];
      await loadDatabaseFromPath(filePath);
    } catch (err) {
      console.error('Failed to open file dialog:', err);
      setError(err instanceof Error ? err.message : 'Failed to open file');
    }
  };

  const handleClose = async () => {
    db?.close();
    setDb(null);
    setDatabase(null);
    setError(null);
    // Clear current database path but keep recent list
    await host.storage.delete(STORAGE_KEY_CURRENT_DB);
    // Clear AI context
    host.ai?.clearContext();
  };

  const handleAIContextChange = useCallback((context: Record<string, unknown> | null) => {
    if (context) {
      host.ai?.setContext(context);
    } else {
      host.ai?.clearContext();
    }
  }, [host.ai]);

  // Format relative time for recent databases
  const formatRelativeTime = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  // Recent databases UI for empty state
  const recentDatabasesUI = recentDatabases.length > 0 ? (
    <div className="mt-8 w-full max-w-[400px]">
      <h4 className="m-0 mb-3 text-xs font-semibold text-nim-muted uppercase tracking-wider">Recent Databases</h4>
      <div className="flex flex-col gap-1">
        {recentDatabases.map((recent) => (
          <div key={recent.path} className="flex items-center gap-1">
            <button
              className="flex-1 flex items-center justify-between p-2.5 px-3 bg-nim-secondary border border-nim rounded-md cursor-pointer transition-all text-left hover:bg-nim-hover hover:border-[var(--nim-border-focus)]"
              onClick={() => loadDatabaseFromPath(recent.path)}
              title={recent.path}
            >
              <span className="text-[13px] font-medium text-nim whitespace-nowrap overflow-hidden text-ellipsis">{recent.name}</span>
              <span className="text-[11px] text-nim-faint shrink-0 ml-2">{formatRelativeTime(recent.lastOpened)}</span>
            </button>
            <button
              className="w-6 h-6 flex items-center justify-center bg-transparent border-none rounded text-nim-faint cursor-pointer text-sm opacity-0 transition-all hover:bg-nim-tertiary hover:text-nim group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                removeFromRecentDatabases(recent.path);
              }}
              title="Remove from recent"
              style={{ opacity: 1 }}
              onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
            >
              x
            </button>
          </div>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <SQLiteBrowserCore
      database={database}
      db={db}
      loading={loading}
      error={error}
      onClose={handleClose}
      onOpenClick={handleOpenClick}
      onAIContextChange={handleAIContextChange}
      showHeader={true}
      emptyStateExtra={recentDatabasesUI}
    />
  );
}
