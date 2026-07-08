/**
 * PG -> SQLite SQL dialect translator.
 *
 * Mechanical rewrite of the common subset of PGLite SQL used by Nimbalyst's
 * stores into better-sqlite3-compatible SQL. Designed to keep the existing
 * PGLite store code unchanged while still working against SQLite.
 *
 * What we handle:
 *   - Positional params: `$1, $2, ...` -> named binds `$p1, $p2, ...`
 *     (better-sqlite3 accepts `$name` natively; named binds preserve the
 *     PG semantics of "same number, same param, even when referenced twice")
 *   - `NOW()` -> `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` (ISO-8601 UTC string,
 *     matching how the rest of the codebase stores TIMESTAMPTZ values)
 *   - PG type casts: `'literal'::text`, `$1::text`, `$1::bigint`,
 *     `$1::jsonb` etc -> stripped. SQLite uses dynamic typing.
 *   - `to_jsonb(x)` -> bare `x` (json_set & friends accept raw scalars and
 *     produce the same in-JSON encoding as `to_jsonb` did).
 *   - `jsonb_set(col, '{a,b}', value)` -> `json_set(col, '$.a.b', value)`
 *     for literal path arrays.
 *   - `jsonb_build_object(...)` -> `json_object(...)`.
 *   - `jsonb_strip_nulls(x)` -> a wrap that requires the bound value to be
 *     pre-stripped (logged at translate time; see note below).
 *   - `col = ANY($N)` / `col = ANY($N::text[])` -> `col IN (...?)` with
 *     param expansion done by `translateAndBindParams`.
 *   - `INTERVAL 'N units'` arithmetic on timestamps: `NOW() - INTERVAL '1 day'`
 *     -> `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`.
 *   - `TRUE` / `FALSE` left untouched (SQLite >= 3.23 accepts as aliases for 1/0).
 *   - `RETURNING *`, `ON CONFLICT ... DO NOTHING/UPDATE` left untouched
 *     (supported by SQLite >= 3.35 / >= 3.24).
 *
 * What we do NOT handle (must be addressed at the callsite via explicit
 * dbAdapter helpers, NOT by this translator):
 *   - FTS: `to_tsvector / @@ / plainto_tsquery / ts_rank_cd`. Stores must
 *     call dedicated `searchSessions` / `searchTranscriptEvents` helpers.
 *   - `jsonb_array_elements_text` (lateral join). Use `json_each` directly.
 *   - `EXTRACT(... FROM ts + INTERVAL ...)` for timezone math. Reshape in JS.
 *
 * If the translator sees an unsupported construct it leaves it alone; the
 * statement will then fail at the engine, which is the correct loud failure
 * (not silent data corruption).
 */

const ANY_ARRAY_RE = /=\s*ANY\s*\(\s*(\$\d+)\s*(?:::\s*[a-z_][a-z0-9_]*\s*\[\s*\]\s*)?\)/gi;
const TYPE_CAST_RE = /::\s*[a-z_][a-z0-9_]*(?:\s*\[\s*\])?/gi;
const NOW_PLAIN_RE = /\bNOW\s*\(\s*\)/gi;
const CURRENT_TIMESTAMP_RE = /\bCURRENT_TIMESTAMP\b/gi;
const TO_JSONB_RE = /\bto_jsonb\s*\(/gi;
const JSONB_BUILD_OBJECT_RE = /\bjsonb_build_object\s*\(/gi;
const JSONB_SET_HEAD_RE = /\bjsonb_set\s*\(/gi;
const NOW_MINUS_INTERVAL_RE = /\bNOW\s*\(\s*\)\s*-\s*INTERVAL\s*'([^']+)'/gi;
const NOW_PLUS_INTERVAL_RE = /\bNOW\s*\(\s*\)\s*\+\s*INTERVAL\s*'([^']+)'/gi;
const EXTRACT_EPOCH_MS_RE = /EXTRACT\s*\(\s*EPOCH\s+FROM\s+([^)]+?)\s*\)\s*\*\s*1000/gi;
const POSITIONAL_PARAM_RE = /\$(\d+)/g;

export interface TranslateResult {
  sql: string;
  /**
   * If true, the original params array must be transformed via
   * `expandParamsForAny()` because at least one `ANY(...)` was expanded.
   */
  expandsAnyParam: boolean;
  /**
   * The set of positional param indices that were expanded as ANY(...).
   * One-based, matching the original `$N` numbering.
   */
  anyParamIndices: number[];
}

/**
 * Translate a PG-flavored SQL string into better-sqlite3-compatible SQL.
 * The result still uses `$pN` named binds; pair with `bindParams()` to
 * produce the object that better-sqlite3's `Statement#all/run` expects.
 */
