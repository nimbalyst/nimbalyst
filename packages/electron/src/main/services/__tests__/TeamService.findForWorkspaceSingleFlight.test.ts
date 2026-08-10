import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchMock, gitRemoteMock, safeHandleMock, handlers, workspaceStates, directories, madeDirectories,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    fetchMock: vi.fn(),
    gitRemoteMock: vi.fn(),
    handlers,
    workspaceStates: new Map<string, any>(),
    directories: new Set<string>(),
    madeDirectories: [] as string[],
    safeHandleMock: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler);
    }),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: class {},
  net: { fetch: fetchMock },
}));

vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: safeHandleMock }));

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('../../utils/gitUtils', () => ({ getNormalizedGitRemote: gitRemoteMock }));

vi.mock('fs', () => ({
  existsSync: (path: string) => directories.has(path),
}));

vi.mock('fs/promises', () => ({
  mkdir: async (path: string) => { madeDirectories.push(path); directories.add(path); },
  stat: async () => ({ isDirectory: () => true }),
}));

vi.mock('../../utils/store', () => ({
  getWorkspaceState: (workspacePath: string) => workspaceStates.get(workspacePath) ?? {},
  updateWorkspaceState: (workspacePath: string, updater: (state: any) => void) => {
    const state = workspaceStates.get(workspacePath) ?? {};
    updater(state);
    workspaceStates.set(workspacePath, state);
    return state;
  },
}));

vi.mock('../teamProjectResolver', () => ({
  resolveTeamForRemoteHash: (teams: Array<{ gitRemoteHash: string | null }>, hash: string) =>
    teams.find((t) => t.gitRemoteHash === hash) ?? null,
}));

vi.mock('../../utils/collabSyncUrl', () => ({ getCollabSyncHttpUrl: () => 'https://sync.test' }));

vi.mock('../jwtOrg', () => ({
  assertJwtMatchesOrg: vi.fn(),
  getJwtExp: vi.fn(() => Math.floor(Date.now() / 1000) + 300),
  AuthContextMismatchError: class AuthContextMismatchError extends Error {},
}));

vi.mock('../StytchAuthService', () => ({
  getAccounts: vi.fn(() => [{ personalOrgId: 'personal-1', email: 'user@test.com' }]),
  getPersonalSessionJwt: vi.fn(() => 'personal-jwt'),
  getPersonalSessionJwtForAccount: vi.fn(() => 'personal-jwt'),
  getSessionToken: vi.fn(() => 'session-token'),
  getSessionTokenForAccount: vi.fn(() => 'session-token'),
  isAuthenticated: vi.fn(() => true),
  refreshSession: vi.fn(async () => false),
  refreshSessionForAccount: vi.fn(async () => null),
  refreshPersonalSessionForAccount: vi.fn(async () => null),
  onAuthStateChange: vi.fn(() => () => {}),
  updateSessionToken: vi.fn(),
  updateSessionTokenForAccount: vi.fn(),
  getStytchUserId: vi.fn(() => 'user-1'),
  getUserEmail: vi.fn(() => 'user@test.com'),
  getPersonalOrgId: vi.fn(() => 'personal-1'),
  getPersonalUserId: vi.fn(() => 'user-1'),
}));

vi.mock('@nimbalyst/runtime', () => ({
  asPersonalJwt: (jwt: string) => jwt,
  asTeamJwt: (jwt: string) => jwt,
}));

vi.mock('../../database/initialize', () => ({}));
vi.mock('../OrgProjectionService', () => ({}));
vi.mock('../OrgAccessResolver', () => ({}));
vi.mock('../TrackerSyncManager', () => ({}));
vi.mock('../CollabBackupService', () => ({}));
// createTeamAuthBootstrap is invoked at TeamService module scope (assigned to
// runAuthenticatedTeamBootstrap), so the mock must return a callable factory
// even though this test never triggers that bootstrap.
vi.mock('../TeamAuthBootstrap', () => ({ createTeamAuthBootstrap: (fn: unknown) => fn }));

import {
  bindWorkspaceToSharedProject,
  findTeamForWorkspace,
  invalidateListTeamsCache,
  registerTeamHandlers,
} from '../TeamService';
import { refreshPersonalSessionForAccount } from '../StytchAuthService';
import { getJwtExp } from '../jwtOrg';

