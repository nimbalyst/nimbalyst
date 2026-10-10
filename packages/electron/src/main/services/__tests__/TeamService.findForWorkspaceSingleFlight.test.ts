import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchMock, gitRemoteMock, safeHandleMock, handlers, workspaceStates, directories, madeDirectories,
  directoryContents, ensureTrackerSyncMock,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    fetchMock: vi.fn(),
    gitRemoteMock: vi.fn(),
    ensureTrackerSyncMock: vi.fn(async () => {}),
    handlers,
    workspaceStates: new Map<string, any>(),
    directories: new Set<string>(),
    directoryContents: new Map<string, string[]>(),
    madeDirectories: [] as string[],
    safeHandleMock: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler);
    }),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: class { static getAllWindows() { return []; } },
  net: { fetch: fetchMock },
}));

vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: safeHandleMock }));

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

// Only the git spawn is mocked; both normalizers stay real, so the legacy-hash
// test below exercises the identifiers the app actually computes.
vi.mock('../../utils/gitUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/gitUtils')>();
  return {
    ...actual,
    getNormalizedGitRemote: gitRemoteMock,
    getRawGitRemote: gitRemoteMock,
    getGitRemoteIdentities: async (workspacePath: string) => {
      const raw = await gitRemoteMock(workspacePath);
      const canonical = actual.normalizeGitRemote(raw);
      const legacy = actual.legacyNormalizeGitRemote(raw);
      return canonical && legacy ? { canonical, legacy } : null;
    },
  };
});

vi.mock('fs', () => ({
  existsSync: (path: string) => directories.has(path),
}));

vi.mock('fs/promises', () => ({
  mkdir: async (path: string) => { madeDirectories.push(path); directories.add(path); },
  stat: async () => ({ isDirectory: () => true }),
  readdir: async (path: string) => directoryContents.get(path) ?? [],
}));

vi.mock('../../utils/store', () => ({
  getWorkspaceState: (workspacePath: string) => workspaceStates.get(workspacePath) ?? {},
  getWorkspaceStateField: (workspacePath: string, field: string) => (workspaceStates.get(workspacePath) as any)?.[field],
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
  asPersonalMemberId: (id: string) => id,
  asTeamJwt: (jwt: string) => jwt,
  asTeamMemberId: (id: string) => id,
}));

vi.mock('../../database/initialize', () => ({}));
vi.mock('../OrgProjectionService', () => ({}));
vi.mock('../OrgAccessResolver', () => ({}));
vi.mock('../TrackerSyncManager', () => ({ ensureTrackerSyncForWorkspace: ensureTrackerSyncMock }));
vi.mock('../CollabBackupService', () => ({}));
// createTeamAuthBootstrap is invoked at TeamService module scope (assigned to
// runAuthenticatedTeamBootstrap), so the mock must return a callable factory
// even though this test never triggers that bootstrap.
vi.mock('../TeamAuthBootstrap', () => ({ createTeamAuthBootstrap: (fn: unknown) => fn }));

import {
  autoMatchTeamForWorkspace,
  bindWorkspaceToSharedProject,
  findTeamForWorkspace,
  getTeamByOrgId,
  invalidateListTeamsCache,
  listTeams,
  registerTeamHandlers,
} from '../TeamService';
import {
  getPersonalSessionJwtForAccount,
  getSessionTokenForAccount,
  refreshPersonalSessionForAccount,
} from '../StytchAuthService';
import { logger } from '../../utils/logger';
import { getJwtExp } from '../jwtOrg';
import {
  inspectProjectFolder,
  joinOrgProjectWithFolder,
  resolveProjectWalkState,
} from '../OrgProjectWalkService';
import { windowStates } from '../../window/windowState';

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
      expect(result).toEqual({
        success: true,
        team: expect.objectContaining({ orgId: 'org-1' }),
        complete: true,
      });
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

/**
 * Correcting the normalization changed the identifier for remotes carrying
 * userinfo -- including `ssh://git@host/...`, which embeds no credential at all
 * and matched correctly before. Those hashes are already stored server-side and
 * SHA-256 cannot be migrated, so a lookup has to accept the legacy hash too or
 * every such workspace silently loses its organization.
 */
