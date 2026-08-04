// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildDatabaseInitializationErrorProperties,
  buildDatabaseOperationErrorProperties,
  classifyDatabaseOperation,
  DatabaseErrorTelemetryLimiter,
  DATABASE_ERROR_TELEMETRY_WINDOW_MS,
  extractDatabaseTableName,
  isPgliteWasmRuntimeCrash,
} from '../DatabaseErrorTelemetry';

describe('database error telemetry contract', () => {
  it('classifies PostgreSQL and SQLite errors into stable categories and codes', () => {
    const missingTable = Object.assign(
      new Error('relation "private_customer_table" does not exist'),
      { code: '42P01' },
    );
    expect(
      buildDatabaseOperationErrorProperties({
        backend: 'pglite',
        error: missingTable,
        sql: 'SELECT * FROM tool_usage_counters',
      }),
    ).toEqual({
      backend: 'pglite',
      operation: 'read',
      errorCategory: 'schema',
      errorCode: 'table_missing',
      sqlState: '42P01',
      tableName: 'tool_usage_counters',
    });

    const busy = Object.assign(new Error('database is busy'), {
      code: 'SQLITE_BUSY',
    });
    expect(
      buildDatabaseOperationErrorProperties({
        backend: 'sqlite',
        error: busy,
        sql: 'UPDATE ai_sessions SET updated_at = NOW()',
      }),
    ).toMatchObject({
      backend: 'sqlite',
      operation: 'write',
      errorCategory: 'concurrency',
      errorCode: 'database_busy',
      tableName: 'ai_sessions',
    });
  });

  it('never copies raw error text, paths, or usernames into operation properties', () => {
    const error = Object.assign(
      new Error(
        'SQLITE_CANTOPEN: unable to open /Users/alice/Clients/Secret/nimbalyst.sqlite',
      ),
      { code: 'SQLITE_CANTOPEN' },
    );
    const properties = buildDatabaseOperationErrorProperties({
      backend: 'sqlite',
      error,
      sql: 'SELECT created_at AS timestamp FROM tool_usage_counters s',
    });

    expect(properties).toEqual({
      backend: 'sqlite',
      operation: 'read',
      errorCategory: 'availability',
      errorCode: 'database_unavailable',
      sqlState: 'SQLITE_CANTOPEN',
      tableName: 'tool_usage_counters',
    });
    expect(JSON.stringify(properties)).not.toContain('alice');
    expect(JSON.stringify(properties)).not.toContain('/Users/');
    expect(properties).not.toHaveProperty('message');
    expect(properties).not.toHaveProperty('errorMessage');
  });

  it('never copies raw error text into initialization properties', () => {
    const error = Object.assign(
      new Error(
        'failed to open /Users/jane.doe/Library/Application Support/@nimbalyst/electron/sqlite-db',
      ),
      { code: 'SQLITE_CANTOPEN' },
    );
    const properties = buildDatabaseInitializationErrorProperties(
      error,
      'sqlite',
    );

    expect(properties).toEqual({
      backend: 'sqlite',
      errorCategory: 'availability',
      errorCode: 'database_unavailable',
      sqlState: 'SQLITE_CANTOPEN',
    });
    expect(JSON.stringify(properties)).not.toContain('jane.doe');
    expect(JSON.stringify(properties)).not.toContain('/Users/');
    expect(properties).not.toHaveProperty('message');
    expect(properties).not.toHaveProperty('errorMessage');
  });

  it('uses bounded message inspection only to choose a fixed timeout code', () => {
    const properties = buildDatabaseOperationErrorProperties({
      backend: 'pglite',
      error: new Error(
        'canceling statement due to statement timeout while reading /Users/alice/private',
      ),
      sql: 'SELECT * FROM ai_agent_messages',
    });

    expect(properties).toMatchObject({
      errorCategory: 'timeout',
      errorCode: 'statement_timeout',
    });
    expect(JSON.stringify(properties)).not.toContain('private');
  });

  it('recognizes PGLite WASM crashes without exposing their message', () => {
    expect(
      isPgliteWasmRuntimeCrash(
        new Error(
          'RuntimeError: Aborted at /Users/alice/Library/Application Support/database',
        ),
      ),
    ).toBe(true);
    expect(
      isPgliteWasmRuntimeCrash(
        new Error('DATABASE_INIT_FAILED: schema migration failed'),
      ),
    ).toBe(false);
  });

  it('drops a code it cannot vouch for rather than forwarding it', () => {
    // A library that puts prose in `code` must not turn it into an analytics
    // value the way the message never is.
    const properties = buildDatabaseOperationErrorProperties({
      backend: 'sqlite',
      error: Object.assign(new Error('write failed'), {
        code: "constraint on row 'buy milk for Dana'",
      }),
      sql: 'INSERT INTO ai_agent_messages (content) VALUES ($1)',
    });

    expect(properties.sqlState).toBe('none');
    expect(JSON.stringify(properties)).not.toContain('Dana');
  });

  it('names the failures that actually produced the 2026-08-03 spike', () => {
    // An aborted transaction fails every following statement on the connection
    // with the same message. It must not be absorbed by the WASM `abort` rule,
    // which is what would have hidden it behind `wasm_runtime_crash`.
    const aborted = new Error(
      'current transaction is aborted, commands ignored until end of transaction block',
    );
    expect(isPgliteWasmRuntimeCrash(aborted)).toBe(false);
    expect(
      buildDatabaseOperationErrorProperties({
        backend: 'pglite',
        error: aborted,
        sql: 'BEGIN',
      }),
    ).toMatchObject({
      operation: 'write',
      errorCategory: 'concurrency',
      errorCode: 'transaction_aborted',
      // ~28,000 events reported an "unresolved table" that was really this.
      tableName: 'transaction',
    });

    // Verbatim messages this codebase throws; every one of them used to land
    // in `unknown` with nothing else attached.
    expect(
      buildDatabaseOperationErrorProperties({
        backend: 'pglite',
        error: new Error('Request query timed out'),
        sql: 'SELECT * FROM ai_agent_messages WHERE session_id = $1',
      }),
    ).toMatchObject({ errorCategory: 'timeout', errorCode: 'worker_timeout' });

    expect(
      buildDatabaseOperationErrorProperties({
        backend: 'sqlite',
        error: new Error('WriteCoordinator is closed'),
        sql: 'COMMIT',
      }),
    ).toMatchObject({
      errorCategory: 'availability',
      errorCode: 'database_closed',
    });
  });

  it('reports a signature once per window and counts what it suppressed', () => {
    let now = 0;
    const limiter = new DatabaseErrorTelemetryLimiter(
      DATABASE_ERROR_TELEMETRY_WINDOW_MS,
      () => now,
    );
    const properties = buildDatabaseOperationErrorProperties({
      backend: 'pglite',
      error: Object.assign(new Error('missing'), { code: '42P01' }),
      sql: 'SELECT * FROM tool_usage_counters',
    });

    expect(limiter.admit(properties)).toBe(0);

    // A wedged database keeps failing; the next 999 attempts must not each
    // cost an analytics event.
    for (let i = 0; i < 999; i += 1) {
      expect(limiter.admit(properties)).toBeNull();
    }

    now = DATABASE_ERROR_TELEMETRY_WINDOW_MS;
    expect(limiter.admit(properties)).toBe(999);
  });

  it('does not let one noisy signature mask a different failure', () => {
    let now = 0;
    const limiter = new DatabaseErrorTelemetryLimiter(
      DATABASE_ERROR_TELEMETRY_WINDOW_MS,
      () => now,
    );
    const wedged = buildDatabaseOperationErrorProperties({
      backend: 'pglite',
      error: new Error('current transaction is aborted'),
      sql: 'BEGIN',
    });
    const corrupt = buildDatabaseOperationErrorProperties({
      backend: 'pglite',
      error: new Error('database disk image is malformed'),
      sql: 'SELECT * FROM ai_agent_messages',
    });

    expect(limiter.admit(wedged)).toBe(0);
    expect(limiter.admit(wedged)).toBeNull();
    // A genuinely different problem still gets through immediately.
    expect(limiter.admit(corrupt)).toBe(0);
  });

  it('reads corruption as corruption rather than a full disk', () => {
    // SQLite's corruption error is literally "database disk image is
    // malformed", which a naive `disk` test mislabels as a full volume.
    expect(
      buildDatabaseOperationErrorProperties({
        backend: 'sqlite',
        error: new Error('database disk image is malformed'),
        sql: 'SELECT * FROM tracker_items',
      }),
    ).toMatchObject({
      errorCategory: 'corruption',
      errorCode: 'database_corrupt',
    });
  });
});

