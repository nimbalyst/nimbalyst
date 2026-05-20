import { describe, expect, it, vi } from 'vitest';
import { createPGLiteQueuedPromptsStore } from '../PGLiteQueuedPromptsStore';

type DbStub = { query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }> };

describe('PGLiteQueuedPromptsStore.rollbackExecuting', () => {
  it('resets executing rows for the given session back to pending', async () => {
    const query = vi.fn(async (sql: string, params?: any[]) => {
      expect(sql).toContain("SET status = 'pending'");
      expect(sql).toContain('claimed_at = NULL');
      expect(sql).toContain("status = 'executing'");
      expect(sql).toContain('WHERE session_id = $1');
      expect(params).toEqual(['session-abc']);
      return { rows: [{ id: 'prompt-1' }, { id: 'prompt-2' }] };
    });
    const db: DbStub = { query: query as any };

    const store = createPGLiteQueuedPromptsStore(db);
    const rolledBack = await store.rollbackExecuting('session-abc');

    expect(rolledBack).toBe(2);
    expect(query).toHaveBeenCalledOnce();
  });

  it('returns 0 when no rows are stuck in executing', async () => {
    const db: DbStub = { query: (async () => ({ rows: [] })) as any };

    const store = createPGLiteQueuedPromptsStore(db);
    const rolledBack = await store.rollbackExecuting('session-no-rows');

    expect(rolledBack).toBe(0);
  });

  it('is scoped to the given session id only', async () => {
    let capturedParams: any[] | undefined;
    const db: DbStub = {
      query: (async (_sql: string, params?: any[]) => {
        capturedParams = params;
        return { rows: [] };
      }) as any,
    };

    const store = createPGLiteQueuedPromptsStore(db);
    await store.rollbackExecuting('session-only-this-one');

    expect(capturedParams).toEqual(['session-only-this-one']);
  });
});

describe('PGLiteQueuedPromptsStore.rollbackAllExecuting', () => {
  it('resets every executing row across all sessions', async () => {
    const query = vi.fn(async (sql: string, params?: any[]) => {
      expect(sql).toContain("SET status = 'pending'");
      expect(sql).toContain('claimed_at = NULL');
      expect(sql).toContain("status = 'executing'");
      expect(sql).not.toContain('session_id');
      expect(params).toBeUndefined();
      return { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
    });
    const db: DbStub = { query: query as any };

    const store = createPGLiteQueuedPromptsStore(db);
    const rolledBack = await store.rollbackAllExecuting();

    expect(rolledBack).toBe(3);
  });

  it('is idempotent when the table has no stuck rows', async () => {
    const db: DbStub = { query: (async () => ({ rows: [] })) as any };

    const store = createPGLiteQueuedPromptsStore(db);
    expect(await store.rollbackAllExecuting()).toBe(0);
    expect(await store.rollbackAllExecuting()).toBe(0);
  });
});