describe('git remote matching across the normalization change', () => {
  const SSH_REMOTE = 'ssh://git@github.com/acme/widgets.git';
  const LEGACY_SSH_HASH = createHash('sha256')
    .update('ssh///git@github.com/acme/widgets').digest('hex');
  const CANONICAL_SSH_HASH = createHash('sha256')
    .update('github.com/acme/widgets').digest('hex');

  function respondWithTeamHash(gitRemoteHash: string) {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        teams: [{
          orgId: 'org-ssh',
          name: 'Widgets Team',
          gitRemoteHash,
          createdAt: new Date().toISOString(),
          role: 'admin',
        }],
      }),
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    gitRemoteMock.mockReset();
    workspaceStates.clear();
    invalidateListTeamsCache();
    gitRemoteMock.mockResolvedValue(SSH_REMOTE);
  });

  it('resolves a project stored under the legacy hash', async () => {
    respondWithTeamHash(LEGACY_SSH_HASH);

    expect((await findTeamForWorkspace('/workspace/ssh'))?.orgId).toBe('org-ssh');
  });

  it('resolves a project stored under the canonical hash', async () => {
    respondWithTeamHash(CANONICAL_SSH_HASH);

    expect((await findTeamForWorkspace('/workspace/ssh'))?.orgId).toBe('org-ssh');
  });

  it('still refuses a repository that is genuinely a different one', async () => {
    respondWithTeamHash(createHash('sha256').update('github.com/acme/other').digest('hex'));

    expect(await findTeamForWorkspace('/workspace/ssh')).toBeNull();
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

  it('rejects array-only consumers on server discovery failure and recovers without caching emptiness', async () => {
    await listTeams();
    invalidateListTeamsCache();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ code: 'TEAM_DIRECTORY_UNAVAILABLE', error: 'Organizations unavailable' }) });
    await expect(listTeams()).rejects.toThrow('Organization directory is unavailable');
    await expect(listTeams()).resolves.toEqual([expect.objectContaining({ orgId: 'org-1' })]);
    expect(apiTeamsFetchCallCount()).toBe(3);
  });

  it('does not flatten an unavailable directory into "org not found" for a single-org lookup', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ code: 'TEAM_DIRECTORY_UNAVAILABLE', error: 'Organizations unavailable' }) });
    await expect(getTeamByOrgId('org-1')).rejects.toThrow('Organization directory is unavailable');
    await expect(getTeamByOrgId('org-1')).resolves.toEqual(expect.objectContaining({ orgId: 'org-1' }));
    await expect(getTeamByOrgId('org-absent')).resolves.toBeNull();
  });

  it('rejects a malformed successful response instead of caching an empty directory', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    await expect(listTeams()).rejects.toThrow('Organization directory is unavailable');
    await expect(listTeams()).resolves.toEqual([expect.objectContaining({ orgId: 'org-1' })]);
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

  // Launch with a team-exchanged primary session: signed in, but no personal
  // JWT until the first personal-org exchange. Every lookup in that gap used to
  // fail as "not signed in" -- 63 error lines per startup.
  it('mints a missing personal JWT for a startup burst instead of failing every lookup', async () => {
    vi.mocked(getPersonalSessionJwtForAccount).mockReturnValueOnce(null as never);
    vi.mocked(refreshPersonalSessionForAccount).mockResolvedValueOnce('fresh-personal-jwt' as never);
    const handler = handlers.get('team:find-for-workspace')!;

    const results = await Promise.all(
      ['/workspace/one', '/workspace/two', '/workspace/three'].map((path) => handler(null, path)),
    );

    for (const result of results) {
      expect(result).toEqual({ success: true, team: expect.objectContaining({ orgId: 'org-1' }), complete: true });
    }
    expect(refreshPersonalSessionForAccount).toHaveBeenCalledTimes(1);
    expect(apiTeamsFetchCallCount()).toBe(1);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer fresh-personal-jwt' }),
    }));
  });

  it('reports a signed-out account as incomplete without a refresh or a pending-invite error', async () => {
    vi.mocked(getPersonalSessionJwtForAccount).mockReturnValue(null as never);
    vi.mocked(getSessionTokenForAccount).mockReturnValue(null as never);
    try {
      const result = await handlers.get('team:find-for-workspace')!(null, '/workspace/one');

      expect(result).toEqual({ success: true, team: null, complete: false });
      expect(refreshPersonalSessionForAccount).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(vi.mocked(logger.main.error).mock.calls.flat().join(' ')).not.toContain('findPendingInviteForWorkspace');
    } finally {
      vi.mocked(getPersonalSessionJwtForAccount).mockReturnValue('personal-jwt' as never);
      vi.mocked(getSessionTokenForAccount).mockReturnValue('session-token' as never);
    }
  });
});

