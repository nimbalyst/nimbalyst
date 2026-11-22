// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
    createUncommittedSessionLookup,
    UNCOMMITTED_SESSION_MATCH_CAP,
} from '../uncommittedSessionLookup';

const WS = '/ws';

function filesOfSize(n: number): Set<string> {
    const files = new Set<string>();
    for (let i = 0; i < n; i++) files.add(`dir/file-${i}.txt`);
    return files;
}

function makeLookup(rows: Array<{ session_id: string; file_path: string }> = []) {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows }));
    const warn = vi.fn();
    const { lookup } = createUncommittedSessionLookup(query, warn);
    return { lookup, query, warn };
}

describe('uncommitted session lookup cap (#1936)', () => {
    it('skips the query and returns an empty map above the cap, warning once per workspace', async () => {
        const { lookup, query, warn } = makeLookup([{ session_id: 's1', file_path: 'dir/file-0.txt' }]);
        const files = filesOfSize(UNCOMMITTED_SESSION_MATCH_CAP + 1);

        const first = await lookup(WS, files);
        const second = await lookup(WS, files);

        expect(first.size).toBe(0);
        expect(second.size).toBe(0);
        expect(query).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain(String(UNCOMMITTED_SESSION_MATCH_CAP + 1));
    });

    it('still matches at exactly the cap, querying both relative and absolute forms', async () => {
        const { lookup, query, warn } = makeLookup([{ session_id: 's1', file_path: 'dir/file-0.txt' }]);
        const files = filesOfSize(UNCOMMITTED_SESSION_MATCH_CAP);

        const result = await lookup(WS, files);

        expect(result.get('dir/file-0.txt')).toBe('s1');
        expect(query).toHaveBeenCalledTimes(1);
        const params = query.mock.calls[0][1] as [string, string[]];
        expect(params[0]).toBe(WS);
        expect(params[1]).toHaveLength(UNCOMMITTED_SESSION_MATCH_CAP * 2);
        expect(params[1]).toContain(`${WS}/dir/file-0.txt`);
        expect(warn).not.toHaveBeenCalled();
    });

    it('caches by file set: same set reuses the result, a changed set re-queries', async () => {
        const { lookup, query } = makeLookup([{ session_id: 's1', file_path: 'a.ts' }]);

        await lookup(WS, new Set(['a.ts', 'b.ts']));
        await lookup(WS, new Set(['b.ts', 'a.ts']));
        expect(query).toHaveBeenCalledTimes(1);

        await lookup(WS, new Set(['a.ts', 'c.ts']));
        expect(query).toHaveBeenCalledTimes(2);
    });

    it('returns an empty map without querying for an empty set', async () => {
        const { lookup, query } = makeLookup();
        expect((await lookup(WS, new Set())).size).toBe(0);
        expect(query).not.toHaveBeenCalled();
    });
});
