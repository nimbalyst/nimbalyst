/**
 * Privacy-safe database error telemetry.
 *
 * Raw database errors are inspected locally to select fixed categories and
 * codes, but are never copied into the returned PostHog properties. SQL is
 * similarly reduced to a conservative allowlist of Nimbalyst-owned tables so
 * aliases, columns, extension tables, and customer-defined identifiers cannot
 * become analytics values.
 */

export type DatabaseTelemetryBackend = 'pglite' | 'sqlite';
export type DatabaseTelemetryOperation = 'read' | 'write';

export type DatabaseErrorCategory =
  | 'availability'
  | 'concurrency'
  | 'constraint'
  | 'corruption'
  | 'permission'
  | 'query'
  | 'resource'
  | 'schema'
  | 'storage'
  | 'timeout'
  | 'unknown';

export type DatabaseErrorCode =
  | 'column_missing'
  | 'constraint_check'
  | 'constraint_foreign_key'
  | 'constraint_not_null'
  | 'constraint_unique'
  | 'database_busy'
  | 'database_closed'
  | 'database_corrupt'
  | 'database_locked'
  | 'database_read_only'
  | 'database_unavailable'
  | 'disk_full'
  | 'initialization_failed'
  | 'invalid_parameter'
  | 'io_error'
  | 'memory_exhausted'
  | 'not_initialized'
  | 'permission_denied'
  | 'query_cancelled'
  | 'query_syntax'
  | 'statement_timeout'
  | 'table_exists'
  | 'table_missing'
  | 'transaction_aborted'
  | 'type_mismatch'
  | 'value_too_large'
  | 'wasm_runtime_crash'
  | 'worker_timeout'
  | 'worker_unavailable'
  | 'unknown';

export interface ClassifiedDatabaseError {
  errorCategory: DatabaseErrorCategory;
  errorCode: DatabaseErrorCode;
  /**
   * The engine's own error code -- a Postgres SQLSTATE (`42P01`) or a
   * better-sqlite3 code (`SQLITE_BUSY`). Bounded and content-free, so it is
   * safe to send even though the error text is not. It is what makes a failure
   * we never anticipated still diagnosable.
   */
  sqlState: string;
}

export interface DatabaseOperationErrorProperties
  extends ClassifiedDatabaseError {
  backend: DatabaseTelemetryBackend;
  operation: DatabaseTelemetryOperation;
  tableName: string;
}

export interface DatabaseInitializationErrorProperties
  extends ClassifiedDatabaseError {
  backend: DatabaseTelemetryBackend;
}

/**
 * One report per failure category per day, not per minute.
 *
 * The original 60s window was scoped to stop a wedged database emitting ~1,000
 * events a minute, and it did. But paired with the high-cardinality signature
 * below it still produced 25,901 events across 826 users in 30 days -- about 31
 * each, for what is meant to be an aggregate health signal. A day-long window
 * keeps the first occurrence (which is the one that tells you anything) and
 * still reports the suppressed count if the problem outlives the window.
 */
export const DATABASE_ERROR_TELEMETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * PostHog is an aggregate signal, not an error log.
 *
 * A wedged database does not fail once -- it fails on every query the app
 * attempts, for as long as it stays wedged. On 2026-08-03 that produced ~1,000
 * events per MINUTE from a single session (~62,000 in two hours) and told us
 * nothing the first event hadn't. Each distinct failure signature reports at
 * most once per window; the occurrences in between are counted and stamped on
 * the next event that gets through, so the true volume stays visible without
 * paying an event for each one. Every occurrence still reaches the local log.
 */
export class DatabaseErrorTelemetryLimiter {
  private readonly seen = new Map<string, { windowStart: number; suppressed: number }>();