/**
 * `isAuthenticated()` flips as soon as a session exists, but the personal JWT
 * the team directory needs can arrive a beat later. The old one-shot retry
 * fired into that gap, read the resulting empty list as "no team", and left
 * tracker sync off for the entire app session.
 */
describe('autoMatchTeamForWorkspace across the JWT arrival gap', () => {
  const okTeams = (teams: unknown[]) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({ teams }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    gitRemoteMock.mockReset();
    workspaceStates.clear();
    invalidateListTeamsCache();
    vi.useFakeTimers();
    gitRemoteMock.mockResolvedValue(REMOTE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['auth', 'server'])('recovers tracker startup after an incomplete %s lookup', async (failure) => {
    if (failure === 'auth') fetchMock.mockRejectedValueOnce(new Error('Not authenticated. Sign in first.'));
    else fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'Organizations unavailable' }) });
    fetchMock.mockImplementation(okTeams([{
        orgId: 'org-1', name: 'Widgets Team', gitRemoteHash: REMOTE_HASH,
        teamProjectId: 'tp-1', createdAt: new Date().toISOString(), role: 'admin',
      }]));

    await autoMatchTeamForWorkspace('/workspace/jwt-gap');
    expect(ensureTrackerSyncMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(ensureTrackerSyncMock).toHaveBeenCalledWith('/workspace/jwt-gap');
  });

  // The other half: a complete lookup that found nothing is the truth, and
  // must not turn into a retry loop against the team API.
  it('does not retry when the directory came back complete and nothing matched', async () => {
    fetchMock.mockImplementation(okTeams([]));

    await autoMatchTeamForWorkspace('/workspace/genuinely-solo');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(apiTeamsFetchCallCount()).toBe(1);
    expect(ensureTrackerSyncMock).not.toHaveBeenCalled();
  });
});

/**
 * The post-sign-in project walk. Org membership is account-level, but the org a
 * project window shows is resolved per workspace from its git remote -- so an
 * invited member who opens an unrelated folder reads as having no organization
 * at all. These cover the two halves of the fix: deciding the walk is needed,
 * and the folder actually resolving afterwards.
 */
