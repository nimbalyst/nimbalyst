// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query } }));
vi.mock('../../MainBodyDocService', () => ({ readHeadlessBodyMarkdown: vi.fn() }));

import { checkTrackerItemBody, readLocalTrackerBody } from '../pageTypeBodyCheck';

const PAGE = '# Sync engine\r\n\r\nMoves documents.  \r\n\r\n\r\n- one\r\n';

describe('checkTrackerItemBody', () => {
  it('matches a team body that differs from the page only in line endings and blank lines', async () => {
    const readRoomBody = vi.fn(async () => '# Sync engine\n\nMoves documents.\n\n- one\n\n');
    const readLocalBody = vi.fn();

    const check = await checkTrackerItemBody(
      { workspacePath: '/ws', itemId: 'mod_1', expected: PAGE, lane: 'team' },
      { readRoomBody, readLocalBody },
    );

    expect(check).toEqual({ status: 'match' });
    expect(readRoomBody).toHaveBeenCalledWith('/ws', 'mod_1');
    expect(readLocalBody).not.toHaveBeenCalled();
  });

  it('reports an unreachable room as unreadable, never as an empty match, and a changed body as a mismatch', async () => {
    const unreachable = await checkTrackerItemBody(
      { workspacePath: '/ws', itemId: 'mod_1', expected: '', lane: 'team' },
      { readRoomBody: async () => null, readLocalBody: async () => '' },
    );
    expect(unreachable.status).toBe('unreadable');

    const changed = await checkTrackerItemBody(
      { workspacePath: '/ws', itemId: 'idea_1', expected: PAGE, lane: 'personal' },
      { readRoomBody: async () => null, readLocalBody: async () => '# Sync engine\n' },
    );
    expect(changed).toEqual({ status: 'mismatch' });
  });
});

describe('readLocalTrackerBody', () => {
  it('reads the body whether the backend returns the content column parsed or as JSON text', async () => {
    query.mockResolvedValueOnce({ rows: [{ content: JSON.stringify('# Idea\n') }] });
    expect(await readLocalTrackerBody('/ws', 'idea_1')).toBe('# Idea\n');

    query.mockResolvedValueOnce({ rows: [{ content: { markdown: '# Idea\n' } }] });
    expect(await readLocalTrackerBody('/ws', 'idea_1')).toBe('# Idea\n');

    // PGLite decodes the JSONB scalar: the markdown itself, not JSON text.
    query.mockResolvedValueOnce({ rows: [{ content: '# Idea\n' }] });
    expect(await readLocalTrackerBody('/ws', 'idea_1')).toBe('# Idea\n');
    query.mockResolvedValueOnce({ rows: [{ content: '42' }] });
    expect(await readLocalTrackerBody('/ws', 'idea_1')).toBe('42');

    query.mockResolvedValueOnce({ rows: [] });
    expect(await readLocalTrackerBody('/ws', 'gone')).toBeNull();
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('workspace = $2'), ['gone', '/ws']);
  });
});
