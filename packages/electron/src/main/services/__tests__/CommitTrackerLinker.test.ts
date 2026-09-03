import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { storeGet, getEffectiveTrackerAutomation, execFile, getCurrentIdentity } = vi.hoisted(() => ({
  storeGet: vi.fn(),
  getEffectiveTrackerAutomation: vi.fn(),
  execFile: vi.fn(),
  getCurrentIdentity: vi.fn(),
}));

vi.mock('child_process', () => ({ execFile }));

vi.mock('../TrackerIdentityService', () => ({ getCurrentIdentity }));

const LOCAL_IDENTITY = {
  email: 'alice@work.test',
  displayName: 'Alice Local',
  gitName: 'Alice',
  gitEmail: 'alice@example.com',
};

/** Queue what `git show` reports as the next commit's author. */
function nextCommitAuthor(name: string, email: string) {
  execFile.mockImplementationOnce((_file, _args, _opts, callback) => {
    callback(null, `${name}\n${email}\n`, '');
  });
}

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
import { mergeActivity } from '../tracker/trackerActivity';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';

// The closing status is resolved from the item's own schema, so the builtins
// have to be registered for the linker to know a plan completes on `completed`.
beforeAll(() => {
  loadBuiltinTrackers();
});

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

  // Local numbers leak: an agent handed one writes it into the commit message,
  // which is what a number is for. The dot is what makes that harmless -- a
  // team prefix is letters only, so `NIM.12` cannot be read as `NIM-12` and
  // cannot close somebody's item.
  it('ignores a leaked local number without touching the team key beside it', () => {
    expect(parseIssueKeys('fix: thing\n\nFixes NIM.12')).toEqual([]);
    expect(parseIssueKeys('fix login per NIM.12\n\nFixes NIM-212')).toEqual([
      { issueKey: 'NIM-212', shouldClose: true },
    ]);
  });
});

describe('CommitTrackerLinker', () => {
  beforeEach(() => {
    storeGet.mockReset();
    getEffectiveTrackerAutomation.mockReset();
    storeGet.mockReturnValue({ enabled: true, autoCloseOnCommit: true });
    getEffectiveTrackerAutomation.mockImplementation((settings: unknown) => settings);
    getCurrentIdentity.mockReturnValue(LOCAL_IDENTITY);
    // Default: git cannot read the commit, so attribution falls back to the local identity.
    execFile.mockReset();
    execFile.mockImplementation((_file, _args, _opts, callback) => {
      callback(new Error('not a git repository'), '', '');
    });
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
        .mockResolvedValueOnce({ rows: [{ type: 'bug', data: { status: 'in-review' } }] })
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

    it('closes a plan into the status a plan actually has', async () => {
      // `done` is not in plan's option list. Writing it anyway produced a status
      // no filter, board column, or picker could match -- it survived only
      // because the validator downgrades unknown select values to warnings.
      const query = vi.fn();
      const linker = linkerWithSession(query);
      query
        .mockResolvedValueOnce({ rows: [{ id: 'tracker-1', issue_key: 'nim-42' }] })
        .mockResolvedValueOnce({ rows: [{ type: 'plan', data: { status: 'in-review' } }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await linker.linkBySession(
        'abcdef0',
        'feat: land the thing\n\nFixes NIM-42',
        'session-1',
        '/workspace'
      );

      expect(result.closedItemIds).toEqual(['tracker-1']);
      const closePayload = JSON.parse(query.mock.calls[5]?.[1]?.[0] as string);
      expect(closePayload.status).toBe('completed');
      expect(closePayload.activity.at(-1)).toMatchObject({
        action: 'status_changed',
        oldValue: 'in-review',
        newValue: 'completed',
      });
    });

    it('writes close entries that survive a sync merge as distinct, attributed events', async () => {
      // mergeActivity keys the union on `id` and sorts numerically on
      // `timestamp`. A raw push with neither collapses every "closed via
      // commit" entry on an item into one and sorts it as NaN.
      const close = async (data: Record<string, unknown>, sha: string) => {
        const query = vi.fn();
        const linker = linkerWithSession(query);
        query
          .mockResolvedValueOnce({ rows: [{ id: 'tracker-1', issue_key: 'nim-42' }] })
          .mockResolvedValueOnce({ rows: [{ type: 'bug', data }] })
          .mockResolvedValueOnce({ rows: [] });
        await linker.linkBySession(sha, `fix: thing\n\nFixes NIM-42`, 'session-1', '/workspace');
        return JSON.parse(query.mock.calls[5]?.[1]?.[0] as string);
      };

      // First commit is by this machine's git user, second by a teammate.
      nextCommitAuthor('Alice', 'ALICE@example.com');
      const first = await close({ status: 'in-review' }, 'abcdef0');
      nextCommitAuthor('Bob', 'bob@example.com');
      const second = await close({ ...first, status: 'in-review' }, '1234567');

      const merged = mergeActivity(first.activity, second.activity) ?? [];
      expect(merged).toHaveLength(2);
      for (const entry of merged) {
        expect(typeof entry.id).toBe('string');
        expect(typeof entry.timestamp).toBe('number');
        expect(entry.action).toBe('status_changed');
      }
      expect(merged.map((entry) => entry.note)).toEqual([
        'Closed via commit abcdef0',
        'Closed via commit 1234567',
      ]);
      // A commit by the local git user gets the signed-in identity, like every
      // other writer; a teammate's commit is attributed to its git author.
      expect(merged[0].authorIdentity).toEqual(LOCAL_IDENTITY);
      expect(merged[1].authorIdentity).toEqual({
        email: 'bob@example.com',
        displayName: 'Bob',
        gitName: 'Bob',
        gitEmail: 'bob@example.com',
      });
      expect(execFile.mock.calls[0]?.[1]).toEqual(['show', '-s', '--format=%an%n%ae', 'abcdef0']);
    });

    it('still attributes the close when the commit author cannot be read', async () => {
      const query = vi.fn();
      const linker = linkerWithSession(query);
      query
        .mockResolvedValueOnce({ rows: [{ id: 'tracker-1', issue_key: 'nim-42' }] })
        .mockResolvedValueOnce({ rows: [{ type: 'bug', data: { status: 'in-review' } }] })
        .mockResolvedValueOnce({ rows: [] });

      await linker.linkBySession('abcdef0', 'fix: thing\n\nFixes NIM-42', 'session-1', '/workspace');

      const closePayload = JSON.parse(query.mock.calls[5]?.[1]?.[0] as string);
      expect(closePayload.activity.at(-1).authorIdentity).toEqual(LOCAL_IDENTITY);
    });

    it('does not reopen an item that was already abandoned', async () => {
      // "Already closed" has to mean terminal, not equal to `done`. A commit
      // referencing a won't-do bug must leave it won't-do.
      const query = vi.fn();
      const linker = linkerWithSession(query);
      query
        .mockResolvedValueOnce({ rows: [{ id: 'tracker-1', issue_key: 'nim-42' }] })
        .mockResolvedValueOnce({ rows: [{ type: 'bug', data: { status: 'wont-do' } }] });

      await linker.linkBySession(
        'abcdef0',
        'chore: tidy up\n\nFixes NIM-42',
        'session-1',
        '/workspace'
      );

      // Read only -- no UPDATE follows the status read.
      expect(query).toHaveBeenCalledTimes(5);
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
