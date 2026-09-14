/**
 * Inline SQL code-completion provider for Monaco.
 *
 * Surfaces:
 *   - SQL reserved keywords (SELECT, FROM, WHERE, JOIN, ...)
 *   - Table names declared in the currently visible document
 *     (CREATE TABLE / INSERT INTO / FROM <name>) and optionally from
 *     additional SQL sources passed via the `extraSources` option
 *   - Column names declared for those tables (`CREATE TABLE t (col, ...)`)
 *     when the cursor is in a column-list position (`SELECT |FROM t` or
 *     `t.|` and `SELECT ... FROM t WHERE x = |`)
 *
 * The core is a pure function `provideSqlCompletionsFromText(text, offset, options?)`
 * so unit tests can run without a real Monaco model.
 */

import type { languages } from 'monaco-editor';

export type SqlCompletionItem = languages.CompletionItem;

export interface SqlCompletionOptions {
  /**
   * Optional additional SQL source strings to scan for tables and columns,
   * e.g. other SQL files in the workspace. Each entry is full SQL text.
   * When omitted, only the document under edit is scanned.
   */
  extraSources?: readonly string[];
}

/**
 * Common SQL reserved words surfaced as keyword completions.
 * Kept short and high-signal — only words a typist is likely to start with.
 */
const SQL_KEYWORDS: readonly string[] = [
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'NULL',
  'IS',
  'IN',
  'LIKE',
  'BETWEEN',
  'EXISTS',
  'JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'FULL JOIN',
  'CROSS JOIN',
  'ON',
  'USING',
  'GROUP BY',
  'ORDER BY',
  'ASC',
  'DESC',
  'LIMIT',
  'OFFSET',
  'HAVING',
  'DISTINCT',
  'AS',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'CREATE',
  'CREATE TABLE',
  'CREATE INDEX',
  'ALTER',
  'ALTER TABLE',
  'DROP',
  'DROP TABLE',
  'DROP INDEX',
  'TRUNCATE',
  'TABLE',
  'INDEX',
  'VIEW',
  'PRIMARY KEY',
  'FOREIGN KEY',
  'REFERENCES',
  'UNIQUE',
  'DEFAULT',
  'CHECK',
  'CONSTRAINT',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'UNION',
  'UNION ALL',
  'INTERSECT',
  'EXCEPT',
  'WITH',
  'RETURNING',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'TRANSACTION',
];

/**
 * Match a SQL identifier (unquoted): letters, digits, underscore; must not
 * start with a digit. Backtick- and double-quoted identifiers are tolerated
 * for column/table names that need escaping, but the alias is stripped.
 */