  constructor(
    private readonly windowMs: number = DATABASE_ERROR_TELEMETRY_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Returns how many events this signature suppressed since it last reported,
   * or `null` when this occurrence should itself be suppressed.
   */
  admit(properties: DatabaseOperationErrorProperties): number | null {
    // Deliberately coarse. Including operation/errorCode/sqlState/tableName made
    // the signature high-cardinality enough that one underlying problem reported
    // once per affected table per statement kind -- the same failure counted
    // dozens of times. The category is what anyone actually charts; the exact
    // code, sqlState and table are still on the event payload and in the local
    // log for whoever opens one.
    const signature = [properties.backend, properties.errorCategory].join(':');

    const timestamp = this.now();
    const entry = this.seen.get(signature);
    if (!entry || timestamp - entry.windowStart >= this.windowMs) {
      this.seen.set(signature, { windowStart: timestamp, suppressed: 0 });
      this.evictExpired(timestamp);
      return entry ? entry.suppressed : 0;
    }
    entry.suppressed += 1;
    return null;
  }

  private evictExpired(now: number): void {
    if (this.seen.size <= 500) return;
    const cutoff = now - this.windowMs;
    for (const [key, entry] of this.seen) {
      if (entry.windowStart < cutoff) this.seen.delete(key);
    }
  }
}

const CORE_TABLE_NAMES = new Set([
  '_migrations',
  '_perf_slow_queries',
  'account_org_binding_repairs',
  'account_org_bindings',
  'ai_agent_messages',
  'ai_agent_messages_fts',
  'ai_session_wakeups',
  'ai_sessions',
  'ai_tool_call_file_edits',
  'ai_transcript_events',
  'collab_document_assets',
  'collab_document_outbox',
  'collab_document_replica_updates',
  'collab_document_replicas',
  'collab_local_origins',
  'document_history',
  'org_members',
  'orgs',
  'project_access',
  'project_file_sync_baseline',
  'projects',
  'pull_request_checks',
  'pull_request_commits',
  'pull_request_files',
  'pull_requests',
  'queued_prompts',
  'read_receipts',
  'session_files',
  'super_iterations',
  'super_loops',
  'tool_usage_backfill_meta',
  'tool_usage_backfill_sessions',
  'tool_usage_counters',
  'tracker_body_cache',
  'tracker_items',
  'tracker_personal_state',
  'tracker_relationship_index',
  'tracker_shared_saved_views',
  'tracker_transactions',
  'tracker_type_defs',
  'tracker_type_navigation',
  'worktrees',
]);

const SYSTEM_TABLE_NAMES = new Set([
  'dbstat',
  'information_schema',
  'pg_attribute',
  'pg_catalog',
  'pg_index',
  'pg_ls_waldir',
  'sqlite_master',
  'sqlite_schema',
]);

interface SqlToken {
  value: string;
  symbol: boolean;
}

function errorField(error: unknown, field: string): string {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return '';
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : errorField(error, 'message') || String(error ?? '');
  // Classification never needs an unbounded stack/error payload.
  return message.slice(0, 4_000).toLowerCase();
}

/**
 * Engine codes are short, fixed identifiers (`42P01`, `SQLITE_BUSY`, `ENOENT`).
 * Anything that does not look like one is dropped rather than forwarded, so a
 * library that stuffs prose into `code` cannot turn it into an analytics value.
 */
function safeSqlState(error: unknown): string {
  const code = errorField(error, 'code');
  return /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : 'none';
}

function fixed(
  errorCategory: DatabaseErrorCategory,
  errorCode: DatabaseErrorCode,
  error: unknown,
): ClassifiedDatabaseError {
  return { errorCategory, errorCode, sqlState: safeSqlState(error) };
}

/**
 * A transaction left in the aborted state fails every following statement on
 * that connection with the same message, which is exactly the shape that
 * produces a spike. It must be recognized before the WASM check below, whose
 * `abort` matching would otherwise swallow it.
 */
function isAbortedTransaction(message: string): boolean {
  return message.includes('current transaction is aborted');
}

export function isPgliteWasmRuntimeCrash(error: unknown): boolean {
  const message = errorMessage(error);
  if (isAbortedTransaction(message)) return false;
  return (
    message.includes('exit(1)')
    || message.includes('program terminated')
    || message.includes('exitstatus')
    || message.includes('aborted')
    || message.includes('wasm runtime')
    || message.includes('webassembly.runtimeerror')
  );
}

/**
 * Convert backend-specific error details into a bounded analytics taxonomy.
 * Structured engine codes take precedence; message inspection is fallback
 * only and no source text is returned.
 */
export function classifyDatabaseError(
  error: unknown,
): ClassifiedDatabaseError {
  const code = errorField(error, 'code').toUpperCase();
  const message = errorMessage(error);

  // Checked first: an aborted transaction fails every subsequent statement on
  // the connection with this same message, so it is the single most likely
  // source of a runaway error loop and must not be absorbed by a broader rule.
  if (code === '25P02' || isAbortedTransaction(message)) {
    return fixed('concurrency', 'transaction_aborted', error);
  }

  if (isPgliteWasmRuntimeCrash(error)) {
    return fixed('availability', 'wasm_runtime_crash', error);
  }

  if (
    code === '57014'
    || code === 'SQLITE_INTERRUPT'
    || message.includes('query cancelled')
    || message.includes('query canceled')
  ) {
    return fixed('timeout', 'query_cancelled', error);
  }
  if (
    message.includes('statement timeout')
    || message.includes('statement_timeout')
  ) {
    return fixed('timeout', 'statement_timeout', error);
  }
  // `PGLiteDatabaseWorker.sendMessage` rejects with `Request <type> timed out`.
  if (message.includes('timed out')) {
    return fixed('timeout', 'worker_timeout', error);
  }

  if (code === '23505' || code.startsWith('SQLITE_CONSTRAINT_UNIQUE')) {
    return fixed('constraint', 'constraint_unique', error);
  }
  if (code === '23503' || code.startsWith('SQLITE_CONSTRAINT_FOREIGNKEY')) {
    return fixed('constraint', 'constraint_foreign_key', error);
  }
  if (code === '23502' || code.startsWith('SQLITE_CONSTRAINT_NOTNULL')) {
    return fixed('constraint', 'constraint_not_null', error);
  }
  if (code === '23514' || code.startsWith('SQLITE_CONSTRAINT_CHECK')) {
    return fixed('constraint', 'constraint_check', error);
  }

  if (
    code === '42P01'
    || message.includes('no such table')
    || (message.includes('relation') && message.includes('does not exist'))
  ) {
    return fixed('schema', 'table_missing', error);
  }
  if (
    code === '42703'
    || message.includes('no such column')
    || (message.includes('column') && message.includes('does not exist'))
  ) {
    return fixed('schema', 'column_missing', error);
  }
  if (
    code === '42P07'
    || message.includes('table already exists')
    || (message.includes('relation') && message.includes('already exists'))
  ) {
    return fixed('schema', 'table_exists', error);
  }
  if (
    code === '42601'
    || message.includes('syntax error')
    || message.includes('parse error')
  ) {
    return fixed('query', 'query_syntax', error);
  }
  if (
    code === 'SQLITE_RANGE'
    || message.includes('bind or column index out of range')
    || message.includes('incorrect number of bindings')
  ) {
    return fixed('query', 'invalid_parameter', error);
  }
  if (
    code === 'SQLITE_MISMATCH'
    || code === '42804'
    || message.includes('datatype mismatch')
    || message.includes('type mismatch')
  ) {
    return fixed('query', 'type_mismatch', error);
  }

  if (
    code === '55P03'
    || code === 'SQLITE_LOCKED'
    || code === 'DATABASE_LOCKED'
    || code === 'DATABASE_LOCKED_AMBIGUOUS'
    || message.includes('database is locked')
  ) {
    return fixed('concurrency', 'database_locked', error);
  }
  if (code === 'SQLITE_BUSY' || message.includes('database is busy')) {
    return fixed('concurrency', 'database_busy', error);
  }

  if (
    code === '42501'
    || code === 'EACCES'
    || code === 'EPERM'
    || code === 'SQLITE_PERM'
    || message.includes('permission denied')
  ) {
    return fixed('permission', 'permission_denied', error);
  }
  if (
    code === 'SQLITE_READONLY'
    || message.includes('attempt to write a readonly')
    || message.includes('read-only database')
  ) {
    return fixed('permission', 'database_read_only', error);
  }

  if (
    code === '53100'
    || code === 'ENOSPC'
    || code === 'SQLITE_FULL'
    || message.includes('disk full')
    || message.includes('no space left on device')
  ) {
    return fixed('storage', 'disk_full', error);
  }
  if (
    code === 'SQLITE_IOERR'
    || code.startsWith('SQLITE_IOERR_')
    || code === 'EIO'
    || message.includes('i/o error')
    || message.includes('disk i/o')
  ) {
    return fixed('storage', 'io_error', error);
  }
  if (
    code === 'XX001'
    || code === 'SQLITE_CORRUPT'
    || code === 'SQLITE_NOTADB'
    || message.includes('database disk image is malformed')
    || message.includes('database corrupt')
  ) {
    return fixed('corruption', 'database_corrupt', error);
  }

  if (
    code === '53200'
    || code === 'SQLITE_NOMEM'
    || message.includes('out of memory')
  ) {
    return fixed('resource', 'memory_exhausted', error);
  }
  if (
    code === 'SQLITE_TOOBIG'
    || code === '54000'
    || message.includes('too large')
  ) {
    return fixed('resource', 'value_too_large', error);
  }

  if (
    code === 'SQLITE_CANTOPEN'
    || code === 'ENOENT'
    || message.includes('unable to open database')
    || message.includes('cannot open database')
  ) {
    return fixed('availability', 'database_unavailable', error);
  }
  if (
    message.includes('database not initialized')
    || message.includes('database is not initialized')
  ) {
    return fixed('availability', 'not_initialized', error);
  }
  if (
    message.includes('worker not initialized')
    || message.includes('worker not running')
    || message.includes('worker exited')
    || message.includes('databaseproxy closed')
  ) {
    return fixed('availability', 'worker_unavailable', error);
  }
  if (
    code === 'DATABASE_INIT_FAILED'
    || message.includes('database_init_failed')
  ) {
    return fixed('availability', 'initialization_failed', error);
  }
  // Work queued against a handle that is already torn down -- `WriteCoordinator
  // is closed`, and the equivalents raised during shutdown.
  if (message.includes('is closed') || message.includes('shutting down')) {
    return fixed('availability', 'database_closed', error);
  }

  return fixed('unknown', 'unknown', error);
}

function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (char === '-' && next === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i += 1;
      }
      i = Math.min(sql.length, i + 2);
      continue;
    }
    if (char === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (char === '$') {
      const delimiter = sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0];
      if (delimiter) {
        const end = sql.indexOf(delimiter, i + delimiter.length);
        i = end === -1 ? sql.length : end + delimiter.length;
        continue;
      }
    }
    if (char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      let value = '';
      i += 1;
      while (i < sql.length) {
        if (sql[i] === close && sql[i + 1] === close && close !== ']') {
          value += close;
          i += 2;
          continue;
        }
        if (sql[i] === close) {
          i += 1;
          break;
        }
        value += sql[i];
        i += 1;
      }
      if (value) tokens.push({ value: value.toLowerCase(), symbol: false });
      continue;
    }
    if (/[a-zA-Z_]/.test(char)) {
      const start = i;
      i += 1;
      while (i < sql.length && /[a-zA-Z0-9_$]/.test(sql[i])) i += 1;
      tokens.push({
        value: sql.slice(start, i).toLowerCase(),
        symbol: false,
      });
      continue;
    }
    if ('().,;'.includes(char)) {
      tokens.push({ value: char, symbol: true });
    }
    i += 1;
  }

  return tokens;
}