describe('post-sign-in project walk', () => {
  const teamsFixture = () => ({
    teams: [
      {
        orgId: 'org-1',
        name: 'Widgets Team',
        gitRemoteHash: REMOTE_HASH,
        teamProjectId: 'tp-primary',
        projects: [
          { projectId: 'p-1', teamProjectId: 'tp-primary', gitRemoteHash: REMOTE_HASH, slug: null, name: 'Widgets', remoteUrl: 'git@github.com:acme/widgets.git' },
          { projectId: 'p-2', teamProjectId: 'tp-notes', gitRemoteHash: null, slug: 'notes', name: 'Notes' },
        ],
        createdAt: new Date().toISOString(),
        role: 'admin',
      },
      { orgId: 'org-invited', name: 'Not Joined', gitRemoteHash: null, teamProjectId: 'tp-other', membershipType: 'invited', createdAt: new Date().toISOString(), role: 'member' },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    gitRemoteMock.mockReset();
    gitRemoteMock.mockResolvedValue(null);
    workspaceStates.clear();
    directories.clear();
    directoryContents.clear();
    madeDirectories.length = 0;
    windowStates.clear();
    invalidateListTeamsCache();

    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => teamsFixture(),
    }));
  });

  afterEach(() => {
    windowStates.clear();
  });

  const openWindowOn = (workspacePath: string) => {
    windowStates.set(windowStates.size + 1, { workspacePath } as never);
  };

  describe('deciding the walk is needed', () => {
    it('reports the org as unbound when the only open workspace matches nothing', async () => {
      openWindowOn('/projects/unrelated');

      await expect(resolveProjectWalkState()).resolves.toEqual({
        orgs: [{ orgId: 'org-1', name: 'Widgets Team' }],
        boundOrgIds: [],
        thisWindowOrgId: null,
      });
    });

    it('reports the org as bound once an open workspace resolves to it', async () => {
      gitRemoteMock.mockResolvedValue(REMOTE);
      openWindowOn('/projects/widgets');

      await expect(resolveProjectWalkState()).resolves.toEqual({
        orgs: [{ orgId: 'org-1', name: 'Widgets Team' }],
        boundOrgIds: ['org-1'],
        thisWindowOrgId: null,
      });
    });

    // Bound in ANY window is what stops the interruption; bound in THIS window
    // is what stops offering this window a way in. Conflating them told a
    // member with a second window open that they had no organization at all.
    it('separates the asking window own org from what any window is bound to', async () => {
      gitRemoteMock.mockResolvedValue(REMOTE);
      openWindowOn('/projects/widgets');

      await expect(resolveProjectWalkState('/projects/widgets')).resolves.toMatchObject({
        boundOrgIds: ['org-1'],
        thisWindowOrgId: 'org-1',
      });
      await expect(resolveProjectWalkState('/projects/unrelated')).resolves.toMatchObject({
        boundOrgIds: ['org-1'],
        thisWindowOrgId: null,
      });
    });

    // An invitation is not membership; offering to walk someone into a project
    // they cannot read yet would fail at the first fetch.
    it('leaves invitations out of the org list', async () => {
      const state = await resolveProjectWalkState();
      expect(state.orgs.map((org) => org.orgId)).toEqual(['org-1']);
    });
  });

  describe('choosing a folder for a project', () => {
    it('offers a clone into an empty folder for a repository-backed project', async () => {
      directories.add('/projects/empty');

      await expect(inspectProjectFolder({
        orgId: 'org-1', teamProjectId: 'tp-primary', directoryPath: '/projects/empty',
      })).resolves.toEqual({ kind: 'clonable' });
    });

    it('recognizes a folder that is already the project’s clone', async () => {
      directories.add('/projects/widgets');
      directoryContents.set('/projects/widgets', ['.git', 'README.md']);
      gitRemoteMock.mockResolvedValue(REMOTE);

      await expect(inspectProjectFolder({
        orgId: 'org-1', teamProjectId: 'tp-primary', directoryPath: '/projects/widgets',
      })).resolves.toEqual({ kind: 'alreadyCloned' });
    });

    it('refuses a non-empty unrelated folder', async () => {
      directories.add('/projects/notes-scratch');
      directoryContents.set('/projects/notes-scratch', ['todo.md']);

      await expect(inspectProjectFolder({
        orgId: 'org-1', teamProjectId: 'tp-primary', directoryPath: '/projects/notes-scratch',
      })).resolves.toEqual({ kind: 'occupied' });
    });
  });

  /**
   * The end of the walk, and the whole point of it: whatever folder the user
   * ends up with has to make `findTeamForWorkspace` answer with the org.
   */
  describe('the folder resolves to the org afterwards', () => {
    it('binds a remote-less project and then resolves for that path', async () => {
      await expect(findTeamForWorkspace('/projects/notes')).resolves.toBeNull();

      const result = await joinOrgProjectWithFolder({
        orgId: 'org-1', teamProjectId: 'tp-notes', directoryPath: '/projects/notes',
      });

      expect(result).toEqual({ workspacePath: '/projects/notes', method: 'bind' });
      await expect(findTeamForWorkspace('/projects/notes')).resolves.toEqual(
        expect.objectContaining({ orgId: 'org-1', teamProjectId: 'tp-notes' }),
      );
    });

    // A repository-backed project is matched by its remote, so an existing
    // clone needs no binding at all -- recording one would give it two answers.
    it('accepts an existing clone without writing a binding', async () => {
      directories.add('/projects/widgets');
      directoryContents.set('/projects/widgets', ['.git']);
      gitRemoteMock.mockResolvedValue(REMOTE);

      const result = await joinOrgProjectWithFolder({
        orgId: 'org-1', teamProjectId: 'tp-primary', directoryPath: '/projects/widgets',
      });

      expect(result).toEqual({ workspacePath: '/projects/widgets', method: 'existing' });
      expect(workspaceStates.get('/projects/widgets')?.localOrgBinding).toBeUndefined();
      await expect(findTeamForWorkspace('/projects/widgets')).resolves.toEqual(
        expect.objectContaining({ orgId: 'org-1' }),
      );
    });

    it('refuses a folder that is not the repository the project is matched by', async () => {
      directories.add('/projects/unrelated');
      directoryContents.set('/projects/unrelated', ['notes.md']);

      await expect(joinOrgProjectWithFolder({
        orgId: 'org-1', teamProjectId: 'tp-primary', directoryPath: '/projects/unrelated',
      })).rejects.toThrow(/clone/i);
      expect(workspaceStates.get('/projects/unrelated')?.localOrgBinding).toBeUndefined();
    });
  });
});

