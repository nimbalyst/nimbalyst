import { describe, it, expect } from 'vitest';
import {
  reclaimClaudeCodeRawLog,
  previewReclaimClaudeCodeRawLog,
} from '../reclaimClaudeCodeRawLog';

/**
 * Minimal fake of the AppDatabase.query surface the reclaim pass uses:
 * the batched candidate SELECT, the per-row UPDATE, the COUNT preview, and VACUUM.
 */
function makeFakeDb(rows: Array<{ id: number; content: string }>) {
  const store = new Map(rows.map((r) => [r.id, r.content]));
  let vacuumCount = 0;
  const isCandidate = (c: string) => c.includes('"tool_use_result":') || c.includes('"signature":"');

  const db: any = {
    async query(sql: string, params: unknown[] = []) {
      const s = sql.trim();
      if (s.startsWith('SELECT COUNT(*)')) {
        const n = [...store.values()].filter(isCandidate).length;
        return { rows: [{ n }] };
      }
      if (s.startsWith('SELECT id, content')) {
        const [lastId, limit] = params as [number, number];
        const matching = [...store.entries()]
          .filter(([id, c]) => id > lastId && isCandidate(c))
          .sort((a, b) => a[0] - b[0])
          .slice(0, limit)
          .map(([id, content]) => ({ id, content }));
        return { rows: matching };
      }
      if (s.startsWith('UPDATE')) {
        const [content, id] = params as [string, number];
        store.set(id, content);
        return { rows: [] };
      }
      if (s.startsWith('VACUUM')) {
        vacuumCount++;
        return { rows: [] };
      }
      throw new Error(`unexpected sql: ${s}`);
    },
  };
  return { db, store, vacuumCount: () => vacuumCount };
}

const bloated = (id: number) =>
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: `t${id}`, content: 'The file was updated' }] },
    uuid: `u${id}`,
    tool_use_result: { filePath: '/a/File.tsx', originalFile: 'z'.repeat(20000), structuredPatch: [{ a: 1 }] },
  });

const clean = (id: number) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `hi ${id}` }] }, uuid: `u${id}` });

describe('reclaimClaudeCodeRawLog', () => {
  it('rewrites bloated rows, leaves clean rows, and counts bytes saved', async () => {
    const { db, store } = makeFakeDb([
      { id: 1, content: bloated(1) },
      { id: 2, content: clean(2) },
      { id: 3, content: bloated(3) },
    ]);

    const result = await reclaimClaudeCodeRawLog(db, { vacuum: false });

    expect(result.rewritten).toBe(2);
    expect(result.bytesSaved).toBeGreaterThan(30000);
    // Bloated rows lost originalFile but kept filePath + the message.
    const r1 = JSON.parse(store.get(1)!);
    expect(r1.tool_use_result).toEqual({ filePath: '/a/File.tsx' });
    expect(r1.message.content[0].content).toBe('The file was updated');
    // Clean row untouched.
    expect(store.get(2)).toBe(clean(2));
  });

  it('is idempotent: a second run rewrites nothing', async () => {
    const { db } = makeFakeDb([{ id: 1, content: bloated(1) }]);
    await reclaimClaudeCodeRawLog(db, { vacuum: false });
    const second = await reclaimClaudeCodeRawLog(db, { vacuum: false });
    expect(second.rewritten).toBe(0);
  });

  it('runs VACUUM only when requested', async () => {
    const a = makeFakeDb([{ id: 1, content: bloated(1) }]);
    const ra = await reclaimClaudeCodeRawLog(a.db, { vacuum: true });
    expect(ra.vacuumed).toBe(true);
    expect(a.vacuumCount()).toBe(1);

    const b = makeFakeDb([{ id: 1, content: bloated(1) }]);
    const rb = await reclaimClaudeCodeRawLog(b.db, { vacuum: false });
    expect(rb.vacuumed).toBe(false);
    expect(b.vacuumCount()).toBe(0);
  });

  it('preview counts candidate rows', async () => {
    const { db } = makeFakeDb([
      { id: 1, content: bloated(1) },
      { id: 2, content: clean(2) },
    ]);
    expect(await previewReclaimClaudeCodeRawLog(db)).toEqual({ candidateRows: 1 });
  });
});