function relationAfter(
  tokens: SqlToken[],
  startIndex: number,
): string | null {
  let i = startIndex;
  const skipped = new Set([
    'if',
    'lateral',
    'not',
    'only',
    'exists',
    'temp',
    'temporary',
  ]);
  while (tokens[i] && !tokens[i].symbol && skipped.has(tokens[i].value)) {
    i += 1;
  }
  if (!tokens[i] || tokens[i].symbol) return null;

  let relation = tokens[i].value;
  while (
    tokens[i + 1]?.value === '.'
    && tokens[i + 2]
    && !tokens[i + 2].symbol
  ) {
    relation = tokens[i + 2].value;
    i += 2;
  }
  return relation;
}

function safeTableName(candidate: string): string {
  if (CORE_TABLE_NAMES.has(candidate)) return candidate;
  if (
    SYSTEM_TABLE_NAMES.has(candidate)
    || candidate.startsWith('pg_')
    || candidate.startsWith('sqlite_')
  ) {
    return 'system_catalog';
  }
  // FTS5 creates auxiliary tables whose suffixes are implementation details.
  if (candidate.startsWith('ai_agent_messages_fts_')) {
    return 'ai_agent_messages_fts';
  }
  return 'unknown';
}

const TRANSACTION_CONTROL_VERBS = new Set([
  'begin',
  'commit',
  'end',
  'release',
  'rollback',
  'savepoint',
  'start',
]);

