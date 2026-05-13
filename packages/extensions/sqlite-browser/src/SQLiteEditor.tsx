/**
 * SQLite Editor Component
 *
 * Custom editor wrapper for viewing SQLite databases when opening .db/.sqlite files.
 * Uses EditorHost to get the file path and loads the database automatically.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';
import { useEditorLifecycle } from '@nimbalyst/extension-sdk';
import type { Database } from 'sql.js';
import { SQLiteBrowserCore, getSqlJs, getFileName, type DatabaseInfo } from './SQLiteBrowserCore';

export function SQLiteEditor({ host }: EditorHostProps) {
  const [database, setDatabase] = useState<DatabaseInfo | null>(null);
  const [db, setDb] = useState<Database | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reactive read-only state. The .db file is loaded as an in-memory
  // sql.js handle and is never written back regardless, but the flag
  // suppresses the Query pane (SQL editor + run button) so inline embeds
  // read as a clean table viewer.
  const [readOnly, setReadOnly] = useState<boolean>(host.readOnly ?? false);
  useEffect(() => {
    setReadOnly(host.readOnly ?? false);
    return host.onReadOnlyChanged?.((next) => {
      setReadOnly(next);
    });
  }, [host]);

  // Ref for cleanup (db state may be stale in unmount effect)
  const dbRef = useRef<Database | null>(null);

  const loadFromBinary = useCallback(async (arrayBuffer: ArrayBuffer) => {
    setError(null);
    setLoading(true);

    try {
      const data = new Uint8Array(arrayBuffer);
      const SQL = await getSqlJs();

      // Close existing database if any
      dbRef.current?.close();

      const newDb = new SQL.Database(data);
      dbRef.current = newDb;
      setDb(newDb);

      const tablesResult = newDb.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );

      const tables = tablesResult.length > 0
        ? tablesResult[0].values.map((row: any[]) => row[0] as string)
        : [];

      const fileName = getFileName(host.filePath);

      setDatabase({
        name: fileName,
        path: host.filePath,
        tables,
      });
    } catch (err) {
      console.error('Failed to load database:', err);
      setError(err instanceof Error ? err.message : 'Failed to load database');
      setDatabase(null);
    } finally {
      setLoading(false);
    }
  }, [host.filePath]);

  // useEditorLifecycle handles initial load, file change detection, and theme.
  // applyContent triggers async database loading.
  useEditorLifecycle<ArrayBuffer>(host, {
    applyContent: (data: ArrayBuffer) => {
      loadFromBinary(data);
    },
    binary: true,
  });

  // Cleanup database on unmount
  useEffect(() => {
    return () => {
      dbRef.current?.close();
    };
  }, []);

  return (
    <SQLiteBrowserCore
      database={database}
      db={db}
      loading={loading}
      error={error}
      showHeader={false}
      storage={host.storage}
      readOnly={readOnly}
    />
  );
}
