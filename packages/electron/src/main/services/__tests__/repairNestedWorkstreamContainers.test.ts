import { describe, expect, it, vi } from 'vitest';
import { repairNestedWorkstreamContainers } from '../repairNestedWorkstreamContainers';

describe('repairNestedWorkstreamContainers', () => {
  it('unparents only invalid typed containers through the normal metadata writer', async () => {
    const sql: string[] = [];
    const db = {
      query: vi.fn(async (query: string) => {
        sql.push(query);
        return { rows: [{ id: 'nested-a' }, { id: 'nested-b' }] };
      }),
    };
    const updateMetadata = vi.fn(async () => undefined);

    const result = await repairNestedWorkstreamContainers(db as any, updateMetadata);

    expect(result).toEqual({ repaired: 2 });
    expect(updateMetadata.mock.calls).toEqual([
      ['nested-a', { parentSessionId: null }],
      ['nested-b', { parentSessionId: null }],
    ]);
    expect(sql.join('\n')).toMatch(/session_type = 'workstream'/i);
    expect(sql.join('\n')).toMatch(/parent_session_id IS NOT NULL/i);
    expect(sql.join('\n')).not.toMatch(/ai_agent_messages/i);
    expect(sql.join('\n')).not.toMatch(/\bDELETE\b/i);
  });

  it('is idempotent once no invalid edges remain', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 'nested' }] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const updateMetadata = vi.fn(async () => undefined);

    expect(await repairNestedWorkstreamContainers(db as any, updateMetadata)).toEqual({ repaired: 1 });
    expect(await repairNestedWorkstreamContainers(db as any, updateMetadata)).toEqual({ repaired: 0 });
    expect(updateMetadata).toHaveBeenCalledTimes(1);
  });
});