/**
 * Attribute SQL only when its first real relation is a known core/system
 * table. Returning `unknown` is intentional for extension/customer tables.
 */
export function extractDatabaseTableName(sql: string): string {
  const tokens = tokenizeSql(sql);
  let createIndex = false;

  // Transaction control names no table. Reporting these as `unknown` is what
  // made the 2026-08-03 spike unreadable: ~28,000 events pointed at an
  // "unresolved table" that was really BEGIN/COMMIT/ROLLBACK failing against a
  // dead database.
  const firstWord = tokens.find((token) => !token.symbol)?.value;
  if (firstWord && TRANSACTION_CONTROL_VERBS.has(firstWord)) {
    return 'transaction';
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.symbol) continue;

    if (
      token.value === 'create'
      && (tokens[i + 1]?.value === 'index'
        || tokens[i + 2]?.value === 'index')
    ) {
      createIndex = true;
      continue;
    }

    let relation: string | null = null;
    if (
      token.value === 'from'
      || token.value === 'join'
      || token.value === 'into'
      || token.value === 'update'
    ) {
      relation = relationAfter(tokens, i + 1);
    } else if (
      token.value === 'table'
      && ['alter', 'create', 'drop', 'truncate'].includes(
        tokens[i - 1]?.value ?? '',
      )
    ) {
      relation = relationAfter(tokens, i + 1);
    } else if (createIndex && token.value === 'on') {
      relation = relationAfter(tokens, i + 1);
      createIndex = false;
    } else if (token.value === 'vacuum' || token.value === 'analyze') {
      relation = relationAfter(tokens, i + 1);
    }

    if (relation) return safeTableName(relation);
  }

  return 'unknown';
}

