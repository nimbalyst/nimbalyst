import { beforeEach, describe, expect, it, vi } from 'vitest';

const { storeGet, getEffectiveTrackerAutomation } = vi.hoisted(() => ({
  storeGet: vi.fn(),
  getEffectiveTrackerAutomation: vi.fn(),
}));

vi.mock('electron-store', () => ({
  default: class MockStore {
    get(key: string, fallback: unknown) {
      return storeGet(key, fallback);
    }
  },
}));

vi.mock('../../utils/store', () => ({
  getEffectiveTrackerAutomation,
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

import { CommitTrackerLinker, getIssueKeyPrefix, parseIssueKeys } from '../CommitTrackerLinker';

describe('parseIssueKeys', () => {
  // LC-### is the provisional key an item holds between creation and the
  // tracker room's ack. It means something different in every workspace, so it
  // must never resolve to an item the way a room-assigned key does.
  it('ignores provisional local keys', () => {
    expect(parseIssueKeys('fix: thing\n\nFixes LC-7')).toEqual([]);
  });

  it('still matches room-assigned keys alongside a local one', () => {
    expect(parseIssueKeys('fix: thing\n\nFixes NIM-42, refs LC-7')).toEqual([
      { issueKey: 'NIM-42', shouldClose: true },
    ]);
  });
});

describe('CommitTrackerLinker', () => {
  beforeEach(() => {
    storeGet.mockReset();
    getEffectiveTrackerAutomation.mockReset();
    storeGet.mockReturnValue({ enabled: true, autoCloseOnCommit: true });
    getEffectiveTrackerAutomation.mockImplementation((settings: unknown) => settings);
  });

  it('extracts normalized tracker prefixes from issue keys', () => {
    expect(getIssueKeyPrefix('nim-42')).toBe('NIM');
    expect(getIssueKeyPrefix(' NIM-42 ')).toBe('NIM');
    expect(getIssueKeyPrefix('missingseparator')).toBeUndefined();
    expect(getIssueKeyPrefix(null)).toBeUndefined();
  });

  it('links commit references without using PostgreSQL string helpers', async () => {
    const query = vi.fn();
    const db = { query };
    const linker = new CommitTrackerLinker();
    linker.initialize({ getDatabase: () => db });

    query
      .mockResolvedValueOnce({ rows: [{ issue_key: 'nim-42' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'tracker-1', data: {} }] })
      .mockResolvedValueOnce({ rows: [{ data: {} }] })
      .mockResolvedValueOnce({ rows: [] });

    await linker.handleCommitDetected({
      workspacePath: '/workspace',
      commitHash: 'abcdef0',
      commitMessage: 'Refs NIM-42',
      committedFiles: [],
    });

    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0]?.[0]).toContain('SELECT DISTINCT issue_key');
    expect(query.mock.calls[0]?.[0]).not.toContain('SPLIT_PART');
    expect(query.mock.calls[1]?.[1]).toEqual(['NIM-42', '/workspace']);

    const updatePayload = JSON.parse(query.mock.calls[3]?.[1]?.[0] as string);
    expect(updatePayload.linkedCommitSha).toBe('abcdef0');
    expect(updatePayload.linkedCommits).toHaveLength(1);
  });

  describe('linkBySession', () => {
    function linkerWithSession(query: ReturnType<typeof vi.fn>) {
      const linker = new CommitTrackerLinker();
      linker.initialize({ getDatabase: () => ({ query }) });
      query.mockResolvedValueOnce({
        rows: [{ metadata: JSON.stringify({ linkedTrackerItemIds: ['tracker-1', 'file:plan.md'] }) }],
      });
      // appendCommitToItem: SELECT data, then UPDATE
      query.mockResolvedValueOnce({ rows: [{ data: {} }] }).mockResolvedValueOnce({ rows: [] });
      return linker;
    }

    it('closes a linked item when the approved commit message uses a closing keyword', async () => {
      // The passive GitRefWatcher path is opt-in and off by default; a commit the
      // user approved through the proposal widget must close regardless.
      storeGet.mockReturnValue({ enabled: false, autoCloseOnCommit: true });

      const query = vi.fn();
      const linker = linkerWithSession(query);
      query
        .mockResolvedValueOnce({ rows: [{ id: 'tracker-1', issue_key: 'nim-42' }] })
        .mockResolvedValueOnce({ rows: [{ data: { status: 'in-review' } }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await linker.linkBySession(
        'abcdef0',
        'fix: stop the thing crashing\n\nFixes NIM-42',
        'session-1',
        '/workspace'
      );

      expect(result.closedItemIds).toEqual(['tracker-1']);
      // file: entries are plan links, never tracker ids -- they must not be queried
      expect(query.mock.calls[3]?.[1]).toEqual(['/workspace', 'tracker-1']);
      const closePayload = JSON.parse(query.mock.calls[5]?.[1]?.[0] as string);
      expect(closePayload.status).toBe('done');
    });

    it('leaves the item open for a bare reference with no closing keyword', async () => {
      const query = vi.fn();
      const linker = linkerWithSession(query);

      const result = await linker.linkBySession(
        'abcdef0',
        'wip: partway through NIM-42',
        'session-1',
        '/workspace'
      );

      expect(result.closedItemIds).toEqual([]);
      expect(query).toHaveBeenCalledTimes(3); // session read + link only, no status write
    });

    it('respects autoCloseOnCommit being turned off', async () => {
      storeGet.mockReturnValue({ enabled: true, autoCloseOnCommit: false });

      const query = vi.fn();
      const linker = linkerWithSession(query);

      const result = await linker.linkBySession(
        'abcdef0',
        'fix: stop the thing crashing\n\nFixes NIM-42',
        'session-1',
        '/workspace'
      );

      expect(result.closedItemIds).toEqual([]);
      expect(query).toHaveBeenCalledTimes(3);
    });
  });
});