describe('database table attribution', () => {
  it('attributes SELECT aliases and column names to the actual core table', () => {
    expect(
      extractDatabaseTableName(
        `SELECT s.created_at AS timestamp
           FROM tool_usage_counters AS s
          ORDER BY created_at DESC`,
      ),
    ).toBe('tool_usage_counters');
  });

  it('finds the underlying core table through CTEs and derived tables', () => {
    expect(
      extractDatabaseTableName(
        `WITH recent AS (
           SELECT created_at FROM "ai_agent_messages" WHERE created_at > $1
         )
         SELECT r.created_at FROM recent r`,
      ),
    ).toBe('ai_agent_messages');

    expect(
      extractDatabaseTableName(
        `SELECT s.timestamp
           FROM (SELECT created_at AS timestamp FROM ai_sessions) AS s`,
      ),
    ).toBe('ai_sessions');
  });

  it('handles schema-qualified and quoted core table names', () => {
    expect(
      extractDatabaseTableName(
        'SELECT * FROM "public"."tracker_items" AS "timestamp"',
      ),
    ).toBe('tracker_items');
  });

  it('does not mistake comments or string literals for table references', () => {
    expect(
      extractDatabaseTableName(
        `SELECT 'FROM ai_sessions' AS text_value
           FROM tool_usage_counters
          -- JOIN tracker_items
        `,
      ),
    ).toBe('tool_usage_counters');
  });

  it('does not send arbitrary extension-defined table names', () => {
    expect(
      extractDatabaseTableName(
        'SELECT customer_name FROM client_revenue_export',
      ),
    ).toBe('unknown');
  });

  it('uses a fixed label for system catalogs', () => {
    expect(
      extractDatabaseTableName(
        `SELECT name FROM sqlite_master WHERE type = 'table'`,
      ),
    ).toBe('system_catalog');
  });

  it('labels transaction control instead of calling it an unknown table', () => {
    for (const sql of ['BEGIN', 'commit', 'ROLLBACK', 'SAVEPOINT sp1', 'RELEASE sp1']) {
      expect(extractDatabaseTableName(sql)).toBe('transaction');
      expect(classifyDatabaseOperation(sql)).toBe('write');
    }
  });
});

describe('database operation classification', () => {
  it('classifies CTE reads and writes by their top-level statement', () => {
    expect(
      classifyDatabaseOperation(
        'WITH recent AS (SELECT id FROM ai_sessions) SELECT * FROM recent',
      ),
    ).toBe('read');
    expect(
      classifyDatabaseOperation(
        `WITH recent AS (SELECT id FROM ai_sessions)
         UPDATE ai_sessions SET updated_at = NOW()
         WHERE id IN (SELECT id FROM recent)`,
      ),
    ).toBe('write');
  });

  it('classifies DDL and parameterized DML as writes', () => {
    expect(
      classifyDatabaseOperation(
        'CREATE INDEX idx_tool_usage_day ON tool_usage_counters(day)',
      ),
    ).toBe('write');
    expect(
      classifyDatabaseOperation(
        'INSERT INTO tool_usage_counters (tool_name, day) VALUES ($1, $2)',
      ),
    ).toBe('write');
  });
});