export function translateSql(sql: string): TranslateResult {
  let out = sql;
  const anyParamIndices: number[] = [];

  // Step 1: `col = ANY($N)` patterns. We replace with a sentinel that
  // `bindParams()` later expands into `IN (?, ?, ?)` based on the array
  // length. We emit the sentinel as a comment-delimited string the caller
  // can find.
  //
  // To stay simple and avoid SQL injection edges, we substitute a marker
  // that includes the original param number; expandParamsForAny() walks
  // the markers and stitches the IN list using $pN_0, $pN_1, ... binds.
  out = out.replace(ANY_ARRAY_RE, (_match, dollar) => {
    const n = Number((dollar as string).slice(1));
    anyParamIndices.push(n);
    return ` IN (/*ANY:${n}*/)`;
  });

  // Step 2: NOW() arithmetic with INTERVAL.
  out = out.replace(NOW_MINUS_INTERVAL_RE, (_m, span: string) => {
    return `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${negateInterval(span)}')`;
  });
  out = out.replace(NOW_PLUS_INTERVAL_RE, (_m, span: string) => {
    return `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${span.trim()}')`;
  });

  // Step 3: bare NOW() -> ISO-8601 UTC string.
  out = out.replace(NOW_PLAIN_RE, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  out = out.replace(CURRENT_TIMESTAMP_RE, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  out = out.replace(
    EXTRACT_EPOCH_MS_RE,
    (_m, expr: string) => `CAST(round(unixepoch(${expr.trim()}, 'subsec') * 1000) AS INTEGER)`,
  );

  // Step 4: jsonb_set(col, '{a,b}', value) -> json_set(col, '$.a.b', value).
  // Paren-aware so nested calls (jsonb_set(jsonb_set(...), ...)) translate
  // correctly. We iterate from innermost out by repeatedly scanning until no
  // more matches are found.
  out = rewriteJsonbSet(out);

  // Step 5: jsonb_build_object(...) -> json_object(...). to_jsonb(x) -> x.
  out = out.replace(JSONB_BUILD_OBJECT_RE, 'json_object(');
  out = stripToJsonbWrappers(out);
  out = rewriteJsonDeletes(out);
  out = rewriteJsonConcats(out);
  out = rewriteGreatestLeast(out);

  // Step 6: drop PG type casts (::text, ::jsonb, ::bigint, ::text[] etc).
  // Done after the ANY/cast handling so the array-cast inside ANY() has
  // already been peeled off.
  out = out.replace(TYPE_CAST_RE, '');

  // Step 7: positional params `$N` -> named `$pN`. better-sqlite3 supports
  // named binds with `$name`; this preserves PG's "reference same param N
  // times, bind it once" semantics.
  out = out.replace(POSITIONAL_PARAM_RE, (_m, digits: string) => `$p${digits}`);

  return {
    sql: out,
    expandsAnyParam: anyParamIndices.length > 0,
    anyParamIndices: dedupe(anyParamIndices),
  };
}

/**
 * Given the translator output and the original positional params (as PG
 * stores pass them, 0-indexed in JS), produce a `{p1: x, p2: y, ...}` bind
 * object for better-sqlite3.
 *
 * If the translation expanded `ANY(...)` patterns, also rewrites the SQL
 * IN-list comments into real `($p3_0, $p3_1, ...)` placeholder lists and
 * splats the array params into the bind object.
 */
export function bindParams(
  translation: TranslateResult,
  params: ReadonlyArray<unknown>,
): { sql: string; binds: Record<string, unknown> } {
  let sql = translation.sql;
  const binds: Record<string, unknown> = {};

  // Walk each param. ANY-expanded params get expanded into placeholder lists.
  for (let i = 0; i < params.length; i++) {
    const n = i + 1;
    const isAny = translation.anyParamIndices.includes(n);
    const value = params[i];
    if (isAny) {
      const arr = Array.isArray(value) ? value : [value];
      if (arr.length === 0) {
        // Empty IN list. SQLite rejects `IN ()`. Substitute a tautology that
        // always evaluates to false so the SQL is valid.
        sql = sql.replace(`/*ANY:${n}*/`, 'SELECT NULL WHERE 0');
        continue;
      }
      const placeholders: string[] = [];
      for (let j = 0; j < arr.length; j++) {
        const key = `p${n}_${j}`;
        placeholders.push(`$${key}`);
        binds[key] = arr[j];
      }
      sql = sql.replace(`/*ANY:${n}*/`, placeholders.join(', '));
    } else {
      binds[`p${n}`] = value;
    }
  }

  return { sql, binds };
}

/**
 * Convenience: translate + bind in one call.
 */
export function translateAndBind(
  sql: string,
  params: ReadonlyArray<unknown> = [],
): { sql: string; binds: Record<string, unknown> } {
  const t = translateSql(sql);
  return bindParams(t, params);
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

/**
 * Rewrite all `jsonb_set(col, '{a,b,c}', value)` calls into
 * `json_set(col, '$.a.b.c', value)`. Paren-aware: handles nested
 * jsonb_set / to_jsonb / json_object arguments correctly.
 *
 * We walk top-down repeatedly until no more matches are found, which
 * naturally handles the nested case (after the outer rewrite there's no
 * "jsonb_set" left in the head position; the inner ones get rewritten
 * on subsequent passes through the loop).
 */
function rewriteJsonbSet(sql: string): string {
  let out = sql;
  // Loop a bounded number of times to keep us safe from a pathological input.
  for (let iter = 0; iter < 64; iter++) {
    JSONB_SET_HEAD_RE.lastIndex = 0;
    const m = JSONB_SET_HEAD_RE.exec(out);
    if (!m) return out;
    const openParenIdx = m.index + m[0].length - 1;
    const closeParenIdx = findMatchingParen(out, openParenIdx);
    if (closeParenIdx < 0) return out;
    const inner = out.slice(openParenIdx + 1, closeParenIdx);
    // Split into three args at the two commas at depth 0.
    const args = splitTopLevelArgs(inner);
    if (args.length < 3) {
      // Malformed; bail to avoid an infinite loop.
      return out;
    }
    const [colExpr, pathLit, ...rest] = args;
    const valueExpr = rest.join(','); // jsonb_set is always 3-arg but be defensive.
    const pathMatch = /^\s*'\{([^}]*)\}'\s*$/.exec(pathLit);
    if (!pathMatch) {
      // The path arg isn't a literal {a,b} array - leave the call alone and
      // walk past it by replacing the keyword with a sentinel, then undoing
      // after the loop.
      out =
        out.slice(0, m.index) +
        '__JSONB_SET_KEEP__' +
        out.slice(m.index + 'jsonb_set'.length);
      continue;
    }
    const path = '$' + pathMatch[1].split(',').map((p) => '.' + p.trim()).join('');
    const replacement = `json_set(${colExpr.trim()}, '${path}', ${valueExpr.trim()})`;
    out = out.slice(0, m.index) + replacement + out.slice(closeParenIdx + 1);
  }
  // Restore any "keep" sentinels we used to step past non-literal-path calls.
  return out.replace(/__JSONB_SET_KEEP__/g, 'jsonb_set');
}

/**
 * Split a comma-separated arg list, respecting parens and string literals.
 */
function splitTopLevelArgs(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      buf += c;
      if (c === inString) {
        if (s[i + 1] === inString) {
          buf += s[++i];
          continue;
        }
        inString = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      inString = c;
      buf += c;
      continue;
    }
    if (c === '(') {
      depth++;
      buf += c;
      continue;
    }
    if (c === ')') {
      depth--;
      buf += c;
      continue;
    }
    if (c === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

/**
 * Strip `to_jsonb(...)` wrappers by finding the matching paren and removing
 * both. Done via a stateful scan because nested parens make regex unreliable.
 */
function stripToJsonbWrappers(sql: string): string {
  let out = sql;
  while (true) {
    const m = TO_JSONB_RE.exec(out);
    TO_JSONB_RE.lastIndex = 0;
    if (!m) return out;
    const openParenIdx = m.index + m[0].length - 1; // position of the '('
    const matchEnd = findMatchingParen(out, openParenIdx);
    if (matchEnd < 0) return out;
    // Replace `to_jsonb(<inner>)` with `<inner>`.
    const inner = out.slice(openParenIdx + 1, matchEnd);
    out = out.slice(0, m.index) + inner + out.slice(matchEnd + 1);
  }
}

function findMatchingParen(s: string, openIdx: number): number {
  if (s[openIdx] !== '(') return -1;
  let depth = 1;
  let inString: string | null = null;
  for (let i = openIdx + 1; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === inString) {
        // Handle SQL '' escape inside string.
        if (s[i + 1] === inString) {
          i++;
          continue;
        }
        inString = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      inString = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Turn an INTERVAL span like "7 days" into the SQLite modifier "-7 days".
 * SQLite accepts plural / singular interchangeably.
 */
function negateInterval(span: string): string {
  const trimmed = span.trim();
  if (trimmed.startsWith('-')) return trimmed.slice(1);
  return '-' + trimmed;
}

function rewriteJsonDeletes(sql: string): string {
  let out = sql;
  const deletePattern = /(\([^()]+\)|json_remove\([^()]+\)|COALESCE\([^()]+\)|[a-zA-Z_][a-zA-Z0-9_\.]*)\s*-\s*'([^']+)'/g;
  for (let iter = 0; iter < 32; iter++) {
    const next = out.replace(
      deletePattern,
      (_match, expr: string, key: string) => `json_remove(${expr.trim()}, '$.${key}')`,
    );
    if (next === out) {
      return out;
    }
    out = next;
  }
  return out;
}

/**
 * Translate PG's `GREATEST(a, b, ...)` / `LEAST(a, b, ...)` (which ignore
 * NULL args) into SQLite. SQLite's scalar `max(a,b,...)` / `min(...)` exist
 * but propagate NULL when any arg is null. Wrap in COALESCE so that when
 * max/min returns NULL we fall back to the first non-null original arg —
 * matching PG's "ignore nulls" semantics.
 *
 * Paren-aware; iterates innermost-out via the same scan-and-replace loop
 * shape as `rewriteJsonbSet`. Handles any number of args.
 */
function rewriteGreatestLeast(sql: string): string {
  const HEAD_RE = /\b(GREATEST|LEAST)\s*\(/gi;
  let out = sql;
  for (let iter = 0; iter < 64; iter++) {
    HEAD_RE.lastIndex = 0;
    const m = HEAD_RE.exec(out);
    if (!m) return out;
    const fn = m[1].toUpperCase() === 'LEAST' ? 'min' : 'max';
    const openParenIdx = m.index + m[0].length - 1;
    const closeParenIdx = findMatchingParen(out, openParenIdx);
    if (closeParenIdx < 0) return out;
    const inner = out.slice(openParenIdx + 1, closeParenIdx);
    const args = splitTopLevelArgs(inner).map((a) => a.trim());
    if (args.length < 2) {
      // Single-arg or malformed; leave alone via a sentinel pass-through
      // to avoid re-matching this site forever.
      out =
        out.slice(0, m.index) +
        `__${fn === 'min' ? 'LEAST' : 'GREATEST'}_KEEP__` +
        out.slice(m.index + m[1].length);
      continue;
    }
    const replacement = `COALESCE(${fn}(${args.join(', ')}), ${args.join(', ')})`;
    out = out.slice(0, m.index) + replacement + out.slice(closeParenIdx + 1);
  }
  return out
    .replace(/__GREATEST_KEEP__/g, 'GREATEST')
    .replace(/__LEAST_KEEP__/g, 'LEAST');
}

function rewriteJsonConcats(sql: string): string {
  let out = sql;
  // Right side accepts `$N` and `$pN` because this rewrite runs before the
  // `$N` -> `$pN` step. Left side accepts the same so symmetric `$1 || $2`
  // patterns also translate.
  //
  // Each function-call alternative uses NESTED_PAREN_BODY, which matches a
  // function body with up to ONE level of inner parens (e.g.
  // `jsonb_strip_nulls(json_object('a', x))`). The previous `[^()]+` form
  // refused any nested parens, so the regex backed off to the bare-identifier
  // alternative — matching just `jsonb_strip_nulls` and leaving the
  // `(json_object(...))` afterwards as dangling text, which produced invalid
  // SQL like `json_patch(left, jsonb_strip_nulls)(json_object(...))`.
  // The bare-identifier alternative now uses a negative lookahead so a name
  // followed by `(` only matches via the function-call branches above it.
  const NESTED_PAREN_BODY = String.raw`\([^()]*(?:\([^()]*\)[^()]*)*\)`;
  // A balanced parenthesized group up to three levels deep. The previous
  // `\([^()]+\)` only matched a single level, so a left operand like
  // `(json_remove(COALESCE(metadata, '{}'), '$.k'))` — produced when a
  // `(col - 'k') || $1` subtract-then-merge is rewritten — was not recognized
  // as an operand. The `||` then stayed as SQLite *string concatenation*,
  // silently corrupting jsonb into e.g. `{...}{}` (NIM-829). Three levels
  // covers every jsonb operator expression the stores emit.
  const PAREN_L1 = String.raw`\([^()]*\)`;
  const PAREN_L2 = String.raw`\((?:[^()]|${PAREN_L1})*\)`;
  const PAREN_L3 = String.raw`\((?:[^()]|${PAREN_L2})*\)`;
  const OPERAND = String.raw`(?:` +
    `${PAREN_L3}|` +
    `json_remove${NESTED_PAREN_BODY}|` +
    `json_patch${NESTED_PAREN_BODY}|` +
    `jsonb_strip_nulls${NESTED_PAREN_BODY}|` +
    `json_object${NESTED_PAREN_BODY}|` +
    `COALESCE${NESTED_PAREN_BODY}|` +
    String.raw`\$p?\d+|` +
    String.raw`[a-zA-Z_][a-zA-Z0-9_\.]*(?!\s*\()` +
    String.raw`)`;
  const concatPattern = new RegExp(`(${OPERAND})\\s*\\|\\|\\s*(${OPERAND})`, 'g');
  for (let iter = 0; iter < 32; iter++) {
    const next = out.replace(
      concatPattern,
      (_match, left: string, right: string) => `json_patch(${left.trim()}, ${right.trim()})`,
    );
    if (next === out) {
      return out;
    }
    out = next;
  }
  return out;
}
