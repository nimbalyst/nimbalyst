/**
 * PG -> SQLite translator unit tests.
 *
 * Covers the patterns the audit catalogued in the migration plan:
 *   - positional params -> named binds
 *   - NOW() and NOW() +/- INTERVAL
 *   - PG type casts
 *   - jsonb_set with literal paths
 *   - to_jsonb wrapping (and nested wrappers)
 *   - ANY($N) array expansion (including empty arrays and ::text[] casts)
 *   - jsonb_build_object -> json_object
 */

import { describe, expect, it } from 'vitest';
import { translateSql, bindParams, translateAndBind } from '../dialectTranslator';

describe('translateSql - positional params', () => {
  it('translates $1, $2 to $p1, $p2', () => {
    const r = translateSql('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(r.sql).toBe('SELECT * FROM t WHERE a = $p1 AND b = $p2');
  });

  it('preserves PG semantics where same $N appears multiple times', () => {
    const r = translateSql('SELECT $1 AS a, $1 AS b WHERE $2 = $1');
    expect(r.sql).toBe('SELECT $p1 AS a, $p1 AS b WHERE $p2 = $p1');
  });

  it('handles double-digit param numbers', () => {
    const r = translateSql('SELECT * FROM t WHERE x = $10 AND y = $11');
    expect(r.sql).toBe('SELECT * FROM t WHERE x = $p10 AND y = $p11');
  });
});

describe('translateSql - NOW()', () => {
  it('translates bare NOW() to strftime ISO-8601 UTC', () => {
    const r = translateSql('SELECT NOW() AS ts');
    expect(r.sql).toBe("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS ts");
  });

  it('translates NOW() - INTERVAL "N units" to strftime with modifier', () => {
    const r = translateSql("SELECT * FROM t WHERE created_at < NOW() - INTERVAL '1 day'");
    expect(r.sql).toBe(
      "SELECT * FROM t WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')",
    );
  });

  it('translates NOW() + INTERVAL with positive modifier', () => {
    const r = translateSql("SELECT NOW() + INTERVAL '30 minutes'");
    expect(r.sql).toBe("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 minutes')");
  });

  it('is case-insensitive', () => {
    const r = translateSql('SELECT now()');
    expect(r.sql).toBe("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  });

  it('translates EXTRACT(EPOCH FROM expr) * 1000 using the captured expression', () => {
    const r = translateSql(
      'SELECT EXTRACT(EPOCH FROM s.last_read_timestamp) * 1000 AS last_read_ms FROM ai_sessions s',
    );
    expect(r.sql).toContain(
      "CAST(round(unixepoch(s.last_read_timestamp, 'subsec') * 1000) AS INTEGER) AS last_read_ms",
    );
  });
});

describe('translateSql - type casts', () => {
  it('strips ::text from string literal cast', () => {
    const r = translateSql("SELECT 'reviewed'::text");
    expect(r.sql).toBe("SELECT 'reviewed'");
  });

  it('strips $1::bigint cast', () => {
    const r = translateSql('UPDATE t SET x = $1::bigint');
    expect(r.sql).toBe('UPDATE t SET x = $p1');
  });

  it('strips ::jsonb cast', () => {
    const r = translateSql("SELECT '{}'::jsonb");
    expect(r.sql).toBe("SELECT '{}'");
  });

  it('handles array casts in ANY first, then drops them', () => {
    const r = translateSql('SELECT * FROM t WHERE id = ANY($1::text[])');
    expect(r.sql).toContain('IN (');
    expect(r.sql).not.toContain('::');
  });
});

describe('translateSql - to_jsonb wrappers', () => {
  it('strips a simple to_jsonb($1::text) wrapper', () => {
    const r = translateSql("SELECT to_jsonb($1::text)");
    expect(r.sql).toBe('SELECT $p1');
  });

  it('strips nested wrappers inside jsonb_set', () => {
    const r = translateSql(
      "UPDATE t SET metadata = jsonb_set(metadata, '{status}', to_jsonb($1::text))",
    );
    expect(r.sql).toBe("UPDATE t SET metadata = json_set(metadata, '$.status', $p1)");
  });

  it('handles multiple to_jsonb wrappers in one statement', () => {
    const r = translateSql(
      "UPDATE t SET m = jsonb_set(jsonb_set(m, '{a}', to_jsonb($1::text)), '{b}', to_jsonb($2::bigint))",
    );
    expect(r.sql).toBe(
      "UPDATE t SET m = json_set(json_set(m, '$.a', $p1), '$.b', $p2)",
    );
  });
});

describe('translateSql - jsonb_set with literal paths', () => {
  it('translates a single-segment path', () => {
    const r = translateSql(
      "UPDATE t SET m = jsonb_set(m, '{status}', '\"reviewed\"')",
    );
    expect(r.sql).toBe(
      "UPDATE t SET m = json_set(m, '$.status', '\"reviewed\"')",
    );
  });

  it('translates a nested path', () => {
    const r = translateSql(
      "UPDATE t SET m = jsonb_set(m, '{a,b,c}', '1')",
    );
    expect(r.sql).toBe(
      "UPDATE t SET m = json_set(m, '$.a.b.c', '1')",
    );
  });
});

describe('translateSql - ANY array expansion', () => {
  it('emits an IN-list sentinel and records the param index', () => {
    const r = translateSql('SELECT * FROM t WHERE id = ANY($1)');
    expect(r.expandsAnyParam).toBe(true);
    expect(r.anyParamIndices).toEqual([1]);
    expect(r.sql).toContain('IN (/*ANY:1*/)');
  });

  it('handles ANY($N::text[]) with array cast', () => {
    const r = translateSql('SELECT * FROM t WHERE id = ANY($1::text[])');
    expect(r.expandsAnyParam).toBe(true);
    expect(r.anyParamIndices).toEqual([1]);
  });

  it('records multiple ANY params', () => {
    const r = translateSql(
      'SELECT * FROM t WHERE a = ANY($1) AND b = ANY($2::int[])',
    );
    expect(r.anyParamIndices).toEqual([1, 2]);
  });
});

describe('translateSql - jsonb_build_object', () => {
  it('renames to json_object', () => {
    const r = translateSql(
      "INSERT INTO t (m) VALUES (jsonb_build_object('a', 1, 'b', $1))",
    );
    expect(r.sql).toBe(
      "INSERT INTO t (m) VALUES (json_object('a', 1, 'b', $p1))",
    );
  });
});

describe('bindParams', () => {
  it('returns named binds for non-ANY params', () => {
    const t = translateSql('SELECT * FROM t WHERE a = $1 AND b = $2');
    const { sql, binds } = bindParams(t, ['x', 42]);
    expect(sql).toBe('SELECT * FROM t WHERE a = $p1 AND b = $p2');
    expect(binds).toEqual({ p1: 'x', p2: 42 });
  });

  it('expands ANY with placeholder list and splats values', () => {
    const t = translateSql('SELECT * FROM t WHERE id = ANY($1)');
    const { sql, binds } = bindParams(t, [['a', 'b', 'c']]);
    expect(sql).toBe('SELECT * FROM t WHERE id  IN ($p1_0, $p1_1, $p1_2)');
    expect(binds).toEqual({ p1_0: 'a', p1_1: 'b', p1_2: 'c' });
  });

  it('handles empty array in ANY by emitting an always-false IN list', () => {
    const t = translateSql('DELETE FROM t WHERE id = ANY($1)');
    const { sql, binds } = bindParams(t, [[]]);
    // Empty IN list is illegal in SQL; we substitute a tautology that
    // matches nothing so the statement is valid and a no-op.
    expect(sql).toContain('SELECT NULL WHERE 0');
    expect(binds).toEqual({});
  });

  it('mixes ANY and ordinary params in the right order', () => {
    const t = translateSql(
      'SELECT * FROM t WHERE workspace = $1 AND id = ANY($2)',
    );
    const { sql, binds } = bindParams(t, ['workspace-xyz', ['a', 'b']]);
    expect(sql).toBe(
      'SELECT * FROM t WHERE workspace = $p1 AND id  IN ($p2_0, $p2_1)',
    );
    expect(binds).toEqual({ p1: 'workspace-xyz', p2_0: 'a', p2_1: 'b' });
  });

  it('handles ANY(:n) with a single scalar by wrapping in IN(scalar)', () => {
    const t = translateSql('SELECT * FROM t WHERE id = ANY($1)');
    const { sql, binds } = bindParams(t, ['single-id']);
    expect(sql).toContain('IN ($p1_0)');
    expect(binds).toEqual({ p1_0: 'single-id' });
  });
});

describe('translateSql - GREATEST / LEAST', () => {
  it('rewrites GREATEST(a, b) into COALESCE(max(a,b), a, b)', () => {
    const r = translateSql('SELECT GREATEST(x, y) FROM t');
    expect(r.sql).toBe('SELECT COALESCE(max(x, y), x, y) FROM t');
  });

  it('rewrites LEAST(a, b) into COALESCE(min(a,b), a, b)', () => {
    const r = translateSql('SELECT LEAST(x, 0) AS clamped FROM t');
    expect(r.sql).toBe('SELECT COALESCE(min(x, 0), x, 0) AS clamped FROM t');
  });

  it('handles GREATEST with a nested COALESCE arg', () => {
    const r = translateSql(
      'SELECT GREATEST(s.updated_at, COALESCE(child.max, s.updated_at)) FROM t s',
    );
    expect(r.sql).toContain('COALESCE(max(s.updated_at, COALESCE(child.max, s.updated_at)), s.updated_at, COALESCE(child.max, s.updated_at))');
  });
});

describe('translateSql - jsonb concat (||) with positional params', () => {
  it('rewrites col || $N into json_patch even before $N -> $pN rewrite', () => {
    const r = translateSql(
      "UPDATE tracker_items SET data = tracker_items.data || $3 WHERE id = $1",
    );
    expect(r.sql).toContain('json_patch(tracker_items.data, $p3)');
    expect(r.sql).not.toMatch(/data\s*\|\|/);
  });

  // Regression: TrackerPGLiteStore.applyOptimistic uses
  // `expr || jsonb_strip_nulls(jsonb_build_object(...))` to preserve
  // device-local data keys across optimistic rewrites. The right operand
  // is a two-level nested function call. An earlier rewrite regex only
  // allowed one paren level inside each function-call alternative, so it
  // backed off to the bare-identifier alternative and matched just
  // `jsonb_strip_nulls`, leaving `(json_object(...))` dangling and
  // producing invalid SQL like `json_patch(left, jsonb_strip_nulls)(...)`.
  // Better-sqlite3 surfaced this as "near '(': syntax error".
  it('rewrites col - key || jsonb_strip_nulls(json_object(...)) safely', () => {
    const r = translateSql(
      `(EXCLUDED.data - 'linkedSessions' || jsonb_strip_nulls(jsonb_build_object('linkedSessions', tracker_items.data->'linkedSessions')))`,
    );
    expect(r.sql).toBe(
      `(json_patch(json_remove(EXCLUDED.data, '$.linkedSessions'), jsonb_strip_nulls(json_object('linkedSessions', tracker_items.data->'linkedSessions'))))`,
    );
  });
});

describe('translateSql - param-free statements', () => {
  it('still rewrites NOW() - INTERVAL when there are no $N params', () => {
    const r = translateSql(
      "UPDATE queued_prompts SET status = 'completed' WHERE created_at < NOW() - INTERVAL '1 day'",
    );
    expect(r.sql).toContain("strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')");
    expect(r.sql).not.toContain("'1 day'");
  });
});

describe('translateAndBind - integration', () => {
  it('round-trips a realistic UPDATE with NOW() and casts', () => {
    const { sql, binds } = translateAndBind(
      `UPDATE ai_sessions
       SET metadata = jsonb_set(metadata, '{status}', to_jsonb($1::text)),
           updated_at = NOW()
       WHERE id = $2`,
      ['reviewed', 'session-123'],
    );
    expect(sql).toContain("json_set(metadata, '$.status', $p1)");
    expect(sql).toContain("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    expect(sql).toContain('WHERE id = $p2');
    expect(binds).toEqual({ p1: 'reviewed', p2: 'session-123' });
  });

  it('round-trips a SELECT with ANY and INTERVAL', () => {
    const { sql, binds } = translateAndBind(
      `SELECT * FROM queued_prompts
       WHERE status = $1 AND session_id = ANY($2::text[])
         AND created_at < NOW() - INTERVAL '1 day'`,
      ['pending', ['s1', 's2']],
    );
    expect(sql).toContain('status = $p1');
    expect(sql).toContain('session_id  IN ($p2_0, $p2_1)');
    expect(sql).toContain("strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')");
    expect(binds).toEqual({ p1: 'pending', p2_0: 's1', p2_1: 's2' });
  });
});
