import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  queryMock,
  fetchMock,
  canAccessMock,
  getPersonalSessionJwtForAccountMock,
  getSessionTokenForAccountMock,
  files,
  authState,
  databaseState,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  fetchMock: vi.fn(),
  files: new Map<string, Buffer>(),
  authState: {
    syncPersonalOrgId: 'personal-bound',
    accounts: [] as Array<{ personalOrgId: string; personalUserId: string; email: string }>,
  },
  databaseState: {
    bindings: [] as Array<{ personal_org_id: string; team_org_id: string; team_member_id: string }>,
    emailMembers: new Map<string, string[]>(),
  },
  canAccessMock: vi.fn(async (_db: unknown, viewerUserId: string) => ({
    allowed: viewerUserId === 'team-member-bound',
    orgRole: viewerUserId === 'team-member-bound' ? 'member' : null,
    projectRole: null,
    reason: viewerUserId === 'team-member-bound' ? 'org-member' : 'not-a-member',
  })),
  getPersonalSessionJwtForAccountMock: vi.fn((personalOrgId: string) => `personal-jwt:${personalOrgId}`),
  getSessionTokenForAccountMock: vi.fn((personalOrgId: string) => `session-token:${personalOrgId}`),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user-data') },
  BrowserWindow: class {},
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
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../../utils/gitUtils', () => ({ getNormalizedGitRemote: vi.fn() }));
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
}));
vi.mock('../../utils/store', () => ({
  getSessionSyncConfig: vi.fn(() => ({ serverUrl: 'https://sync.example' })),
  setSessionSyncConfig: vi.fn(),
}));
vi.mock('../analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));
vi.mock('../../database/initialize', () => ({
  getDatabase: () => ({ query: queryMock }),
}));
vi.mock('../OrgProjectionService', () => ({}));
vi.mock('../OrgAccessResolver', () => ({ canAccess: canAccessMock }));
vi.mock('../OrgKeyService', () => ({}));
vi.mock('../KeyRotationService', () => ({}));
vi.mock('../TrackerSyncManager', () => ({}));
vi.mock('../CollabBackupService', () => ({}));
vi.mock('../SilentTeamEncryptionMigration', () => ({ resetSilentMigrationScanState: vi.fn() }));
vi.mock('../TeamAuthBootstrap', () => ({ createTeamAuthBootstrap: (fn: unknown) => fn }));

import {
  getSyncAccount,
  initializeStytchAuth,
  setSyncAccount,
  signOut,
} from '../StytchAuthService';
import { canAccessForCurrentUser, getOrgScopedJwt } from '../TeamService';

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
      'team-member-bound',
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
});
