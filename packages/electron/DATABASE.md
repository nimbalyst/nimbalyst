# Electron Database (PGLite + better-sqlite3)

Nimbalyst currently runs over **two** persistence backends and code must
work on either: **PGLite** (PostgreSQL in WebAssembly, the original
backend) and **better-sqlite3** (the migration target). Both back the
same `AppDatabase` interface; the active backend is selected per workspace
during database initialization. Do not assume one or the other in code
you write — the migration is in progress and the user's machine may be
running either.

## Backend-divergent behaviors (read this before reading/writing JSON columns)

| Concern | PGLite | better-sqlite3 |
| --- | --- | --- |
| `data->'key'` sub-extraction | returns parsed JS object/value | returns JSON-encoded TEXT |
| Whole-column JSONB read | parsed object | TEXT (already handled at most call sites) |
| Concurrent writers | single worker; PID lock | WriteCoordinator serializes write lane |

**JSONB sub-extraction is not shape-uniform.** A query like
`SELECT (data->'someKey') AS x FROM ...` returns a parsed object on PGLite
but a JSON string on SQLite. Code that consumes `x` MUST either:

1. Select the whole `data` column and access the sub-field after parsing
   the column (use the standard `typeof row.data === 'string' ? JSON.parse(row.data) : row.data` idiom), or
2. Defensively parse the sub-extracted value:
   ```ts
   const raw = row.x;
   const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
   ```

A real bug from this divergence (2026-06-02): `applyRemoteItem` in
`TrackerPGLiteStore.ts` selected `data->'labelsMap'` directly, trusted it
was a parsed object, and on SQLite produced corrupted tracker rows whose
`labelsMap` was a hybrid character-keyed string spread with the real CRDT
entries merged on top.

**CRITICAL: Never use localStorage in the renderer process.** All persistent state must be stored via IPC to the main process using either:
- **app-settings store** (`src/main/utils/store.ts`) for global app settings
- **workspace-settings store** for per-project state
- **PGLite database** for complex data like AI sessions and document history

## Database System

- **Technology**: PGLite (Node.js worker) or better-sqlite3 (worker_threads with WriteCoordinator), selected at init time
- **Storage**: Persistent file-based database with ACID compliance
- **Worker architecture**: Both backends use an isolated worker thread
- **Bundling**: Both engines are fully bundled in packaged apps
- **SQLite write coordination**: A WriteCoordinator serializes writes into a batched lane and chunks background work, avoiding head-of-line blocking that PGLite suffered from

## Database Tables

- **`ai_sessions`**: AI chat conversations with full message history, document context, and provider configurations
- **`app_settings`**: Global application settings (theme, providers, shortcuts, etc.)
- **`project_state`**: Per-project state including window bounds, UI layout, open tabs, file tree, and editor settings
- **`session_state`**: Global session restoration data for windows and focus order
- **`document_history`**: Compressed document edit history with binary content storage

## Data Locations (macOS)

- **Database**: `~/Library/Application Support/@nimbalyst/electron/pglite-db/`
- **Logs**: `~/Library/Application Support/@nimbalyst/electron/logs/`
- **Debug log**: `~/Library/Application Support/@nimbalyst/electron/nimbalyst-debug.log`
- **Legacy files**: `~/Library/Application Support/@nimbalyst/electron/history/` (preserved after migration)

## Database Features

- **Compression**: Document history stored as compressed binary data (BYTEA)
- **JSON support**: Rich JSON fields for complex data structures (JSONB columns)
- **Indexing**: Optimized indexes for fast queries on projects, timestamps, and file paths
- **Protocol server**: Optional PostgreSQL protocol server for external database access

## CRITICAL: App Shutdown and Database Integrity

**NEVER use `app.exit()` to terminate the app.** It bypasses the `before-quit` handler in `index.ts`, skipping database backup and PGLite worker shutdown, which causes database corruption.

Always use `app.quit()` to trigger proper cleanup. For programmatic restarts:

```typescript
// Dev mode: write signal file, let dev-loop.sh handle restart
fs.writeFileSync(path.join(app.getAppPath(), '.restart-requested'), Date.now().toString());
app.quit();

// Production: use relaunch + quit
app.relaunch();
app.quit();
```

Dev mode requires the signal file because `app.relaunch()` doesn't work when electron-vite spawns both Vite and Electron processes.

## CRITICAL: Date/Timestamp Handling

All timestamp columns use `TIMESTAMPTZ` (timestamp with time zone). With `TIMESTAMPTZ`, PGLite returns Date objects that already represent the correct instant in time.

**Rules when working with database timestamps:**

1. **DO**: Use `TIMESTAMPTZ` for all timestamp columns (not `TIMESTAMP` without timezone).

2. **DO**: Pass Date objects directly when writing to `TIMESTAMPTZ` columns:
   ```typescript
   db.query('INSERT INTO ... VALUES ($1)', [new Date()])
   ```

3. **DO**: Retrieve timestamps through `toMillis()`:
   ```typescript
   const createdAt = toMillis(row.created_at)!;              // Required timestamp
   const claimedAt = toMillis(row.claimed_at) ?? undefined;  // Nullable timestamp
   ```

4. **DO**: Display with `toLocaleString()` for user's local timezone.

**Related files:**
- `src/main/database/worker.js` — Database schema and comments
- `src/main/utils/timestampUtils.ts` — Canonical `toMillis()` implementation