export function classifyDatabaseOperation(
  sql: string,
): DatabaseTelemetryOperation {
  const tokens = tokenizeSql(sql);
  const firstWord = tokens.find((token) => !token.symbol)?.value;
  if (firstWord === 'explain') return 'read';

  const readVerbs = new Set(['select', 'show', 'pragma', 'values']);
  const writeVerbs = new Set([
    'alter',
    'begin',
    'commit',
    'create',
    'delete',
    'do',
    'drop',
    'end',
    'insert',
    'merge',
    'release',
    'replace',
    'rollback',
    'savepoint',
    'set',
    'start',
    'truncate',
    'update',
    'vacuum',
  ]);

  let depth = 0;
  let withOperation: DatabaseTelemetryOperation | null = null;
  for (const token of tokens) {
    if (token.value === '(') {
      depth += 1;
      continue;
    }
    if (token.value === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || token.symbol) continue;
    if (readVerbs.has(token.value)) {
      if (firstWord === 'with') withOperation = 'read';
      else return 'read';
    }
    if (writeVerbs.has(token.value)) {
      if (firstWord === 'with') withOperation = 'write';
      else return 'write';
    }
  }

  return withOperation ?? 'read';
}

export function buildDatabaseOperationErrorProperties(args: {
  backend: DatabaseTelemetryBackend;
  error: unknown;
  sql: string;
  operation?: DatabaseTelemetryOperation;
}): DatabaseOperationErrorProperties {
  return {
    backend: args.backend,
    operation: args.operation ?? classifyDatabaseOperation(args.sql),
    ...classifyDatabaseError(args.error),
    tableName: extractDatabaseTableName(args.sql),
  };
}

export function buildDatabaseInitializationErrorProperties(
  error: unknown,
  backend: DatabaseTelemetryBackend,
): DatabaseInitializationErrorProperties {
  return {
    backend,
    ...classifyDatabaseError(error),
  };
}
