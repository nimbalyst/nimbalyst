/**
 * Query History Storage
 *
 * Persists recent queries per database file using extension storage.
 * Stores up to 30 queries per file to help users recall previous work.
 */

const MAX_QUERIES_PER_FILE = 30;
const STORAGE_KEY_PREFIX = 'queryHistory:';

export interface QueryHistoryEntry {
  sql: string;
  timestamp: number;
}

/** Storage interface (subset of ExtensionStorage) */
interface StorageService {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): Promise<void>;
}

/**
 * Get storage key for a database file path.
 * Uses a hash of the file path to create a valid key.
 */
function getStorageKey(filePath: string): string {
  // Use base64-encoded path to create a unique but valid key
  // Replace special characters that might cause issues
  const encoded = btoa(filePath).replace(/[/+=]/g, '_');
  return `${STORAGE_KEY_PREFIX}${encoded}`;
}

/**
 * Get query history for a specific database file.
 */
export function getQueryHistory(storage: StorageService | undefined, filePath: string): QueryHistoryEntry[] {
  if (!storage) return [];

  try {
    const key = getStorageKey(filePath);
    const history = storage.get<QueryHistoryEntry[]>(key);
    return history ?? [];
  } catch (err) {
    console.warn('[SQLite Browser] Failed to load query history:', err);
    return [];
  }
}

/**
 * Add a query to the history for a specific database file.
 * Maintains a maximum of 30 queries, removing oldest when exceeded.
 * Deduplicates by SQL - if the same query exists, it's moved to the top.
 */
export async function addQueryToHistory(
  storage: StorageService | undefined,
  filePath: string,
  sql: string
): Promise<void> {
  if (!storage) return;

  try {
    const key = getStorageKey(filePath);
    const history = getQueryHistory(storage, filePath);

    // Normalize SQL for comparison (trim and collapse whitespace)
    const normalizedSql = sql.trim().replace(/\s+/g, ' ');

    // Remove existing entry with same SQL (case-insensitive comparison)
    const filtered = history.filter(
      entry => entry.sql.trim().replace(/\s+/g, ' ').toLowerCase() !== normalizedSql.toLowerCase()
    );

    // Add new entry at the beginning
    const newEntry: QueryHistoryEntry = {
      sql: sql.trim(),
      timestamp: Date.now(),
    };

    const updated = [newEntry, ...filtered].slice(0, MAX_QUERIES_PER_FILE);

    await storage.set(key, updated);
  } catch (err) {
    console.warn('[SQLite Browser] Failed to save query history:', err);
  }
}

/**
 * Clear query history for a specific database file.
 */
export async function clearQueryHistory(storage: StorageService | undefined, filePath: string): Promise<void> {
  if (!storage) return;

  try {
    const key = getStorageKey(filePath);
    await storage.set(key, []);
  } catch (err) {
    console.warn('[SQLite Browser] Failed to clear query history:', err);
  }
}