const REMOTE = 'github.com/acme/widgets';
const REMOTE_HASH = createHash('sha256').update(REMOTE).digest('hex');
const OTHER_REMOTE = 'github.com/acme/other';
const OTHER_REMOTE_HASH = createHash('sha256').update(OTHER_REMOTE).digest('hex');

function apiTeamsFetchCallCount(): number {
  return fetchMock.mock.calls.filter((call: unknown[]) => {
    const url = call[0] as string;
    return url.includes('/api/teams') && !url.includes('/api/teams/');
  }).length;
}

describe('team:find-for-workspace single-flight (RC4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    gitRemoteMock.mockReset();
    handlers.clear();
    // The listTeams cache is process-global state in TeamService.ts (by
    // design -- it's meant to outlive individual calls). Reset it so each
    // test starts from a clean slate instead of reusing a prior test's cache.
    invalidateListTeamsCache();

    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        teams: [
          { orgId: 'org-1', name: 'Widgets Team', gitRemoteHash: REMOTE_HASH, createdAt: new Date().toISOString(), role: 'admin' },
          { orgId: 'org-2', name: 'Other Team', gitRemoteHash: OTHER_REMOTE_HASH, createdAt: new Date().toISOString(), role: 'admin' },
        ],
      }),
    }));

    registerTeamHandlers();
  });

  it('collapses N concurrent calls for the same workspace into one git-remote resolution and one /api/teams fetch', async () => {
    let resolveRemote: (value: string) => void;
    gitRemoteMock.mockImplementation(() => new Promise((resolve) => { resolveRemote = resolve; }));

    const handler = handlers.get('team:find-for-workspace');
    expect(handler).toBeTruthy();

    const calls = Array.from({ length: 5 }, () => handler!(null, '/workspace/one'));
    // Let the concurrent calls all reach the (still-pending) git remote resolution.
    await Promise.resolve();
    await Promise.resolve();
    resolveRemote!(REMOTE);

    const results = await Promise.all(calls);

    expect(gitRemoteMock).toHaveBeenCalledTimes(1);
    expect(apiTeamsFetchCallCount()).toBe(1);
    for (const result of results) {
      expect(result).toEqual({ success: true, team: expect.objectContaining({ orgId: 'org-1' }) });
    }
  });

  it('does not dedupe calls for different workspaces', async () => {
    gitRemoteMock.mockImplementation(async (workspacePath: string) =>
      workspacePath === '/workspace/one' ? REMOTE : OTHER_REMOTE);

    const handler = handlers.get('team:find-for-workspace')!;
    await Promise.all([handler(null, '/workspace/one'), handler(null, '/workspace/two')]);

    expect(gitRemoteMock).toHaveBeenCalledTimes(2);
  });

  it('runs a fresh resolution for a later, non-overlapping call', async () => {
    gitRemoteMock.mockResolvedValue(REMOTE);

    const handler = handlers.get('team:find-for-workspace')!;
    await handler(null, '/workspace/one');
    await handler(null, '/workspace/one');

    // Git-remote resolution isn't memoized (pure concurrent-collapse), but the
    // underlying listTeams /api/teams fetch IS TTL-cached, so it stays at 1.
    expect(gitRemoteMock).toHaveBeenCalledTimes(2);
    expect(apiTeamsFetchCallCount()).toBe(1);
  });
});

