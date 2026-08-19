import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  queryMock,
  fetchMock,
  canAccessMock,
  getPersonalSessionJwtForAccountMock,
  getSessionTokenForAccountMock,
  files,
  handlers,
  authState,
  databaseState,
  workspaceStates,
  windowSendMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  fetchMock: vi.fn(),
  files: new Map<string, Buffer>(),
  handlers: new Map<string, (...args: any[]) => any>(),
  workspaceStates: new Map<string, any>(),
  windowSendMock: vi.fn(),
  authState: {
    syncPersonalOrgId: 'personal-bound',
    accounts: [] as Array<{ personalOrgId: string; personalUserId: string; email: string }>,
  },
  databaseState: {
    bindings: [] as Array<{ personal_org_id: string; team_org_id: string; team_member_id: string }>,
    emailMembers: new Map<string, string[]>(),
    orgs: [] as Array<{ id: string; flavor: string }>,
    members: [] as Array<{ org_id: string; user_id: string; email: string | null; role: string }>,
  },
  canAccessMock: vi.fn(async (_db: unknown, viewer: { teamMemberId?: string; personalMemberId?: string }) => ({
    allowed: viewer.teamMemberId === 'team-member-bound',
    orgRole: viewer.teamMemberId === 'team-member-bound' ? 'member' : null,
    projectRole: null,
    reason: viewer.teamMemberId === 'team-member-bound' ? 'org-member' : 'not-a-member',
  })),
  getPersonalSessionJwtForAccountMock: vi.fn((personalOrgId: string) => `personal-jwt:${personalOrgId}`),
  getSessionTokenForAccountMock: vi.fn((personalOrgId: string) => `session-token:${personalOrgId}`),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user-data') },
  BrowserWindow: class {
    static getAllWindows() { return [{ webContents: { send: windowSendMock } }]; }
  },
  net: { fetch: fetchMock },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
  shell: { openExternal: vi.fn() },
}));
vi.mock('fs', () => ({
  existsSync: vi.fn((filePath: string) => files.has(filePath)),
  readFileSync: vi.fn((filePath: string) => files.get(filePath)),
  writeFileSync: vi.fn((filePath: string, data: string | Buffer) => {
    files.set(filePath, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }),
  unlinkSync: vi.fn((filePath: string) => files.delete(filePath)),
}));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
    handlers.set(channel, handler);
  }),
  safeOn: vi.fn(),
}));
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
const gitRemoteFnMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/gitUtils', () => ({
  getNormalizedGitRemote: gitRemoteFnMock,
  getRawGitRemote: gitRemoteFnMock,
  normalizeGitRemote: (url: string | null) => url,
  getGitRemoteIdentities: async (workspacePath: string) => {
    const remote = await gitRemoteFnMock(workspacePath);
    return remote ? { canonical: remote, legacy: remote } : null;
  },
}));
vi.mock('../teamProjectResolver', () => ({ resolveTeamForRemoteHash: vi.fn() }));
vi.mock('../../utils/collabSyncUrl', () => ({ getCollabSyncHttpUrl: () => 'https://sync.test' }));
vi.mock('../jwtOrg', () => ({
  assertJwtMatchesOrg: vi.fn(),
  getJwtExp: vi.fn(),
  AuthContextMismatchError: class AuthContextMismatchError extends Error {},
}));
vi.mock('../StytchAuthService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../StytchAuthService')>();
  return {
    ...actual,
    getAccounts: vi.fn(() => authState.accounts),
    getPersonalSessionJwt: vi.fn(),
    getPersonalSessionJwtForAccount: getPersonalSessionJwtForAccountMock,
    getSessionToken: vi.fn(),
    getSessionTokenForAccount: getSessionTokenForAccountMock,
    isAuthenticated: vi.fn(() => true),
    refreshPersonalSession: vi.fn(),
    refreshPersonalSessionForAccount: vi.fn(),
    onAuthStateChange: vi.fn(() => () => {}),
    updateSessionToken: vi.fn(),
    getStytchUserId: vi.fn(() => 'ambient-team-member'),
    getUserEmail: vi.fn(() => null),
    getPersonalOrgId: vi.fn(() => authState.syncPersonalOrgId),
    getPersonalUserId: vi.fn(() => 'personal-member'),
  };
});
vi.mock('@nimbalyst/runtime', () => ({
  STYTCH_CONFIG: {
    live: { projectId: 'test', publicToken: 'test', apiBase: 'https://test.invalid' },
  },
  asPersonalJwt: (jwt: string) => jwt,
  asPersonalMemberId: (id: string) => id,
  asTeamJwt: (jwt: string) => jwt,
  asTeamMemberId: (id: string) => id,
}));
vi.mock('../../utils/store', () => ({
  getSessionSyncConfig: vi.fn(() => ({ serverUrl: 'https://sync.example' })),
  setSessionSyncConfig: vi.fn(),
  clearOrgWalkPreferences: vi.fn(),
  getWorkspaceState: (workspacePath: string) => workspaceStates.get(workspacePath) ?? {},
  updateWorkspaceState: (workspacePath: string, updater: (state: any) => void) => {
    const state = workspaceStates.get(workspacePath) ?? {};
    updater(state);
    workspaceStates.set(workspacePath, state);
    return state;
  },
}));
vi.mock('../analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));
vi.mock('../../database/initialize', () => ({
  getDatabase: () => ({ query: queryMock }),
}));
// OrgProjectionService is pure over the ProjectionDb interface, so the real
// module runs against queryMock and the projection writes stay assertable.
vi.mock('../OrgAccessResolver', () => ({ canAccess: canAccessMock }));
vi.mock('../TeamCustodyService', () => ({
  setTeamServerManagedCustody: vi.fn(async () => {}),
  registerTeamCustodyHandlers: vi.fn(),
}));
vi.mock('../TrackerSyncManager', () => ({}));
vi.mock('../CollabBackupService', () => ({}));
vi.mock('../TeamAuthBootstrap', () => ({ createTeamAuthBootstrap: (fn: unknown) => fn }));

import {
  getSyncAccount,
  initializeStytchAuth,
  setSyncAccount,
  signOut,
} from '../StytchAuthService';
import { canAccessForCurrentUser, getOrgScopedJwt, registerTeamHandlers } from '../TeamService';
import { getNormalizedGitRemote } from '../../utils/gitUtils';

describe('TeamService account-to-org viewer binding', () => {
  beforeEach(async () => {
    await signOut();
    vi.clearAllMocks();
    files.clear();
    authState.syncPersonalOrgId = 'personal-bound';
    authState.accounts = [
      { personalOrgId: 'personal-bound', personalUserId: 'personal-member-bound', email: 'bound@example.com' },
      { personalOrgId: 'personal-sync', personalUserId: 'personal-member-sync', email: 'sync@example.com' },
    ];
    files.set('/mock/user-data/stytch-accounts.enc', Buffer.from(JSON.stringify({
      version: 3,
      syncAccountId: 'personal-bound',
      accounts: authState.accounts.map((account) => ({
        sessionToken: `session-token:${account.personalOrgId}`,
        sessionJwt: 'header.payload.signature',
        userId: account.personalUserId,
        email: account.email,
        expiresAt: Date.now() + 60_000,
        orgId: account.personalOrgId,
        personalOrgId: account.personalOrgId,
        personalUserId: account.personalUserId,
      })),
    })));
    initializeStytchAuth({
      projectId: 'test',
      publicToken: 'test',
      apiBase: 'https://test.invalid',
    });
    databaseState.bindings = [
      { personal_org_id: 'personal-bound', team_org_id: 'team-org', team_member_id: 'team-member-bound' },
    ];
    databaseState.emailMembers.clear();
    databaseState.orgs = [];
    databaseState.members = [];
    handlers.clear();
    registerTeamHandlers();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        sessionJwt: 'team-jwt',
        sessionToken: 'next-session-token',
        bindingRecorded: false,
      }),
    });
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT team_member_id FROM account_org_bindings')) {
        return {
          rows: databaseState.bindings
            .filter((binding) => binding.personal_org_id === params?.[0] && binding.team_org_id === params?.[1])
            .map((binding) => ({ team_member_id: binding.team_member_id })),
        };
      }
      if (normalized.startsWith('SELECT personal_org_id, team_member_id FROM account_org_bindings')) {
        return {
          rows: databaseState.bindings
            .filter((binding) => binding.team_org_id === params?.[0])
            .map((binding) => ({
              personal_org_id: binding.personal_org_id,
              team_member_id: binding.team_member_id,
            })),
        };
      }
      if (normalized.startsWith('INSERT INTO account_org_bindings')) {
        databaseState.bindings.push({
          personal_org_id: params?.[0] as string,
          team_org_id: params?.[1] as string,
          team_member_id: params?.[2] as string,
        });
        return { rows: [] };
      }
      if (normalized.startsWith('INSERT INTO orgs')) {
        databaseState.orgs.push({ id: params?.[0] as string, flavor: params?.[3] as string });
        return { rows: [] };
      }
      if (normalized.startsWith('INSERT INTO org_members')) {
        databaseState.members.push({
          org_id: params?.[0] as string,
          user_id: params?.[1] as string,
          email: (params?.[2] as string) ?? null,
          role: params?.[3] as string,
        });
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT id FROM orgs')) {
        return { rows: databaseState.orgs.filter((org) => org.id === params?.[0]).map((org) => ({ id: org.id })) };
      }
      if (normalized.startsWith('SELECT outcome FROM account_org_binding_repairs')) return { rows: [] };
      if (normalized.startsWith('SELECT user_id FROM org_members')) {
        const key = `${params?.[0]}:${String(params?.[1]).toLowerCase()}`;
        return { rows: (databaseState.emailMembers.get(key) ?? []).map((user_id) => ({ user_id })) };
      }
      return { rows: [] };
    });
  });

  it('resolves the active account viewer from the stored binding without an email match', async () => {
    const result = await canAccessForCurrentUser({ orgId: 'team-org', action: 'view' });

    expect(result.allowed).toBe(true);
    expect(canAccessMock).toHaveBeenCalledWith(
      expect.anything(),
      { teamMemberId: 'team-member-bound' },
      { orgId: 'team-org', action: 'view' },
    );
  });

  it('uses the sole signed-in account for an org JWT when no binding or discovery hint exists', async () => {
    authState.accounts = [
      { personalOrgId: 'personal-only', personalUserId: 'personal-member-only', email: 'only@example.com' },
    ];
    databaseState.bindings = [];

    await expect(getOrgScopedJwt('team-org-single')).resolves.toBe('team-jwt');

    expect(getPersonalSessionJwtForAccountMock).toHaveBeenCalledWith('personal-only');
    expect(getSessionTokenForAccountMock).toHaveBeenCalledWith('personal-only');
  });

  it('repairs a missing org JWT binding from the sole matching account email', async () => {
    databaseState.bindings = [];
    databaseState.emailMembers.set('team-org-repair:sync@example.com', ['team-member-sync']);

    await expect(getOrgScopedJwt('team-org-repair')).resolves.toBe('team-jwt');

    expect(databaseState.bindings).toContainEqual({
      personal_org_id: 'personal-sync',
      team_org_id: 'team-org-repair',
      team_member_id: 'team-member-sync',
    });
    expect(getPersonalSessionJwtForAccountMock).toHaveBeenCalledWith('personal-sync');
  });

  it('keeps the workspace org JWT bound when the sync account changes through setSyncAccount', async () => {
    expect(setSyncAccount('personal-bound')).toBe(true);
    expect(getSyncAccount()?.personalOrgId).toBe('personal-bound');
    await expect(getOrgScopedJwt('team-org', undefined, true)).resolves.toBe('team-jwt');

    expect(setSyncAccount('personal-sync')).toBe(true);
    expect(getSyncAccount()?.personalOrgId).toBe('personal-sync');
    await expect(getOrgScopedJwt('team-org', undefined, true)).resolves.toBe('team-jwt');

    expect(getPersonalSessionJwtForAccountMock).toHaveBeenNthCalledWith(1, 'personal-bound');
    expect(getPersonalSessionJwtForAccountMock).toHaveBeenNthCalledWith(2, 'personal-bound');
    expect(getSessionTokenForAccountMock).toHaveBeenNthCalledWith(1, 'personal-bound');
    expect(getSessionTokenForAccountMock).toHaveBeenNthCalledWith(2, 'personal-bound');
  });

  /**
   * NIM-2466. Stytch's `sessions/exchange` REVOKES the session token it consumes,
   * so the replacement returned by `/switch` is the account's only live token. It
   * used to be dropped whenever the exchange named an account explicitly -- which
   * the org-creation wizard always does. Every later call for that account then
   * 401s: `listTeams` returns nothing, the account menu falls back to
   * "No organization", and the org projection can never be backfilled.
   */
  function storedSessionToken(personalOrgId: string): string | undefined {
    const raw = files.get('/mock/user-data/stytch-accounts.enc');
    if (!raw) return undefined;
    const parsed = JSON.parse(raw.toString('utf8')) as {
      accounts: Array<{ personalOrgId?: string; sessionToken?: string }>;
    };
    return parsed.accounts.find((account) => account.personalOrgId === personalOrgId)?.sessionToken;
  }

  it('persists the exchanged session token for the account that owns the exchange', async () => {
    // forceRefresh: earlier cases in this file leave 'team-org' cached.
    await expect(getOrgScopedJwt('team-org', 'personal-bound', true)).resolves.toBe('team-jwt');

    expect(storedSessionToken('personal-bound')).toBe('next-session-token');
    // The other signed-in account never took part in this exchange.
    expect(storedSessionToken('personal-sync')).toBe('session-token:personal-sync');
  });

  it('does not overwrite the sync account token when a secondary account exchanges', async () => {
    databaseState.bindings = [
      { personal_org_id: 'personal-sync', team_org_id: 'team-org-secondary', team_member_id: 'team-member-sync' },
    ];

    await expect(getOrgScopedJwt('team-org-secondary')).resolves.toBe('team-jwt');

    expect(storedSessionToken('personal-sync')).toBe('next-session-token');
    expect(storedSessionToken('personal-bound')).toBe('session-token:personal-bound');
  });

  /**
   * NIM-2466. Org creation used to end at the server round trip, leaving the
   * local catalog to a later sync. When that sync could not run, nothing ever
   * wrote the org, so `canAccess` had no membership to resolve against for an
   * org the user had just created. Mint the projection with the create.
   */
  it('mints the local org and creator membership when an organization is created', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.endsWith('/api/teams')
        ? {
          orgId: 'org-new',
          name: 'Acme',
          creatorMemberId: 'member-new',
          teamMemberId: 'member-new',
          owningPersonalOrgId: 'personal-bound',
        }
        : { sessionJwt: 'team-jwt', sessionToken: 'next-session-token', bindingRecorded: false }),
    }));

    const result = await handlers.get('team:create')!({}, 'Acme', undefined, 'personal-bound');

    expect(result.success).toBe(true);
    expect(databaseState.orgs).toContainEqual({ id: 'org-new', flavor: 'team' });
    expect(databaseState.members).toContainEqual({
      org_id: 'org-new',
      user_id: 'member-new',
      email: 'bound@example.com',
      // The server records the creator as 'admin'; the local row must agree so a
      // later roster sync is a no-op rather than a role flip.
      role: 'admin',
    });
  });

  /**
   * A workspace resolves to its org by git-remote hash. A folder with no remote
   * produces no hash, so the org it was just created from could never be matched
   * back to it -- the profile popover read "No organization" forever, across
   * restarts. Record the org locally instead.
   */
  it('records a local org binding when the creating project has no git remote', async () => {
    workspaceStates.clear();
    vi.mocked(getNormalizedGitRemote).mockResolvedValue(null as never);
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.endsWith('/api/teams')
        ? {
          orgId: 'org-new',
          name: 'Acme',
          creatorMemberId: 'member-new',
          teamMemberId: 'member-new',
          owningPersonalOrgId: 'personal-bound',
        }
        : { sessionJwt: 'team-jwt', sessionToken: 'next-session-token', bindingRecorded: false }),
    }));

    await handlers.get('team:create')!({}, 'Acme', '/projects/plain-folder', 'personal-bound');

    expect(workspaceStates.get('/projects/plain-folder')?.localOrgBinding).toEqual({ orgId: 'org-new' });
  });

  /**
   * Adding a remote-less project to an org used to be blocked outright, because
   * nothing could match the workspace back to the project the server minted.
   * The binding names the project, not just the org, so the workspace routes to
   * the room it was actually added as.
   */
  it('records the project a remote-less workspace was added to', async () => {
    workspaceStates.clear();
    vi.mocked(getNormalizedGitRemote).mockResolvedValue(null as never);
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.endsWith('/projects')
        ? { projectId: 'proj-1', teamProjectId: 'tp-1' }
        : { sessionJwt: 'team-jwt', sessionToken: 'next-session-token', bindingRecorded: false }),
    }));

    const result = await handlers.get('team:add-project')!({}, 'team-org', '/projects/plain-folder');
    expect(result.success).toBe(true);

    expect(workspaceStates.get('/projects/plain-folder')?.localOrgBinding).toEqual({
      orgId: 'team-org',
      teamProjectId: 'tp-1',
    });
  });

  /**
   * The wizard runs in one window; the org row in every other open project
   * window resolves once and would keep offering "Set up" for the org that was
   * just created.
   */
  it('tells every window that the workspace organization changed', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.endsWith('/api/teams')
        ? {
          orgId: 'org-new',
          name: 'Acme',
          creatorMemberId: 'member-new',
          teamMemberId: 'member-new',
          owningPersonalOrgId: 'personal-bound',
        }
        : { sessionJwt: 'team-jwt', sessionToken: 'next-session-token', bindingRecorded: false }),
    }));

    await handlers.get('team:create')!({}, 'Acme', '/projects/plain-folder', 'personal-bound');

    expect(windowSendMock).toHaveBeenCalledWith('team:workspace-org-changed', {
      orgId: 'org-new',
      workspacePath: '/projects/plain-folder',
    });
  });

  it('leaves the local binding unset when the git remote can carry the association', async () => {
    workspaceStates.clear();
    vi.mocked(getNormalizedGitRemote).mockResolvedValue('github.com/acme/widgets' as never);
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.endsWith('/api/teams')
        ? {
          orgId: 'org-new',
          name: 'Acme',
          creatorMemberId: 'member-new',
          teamMemberId: 'member-new',
          owningPersonalOrgId: 'personal-bound',
        }
        : { sessionJwt: 'team-jwt', sessionToken: 'next-session-token', bindingRecorded: false }),
    }));

    await handlers.get('team:create')!({}, 'Acme', '/projects/with-remote', 'personal-bound');

    expect(workspaceStates.get('/projects/with-remote')?.localOrgBinding).toBeUndefined();
  });
});
