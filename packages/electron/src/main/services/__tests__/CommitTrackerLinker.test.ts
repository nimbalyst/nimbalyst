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

import { CommitTrackerLinker, getIssueKeyPrefix } from '../CommitTrackerLinker';

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
});