describe('workspace org resolution without a git remote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    gitRemoteMock.mockReset();
    workspaceStates.clear();
    handlers.clear();
    invalidateListTeamsCache();

    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        teams: [
          { orgId: 'org-1', name: 'Widgets Team', gitRemoteHash: REMOTE_HASH, createdAt: new Date().toISOString(), role: 'admin' },
          {
            orgId: 'org-2',
            name: 'Other Team',
            gitRemoteHash: OTHER_REMOTE_HASH,
            teamProjectId: 'tp-primary',
            projects: [
              { projectId: 'p-1', teamProjectId: 'tp-primary', gitRemoteHash: OTHER_REMOTE_HASH, slug: null, name: 'Other Team' },
              { projectId: 'p-2', teamProjectId: 'tp-notes', gitRemoteHash: null, slug: 'notes', name: 'Notes' },
            ],
            createdAt: new Date().toISOString(),
            role: 'admin',
          },
          { orgId: 'org-invited', name: 'Not Joined', gitRemoteHash: null, membershipType: 'invited', createdAt: new Date().toISOString(), role: 'member' },
        ],
      }),
    }));

    registerTeamHandlers();
  });

  it('resolves the org recorded for a workspace that has no git remote', async () => {
    gitRemoteMock.mockResolvedValue(null);
    workspaceStates.set('/projects/plain-folder', { localOrgBinding: { orgId: 'org-2' } });

    await expect(findTeamForWorkspace('/projects/plain-folder')).resolves.toEqual(
      expect.objectContaining({ orgId: 'org-2' }),
    );
  });

  it('still reports no org for a remote-less workspace with no recorded binding', async () => {
    gitRemoteMock.mockResolvedValue(null);

    await expect(findTeamForWorkspace('/projects/unbound')).resolves.toBeNull();
  });

  it('never resolves a binding to an org the account has not actually joined', async () => {
    gitRemoteMock.mockResolvedValue(null);
    workspaceStates.set('/projects/plain-folder', { localOrgBinding: { orgId: 'org-invited' } });

    await expect(findTeamForWorkspace('/projects/plain-folder')).resolves.toBeNull();
  });

  // A remote-less workspace added to an existing org belongs to the project it
  // was added as, not to the org's primary project -- routing it to the primary
  // would put its tracker items in another project's room.
  it('routes a remote-less workspace to the project it was added as', async () => {
    gitRemoteMock.mockResolvedValue(null);
    workspaceStates.set('/projects/notes', {
      localOrgBinding: { orgId: 'org-2', teamProjectId: 'tp-notes' },
    });

    await expect(findTeamForWorkspace('/projects/notes')).resolves.toEqual(
      expect.objectContaining({ orgId: 'org-2', teamProjectId: 'tp-notes', name: 'Notes' }),
    );
  });

  it('reports no org when the bound project is gone from the org registry', async () => {
    gitRemoteMock.mockResolvedValue(null);
    workspaceStates.set('/projects/deleted', {
      localOrgBinding: { orgId: 'org-2', teamProjectId: 'tp-removed' },
    });

    await expect(findTeamForWorkspace('/projects/deleted')).resolves.toBeNull();
  });

  it('lets a matching git remote win over a stale local binding', async () => {
    gitRemoteMock.mockResolvedValue(REMOTE);
    workspaceStates.set('/projects/with-remote', { localOrgBinding: { orgId: 'org-2' } });

    await expect(findTeamForWorkspace('/projects/with-remote')).resolves.toEqual(
      expect.objectContaining({ orgId: 'org-1' }),
    );
  });
});

describe('binding a directory to a shared project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    gitRemoteMock.mockReset();
    gitRemoteMock.mockResolvedValue(null);
    workspaceStates.clear();
    directories.clear();
    madeDirectories.length = 0;
    invalidateListTeamsCache();

    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        teams: [
          {
            orgId: 'org-1',
            name: 'Widgets Team',
            gitRemoteHash: REMOTE_HASH,
            teamProjectId: 'tp-primary',
            projects: [
              { projectId: 'p-1', teamProjectId: 'tp-primary', gitRemoteHash: REMOTE_HASH, slug: null, name: 'Widgets' },
              { projectId: 'p-2', teamProjectId: 'tp-notes', gitRemoteHash: null, slug: 'notes', name: 'Notes' },
            ],
            createdAt: new Date().toISOString(),
            role: 'admin',
          },
          { orgId: 'org-invited', name: 'Not Joined', gitRemoteHash: null, teamProjectId: 'tp-other', membershipType: 'invited', createdAt: new Date().toISOString(), role: 'member' },
        ],
      }),
    }));
  });

  const bind = (overrides: Partial<{ orgId: string; teamProjectId: string; directoryPath: string }> = {}) =>
    bindWorkspaceToSharedProject({
      orgId: 'org-1',
      teamProjectId: 'tp-notes',
      directoryPath: '/projects/notes',
      ...overrides,
    });

  it('creates the directory and records the project it belongs to', async () => {
    await bind();

    expect(madeDirectories).toContain('/projects/notes');
    expect(workspaceStates.get('/projects/notes')?.localOrgBinding).toEqual({
      orgId: 'org-1',
      teamProjectId: 'tp-notes',
    });
  });

  it('refuses an organization the account has not joined', async () => {
    await expect(bind({ orgId: 'org-invited', teamProjectId: 'tp-other' }))
      .rejects.toThrow(/not a member/i);
    expect(workspaceStates.size).toBe(0);
  });

  it('refuses a project that is not in the organization', async () => {
    await expect(bind({ teamProjectId: 'tp-gone' })).rejects.toThrow(/no longer part/i);
  });

  // Binding an arbitrary folder to a repo-backed project would give the same
  // project two answers -- the remote match and the binding.
  it('refuses a project that is matched by its git remote', async () => {
    await expect(bind({ teamProjectId: 'tp-primary' })).rejects.toThrow(/clone the repository/i);
  });

  it('refuses a folder that already belongs to another project', async () => {
    directories.add('/projects/notes');
    workspaceStates.set('/projects/notes', {
      localOrgBinding: { orgId: 'org-1', teamProjectId: 'tp-elsewhere' },
    });

    await expect(bind()).rejects.toThrow(/different project/i);
  });

  it("refuses a folder whose git remote connects it somewhere else", async () => {
    directories.add('/projects/notes');
    gitRemoteMock.mockResolvedValue(REMOTE);

    await expect(bind()).rejects.toThrow(/different project/i);
    expect(workspaceStates.get('/projects/notes')?.localOrgBinding).toBeUndefined();
  });

  it('accepts an existing folder that has files but no conflicting identity', async () => {
    directories.add('/projects/notes');

    await bind();

    expect(madeDirectories).toEqual([]);
    expect(workspaceStates.get('/projects/notes')?.localOrgBinding).toEqual({
      orgId: 'org-1',
      teamProjectId: 'tp-notes',
    });
  });
});