describe('listTeams stampede on mid-flight invalidation (NIM-3711)', () => {
  /** Let queued microtasks (the fetch call, the cache settle handler) run. */
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

  /** A /api/teams response that does not resolve until the test releases it. */
  function gatedTeamsFetch(): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fetchMock.mockImplementation(async () => {
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          teams: [{
            orgId: 'org-1', name: 'Widgets Team', gitRemoteHash: REMOTE_HASH,
            createdAt: new Date().toISOString(), role: 'admin',
          }],
        }),
      };
    });
    return release;
  }

  beforeEach(() => {
    fetchMock.mockReset();
    invalidateListTeamsCache();
  });

  afterEach(async () => {
    await flush();
    invalidateListTeamsCache();
  });

  it('does not open a second request when the cache is invalidated mid-flight', async () => {
    const release = gatedTeamsFetch();

    const first = listTeams();
    await flush();
    expect(apiTeamsFetchCallCount()).toBe(1);

    // What actually happened at startup: fetchTeamApi refreshed an expiring
    // personal JWT, the refresh emitted an authenticated auth-state change,
    // and the change handler invalidated the directory cache -- while this
    // request was still on the wire. The next caller must join it, not race it.
    invalidateListTeamsCache();
    const second = listTeams();
    await flush();

    release();
    await Promise.all([first, second]);

    expect(apiTeamsFetchCallCount()).toBe(1);
  });

  it('does not cache an answer that was invalidated while in flight', async () => {
    const release = gatedTeamsFetch();

    const first = listTeams();
    await flush();
    invalidateListTeamsCache();
    release();
    await first;
    await flush();

    // The answer satisfied its joined callers, but it predates the
    // invalidation, so it must not be served to anyone new.
    await listTeams();
    expect(apiTeamsFetchCallCount()).toBe(2);
  });

  it('opens a fresh request for forceFresh callers even while one is on the wire', async () => {
    const release = gatedTeamsFetch();

    const background = listTeams();
    await flush();
    expect(apiTeamsFetchCallCount()).toBe(1);

    // The manual Refresh affordance asks for state that may have changed since
    // the outstanding request started, so joining it would defeat the point.
    const refreshed = listTeams({ forceFresh: true });
    await flush();
    expect(apiTeamsFetchCallCount()).toBe(2);

    release();
    await Promise.all([background, refreshed]);
  });
});