const SQL_IDENT = String.raw`(?:[\u2019\x60"]?)([A-Za-z_][A-Za-z0-9_]*)(?:[\u2019\x60"]?)`;
const CREATE_TABLE_RE = new RegExp(
  String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?` + SQL_IDENT + String.raw`\s*\(([^)]*)\)`,
  'gi',
);
const COLUMN_NAME_RE = new RegExp(String.raw`^\s*` + SQL_IDENT + String.raw`\b`, '');
const TABLE_REF_RE = new RegExp(
  String.raw`\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+` + SQL_IDENT + String.raw`\b`,
  'gi',
);

function scanSqlSource(source: string): { tables: Map<string, string[]>; refs: Set<string> } {
  const tables = new Map<string, string[]>();
  const refs = new Set<string>();

  // CREATE TABLE -> name + columns
  const createBodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = CREATE_TABLE_RE.exec(source)) !== null) {
    const name = match[1];
    const body = match[2] ?? '';
    tables.set(name, []);
    createBodies.push(body);
    refs.add(name);
  }
  for (const body of createBodies) {
    const parts: string[] = [];
    let depth = 0;
    let buf = '';
    for (const ch of body) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(buf);
        buf = '';
        continue;
      }
      buf += ch;
    }
    if (buf.trim().length > 0) parts.push(buf);
    const columns: string[] = [];
    for (const part of parts) {
      if (/^\s*(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(part)) {
        continue;
      }
      const m = part.match(COLUMN_NAME_RE);
      if (m && m[1]) columns.push(m[1]);
    }
    // Parse the last `CREATE TABLE name (...)` we saw and assign its columns.
    // (A document typically has one CREATE TABLE per name; later CREATE TABLE
    // statements overwrite prior columns.)
    const lastName = [...tables.keys()].pop();
    if (lastName) tables.set(lastName, columns);
  }

  // FROM / INTO / UPDATE / JOIN / TABLE -> table names referenced
  while ((match = TABLE_REF_RE.exec(source)) !== null) {
    const name = match[1];
    if (name) {
      refs.add(name.toLowerCase());
      // If a reference predates a CREATE TABLE definition, register it
      // as a known table now so completions can still surface it.
      if (!tables.has(name)) tables.set(name, []);
    }
  }
  return { tables, refs };
}

function getCurrentPrefix(text: string, offset: number): string {
  // Word-prefix backwards from `offset` until we hit a non-identifier
  // boundary. Keeps trailing `.` so member-access prefixes like `t.|`
  // are surfaced to the provider.
  let i = offset;
  while (i > 0) {
    const ch = text[i - 1];
    if (!/[A-Za-z0-9_.]/.test(ch)) break;
    i--;
  }
  return text.slice(i, offset);
}

function getWordBeforeDot(text: string, offset: number): { table: string | null; afterDot: boolean } {
  const prefix = getCurrentPrefix(text, offset);
  const dotIndex = prefix.lastIndexOf('.');
  if (dotIndex >= 0) {
    return { table: prefix.slice(0, dotIndex), afterDot: true };
  }
  return { table: null, afterDot: false };
}

function endsWithFrom(lower: string): string | null {
  // Return the table name immediately following the last unmatched `FROM`,
  // or null if there isn't one. Used to detect "SELECT |FROM <name>".
  const idx = lower.lastIndexOf('from ');
  if (idx < 0) return null;
  // Make sure no `select` is between this `from` and the cursor that would
  // make it a different statement fragment (we keep this light: the user's
  // intent is unambiguous enough on a single line).
  const after = lower.slice(idx + 'from '.length);
  const ident = after.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)/);
  return ident && ident[1] ? ident[1].toLowerCase() : null;
}

export function provideSqlCompletionsFromText(
  text: string,
  offset: number,
  options: SqlCompletionOptions = {},
): SqlCompletionItem[] {
  // Defensive: callers may pass offset past end of text.
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const prefix = getCurrentPrefix(text, safeOffset);
  const prefixLower = prefix.toLowerCase().replace(/\.$/, '');
  const dotContext = getWordBeforeDot(text, safeOffset);

  const sources = [text, ...(options.extraSources ?? [])];
  const{ tables } = sources.reduce(
    (acc, src) => {
      const scanned = scanSqlSource(src);
      for (const [name, cols] of scanned.tables) {
        if (!acc.tables.has(name)) acc.tables.set(name, cols);
        else if (acc.tables.get(name)?.length === 0 && cols.length > 0) {
          acc.tables.set(name, cols);
        }
      }
      return acc;
    },
    { tables: new Map<string, string[]>() },
  );

  const items: SqlCompletionItem[] = [];

  // 1) Column completions for `tbl.|` member access.
  if (dotContext.afterDot && dotContext.table) {
    const cols = tables.get(dotContext.table) ?? tables.get(dotContext.table.toLowerCase()) ?? [];
    for (const col of cols) {
      if (prefixLower && !col.toLowerCase().startsWith(prefixLower)) continue;
      items.push({
        label: col,
        kind: 4 /* Field */ as SqlCompletionItem['kind'],
        insertText: col,
        detail: `column of ${dotContext.table}`,
      });
    }
    if (items.length > 0) return items;
  }

  // 2) Column completions for `SELECT ... |FROM <tbl>` style.
  // Look at the line up to the cursor; if the immediate preceding token is
  // a comma or the SELECT keyword, surface the last table's columns.
  const lineStart = text.lastIndexOf('\n', safeOffset - 1) + 1;
  const linePrefix = text.slice(lineStart, safeOffset);
  const fromName = endsWithFrom(linePrefix.toLowerCase());
  if (fromName && /\bselect\b/i.test(linePrefix)) {
    const cols = tables.get(fromName) ?? [];
    for (const col of cols) {
      if (prefixLower && !col.toLowerCase().startsWith(prefixLower)) continue;
      items.push({
        label: col,
        kind: 4 as SqlCompletionItem['kind'],
        insertText: col,
        detail: `column of ${fromName}`,
      });
    }
    if (items.length > 0) return items;
  }

  // 3) Reference-based column suggestions for `SELECT ... |`. Without a
  // From clause nearby, fall back to the union of all known columns.
  if (/\bselect\b/i.test(linePrefix) && !/\bfrom\b/i.test(linePrefix)) {
    const seen = new Set<string>();
    for (const cols of tables.values()) {
      for (const col of cols) {
        if (seen.has(col)) continue;
        if (prefixLower && !col.toLowerCase().startsWith(prefixLower)) continue;
        seen.add(col);
        items.push({
          label: col,
          kind: 4 as SqlCompletionItem['kind'],
          insertText: col,
          detail: 'column',
        });
      }
    }
  }

  // 4) Table names.
  for (const name of tables.keys()) {
    if (prefixLower && !name.toLowerCase().startsWith(prefixLower)) continue;
    items.push({
      label: name,
      kind: 9 /* Class */ as SqlCompletionItem['kind'],
      insertText: name,
      detail: 'table',
    });
  }

  // 5) Keywords. Sort by prefix match so more-specific matches float up.
  const keywordItems: SqlCompletionItem[] = [];
  for (const kw of SQL_KEYWORDS) {
    const lower = kw.toLowerCase();
    if (prefixLower && !lower.startsWith(prefixLower) && !lower.includes(' ' + prefixLower)) {
      continue;
    }
    keywordItems.push({
      label: kw,
      kind: 14 /* Keyword */ as SqlCompletionItem['kind'],
      insertText: kw,
      detail: 'keyword',
    });
  }
  // Prefer keywords that start with the typed prefix over looser matches.
  keywordItems.sort((a, b) => {
    const aStarts = (a.label as string).toLowerCase().startsWith(prefixLower) ? 0 : 1;
    const bStarts = (b.label as string).toLowerCase().startsWith(prefixLower) ? 0 : 1;
    return aStarts - bStarts;
  });
  items.push(...keywordItems);

  return items;
}

/**
 * Adapter for `monaco.languages.registerCompletionItemProvider('sql', { provideCompletionItems })`.
 * Reads the model value/offset and delegates to the pure core.
 */
export function provideSqlCompletions(
  model: { getValue: () => string; getOffsetAt: (pos: { lineNumber: number; column: number }) => number },
  position: { lineNumber: number; column: number },
  options: SqlCompletionOptions = {},
): SqlCompletionItem[] {
  const text = model.getValue();
  const offset = model.getOffsetAt(position);
  return provideSqlCompletionsFromText(text, offset, options);
}