describe('listTeams TTL cache + invalidation (RC4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    gitRemoteMock.mockReset();
    handlers.clear();
    invalidateListTeamsCache();
    vi.useFakeTimers();

    gitRemoteMock.mockResolvedValue(REMOTE);
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        teams: [{ orgId: 'org-1', name: 'Widgets Team', gitRemoteHash: REMOTE_HASH, createdAt: new Date().toISOString(), role: 'admin' }],
      }),
    }));

    registerTeamHandlers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses the cached team list well past the old 5s TTL', async () => {
    await findTeamForWorkspace('/workspace/one');
    vi.advanceTimersByTime(60_000); // well past the pre-fix 5s TTL
    await findTeamForWorkspace('/workspace/one');

    expect(apiTeamsFetchCallCount()).toBe(1);
  });

  it('invalidateListTeamsCache() forces the next call to refetch', async () => {
    await findTeamForWorkspace('/workspace/one');
    invalidateListTeamsCache();
    await findTeamForWorkspace('/workspace/one');

    expect(apiTeamsFetchCallCount()).toBe(2);
  });

  it('does not cache a failed account lookup as an authoritative empty team list', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('Team API timeout after 15000ms'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          teams: [{ orgId: 'org-1', name: 'Widgets Team', gitRemoteHash: REMOTE_HASH, createdAt: new Date().toISOString(), role: 'admin' }],
        }),
      });

    await expect(findTeamForWorkspace('/workspace/one')).resolves.toBeNull();
    await expect(findTeamForWorkspace('/workspace/one')).resolves.toEqual(
      expect.objectContaining({ orgId: 'org-1' }),
    );
    expect(apiTeamsFetchCallCount()).toBe(2);
  });

  it('refreshes the account personal JWT rather than retrying discovery with an active team JWT', async () => {
    vi.mocked(refreshPersonalSessionForAccount).mockResolvedValueOnce('fresh-personal-jwt' as never);
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          teams: [{ orgId: 'org-1', name: 'Widgets Team', gitRemoteHash: REMOTE_HASH, createdAt: new Date().toISOString(), role: 'admin' }],
        }),
      });

    await expect(findTeamForWorkspace('/workspace/one')).resolves.toEqual(
      expect.objectContaining({ orgId: 'org-1' }),
    );
    expect(refreshPersonalSessionForAccount).toHaveBeenCalledWith('personal-1');
  });

  it('refreshes an expiring account personal JWT before sending the request', async () => {
    vi.mocked(getJwtExp).mockReturnValueOnce(Math.floor(Date.now() / 1000) + 30);
    vi.mocked(refreshPersonalSessionForAccount).mockResolvedValueOnce('fresh-personal-jwt' as never);

    await expect(findTeamForWorkspace('/workspace/one')).resolves.toEqual(
      expect.objectContaining({ orgId: 'org-1' }),
    );

    expect(refreshPersonalSessionForAccount).toHaveBeenCalledWith('personal-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer fresh-personal-jwt' }),
    }));
  });
});
