import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Opening the org management window for an organization discovered through a
 * SECONDARY login must authenticate as that login. The two-JWT rule (see
 * packages/runtime/src/auth/jwtScopes.ts) makes a wrong-account team JWT a
 * silent "you are not a member" — the org window would load empty, or worse,
 * act against the sync account's identity.
 */

const { fetchMock, safeHandleMock, handlers, resolveTeamOrgAccountBindingMock } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    fetchMock: vi.fn(),
    handlers,
    safeHandleMock: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler);
    }),
    resolveTeamOrgAccountBindingMock: vi.fn(async () => null as null | { personalOrgId: string; teamMemberId: string }),
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

vi.mock('../../utils/gitUtils', () => ({ getNormalizedGitRemote: vi.fn(async () => null) }));
vi.mock('../teamProjectResolver', () => ({ resolveTeamForRemoteHash: () => null }));
vi.mock('../../utils/collabSyncUrl', () => ({ getCollabSyncHttpUrl: () => 'https://sync.test' }));

vi.mock('../jwtOrg', () => ({
  assertJwtMatchesOrg: vi.fn(),
  getJwtExp: vi.fn(() => Math.floor(Date.now() / 1000) + 300),
  AuthContextMismatchError: class AuthContextMismatchError extends Error {},
}));

const SYNC_ACCOUNT = 'personal-sync';
const SECONDARY_ACCOUNT = 'personal-secondary';

vi.mock('../StytchAuthService', () => ({
  getAccounts: vi.fn(() => [
    { personalOrgId: SYNC_ACCOUNT, email: 'sync@test.com' },
    { personalOrgId: SECONDARY_ACCOUNT, email: 'second@test.com' },
  ]),
  getPersonalSessionJwt: vi.fn(() => 'sync-personal-jwt'),
  getPersonalSessionJwtForAccount: vi.fn((accountOrgId: string) => `${accountOrgId}-personal-jwt`),
  getSessionToken: vi.fn(() => 'sync-session-token'),
  getSessionTokenForAccount: vi.fn((accountOrgId: string) => `${accountOrgId}-session-token`),
  isAuthenticated: vi.fn(() => true),
  refreshSession: vi.fn(async () => false),
  refreshSessionForAccount: vi.fn(async () => null),
  refreshPersonalSessionForAccount: vi.fn(async () => null),
  onAuthStateChange: vi.fn(() => () => {}),
  updateSessionToken: vi.fn(),
  getStytchUserId: vi.fn(() => 'user-1'),
  getUserEmail: vi.fn(() => 'sync@test.com'),
  getPersonalOrgId: vi.fn(() => SYNC_ACCOUNT),
  getPersonalUserId: vi.fn(() => 'user-1'),
}));

vi.mock('@nimbalyst/runtime', () => ({
  asPersonalJwt: (jwt: string) => jwt,
  asTeamJwt: (jwt: string) => jwt,
}));

vi.mock('../../database/initialize', () => ({ getDatabase: () => ({ query: vi.fn(async () => ({ rows: [] })) }) }));
vi.mock('../AccountOrgBindingService', () => ({
  resolveTeamOrgAccountBinding: resolveTeamOrgAccountBindingMock,
  repairAccountOrgBindingFromEmail: vi.fn(async () => 'no-match'),
  upsertAccountOrgBinding: vi.fn(async () => {}),
  resolveAccountOrgBinding: vi.fn(async () => null),
}));
vi.mock('../OrgProjectionService', () => ({}));
vi.mock('../OrgAccessResolver', () => ({}));
vi.mock('../OrgKeyService', () => ({}));
vi.mock('../KeyRotationService', () => ({}));
vi.mock('../TrackerSyncManager', () => ({}));
vi.mock('../CollabBackupService', () => ({}));
vi.mock('../SilentTeamEncryptionMigration', () => ({}));
vi.mock('../TeamAuthBootstrap', () => ({ createTeamAuthBootstrap: (fn: unknown) => fn }));

import {
  getOrgScopedJwt,
  getTeamMigrationFinalizationStatus,
  invalidateListTeamsCache,
} from '../TeamService';
import { getPersonalSessionJwtForAccount, getSessionTokenForAccount } from '../StytchAuthService';

const SECONDARY_ORG = 'org-owned-by-secondary';

function mockSwitchExchange() {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith(`/api/teams/${SECONDARY_ORG}/switch`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ sessionJwt: 'secondary-team-jwt', sessionToken: 'secondary-team-token' }),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe('getOrgScopedJwt account binding (two-JWT rule)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    handlers.clear();
    invalidateListTeamsCache();
    resolveTeamOrgAccountBindingMock.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    invalidateListTeamsCache();
  });

  it('exchanges with the secondary login that owns the org, not the sync account', async () => {
    resolveTeamOrgAccountBindingMock.mockResolvedValue({
      personalOrgId: SECONDARY_ACCOUNT,
      teamMemberId: 'secondary-team-member',
    });
    mockSwitchExchange();

    const jwt = await getOrgScopedJwt(SECONDARY_ORG);

    expect(jwt).toBe('secondary-team-jwt');
    expect(getSessionTokenForAccount).toHaveBeenCalledWith(SECONDARY_ACCOUNT);
    expect(getPersonalSessionJwtForAccount).toHaveBeenCalledWith(SECONDARY_ACCOUNT);
    expect(getSessionTokenForAccount).not.toHaveBeenCalledWith(SYNC_ACCOUNT);
    expect(getPersonalSessionJwtForAccount).not.toHaveBeenCalledWith(SYNC_ACCOUNT);

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(init.headers.Authorization).toBe(`Bearer ${SECONDARY_ACCOUNT}-personal-jwt`);
    expect(JSON.parse(init.body).sessionToken).toBe(`${SECONDARY_ACCOUNT}-session-token`);
  });

  it('refuses to fall back to the sync account when no binding identifies the org', async () => {
    mockSwitchExchange();

    await expect(getOrgScopedJwt('org-with-no-binding')).rejects.toThrow(/No signed-in account binding/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets background migration verification exceed the normal 15 second API deadline', async () => {
    vi.useFakeTimers();
    const orgId = 'org-with-many-documents';
    resolveTeamOrgAccountBindingMock.mockResolvedValue({
      personalOrgId: SECONDARY_ACCOUNT,
      teamMemberId: 'secondary-team-member',
    });
    let migrationSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (url: string, init?: { signal?: AbortSignal }) => {
      if (url.endsWith(`/api/teams/${orgId}/switch`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessionJwt: 'long-migration-team-jwt', sessionToken: 'long-migration-team-token' }),
        };
      }
      if (url.endsWith(`/api/teams/${orgId}/migration-finalization-status`)) {
        migrationSignal = init?.signal;
        return new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
          setTimeout(() => resolve({
            ok: true,
            status: 200,
            json: async () => ({
              mode: 'server-managed',
              complete: true,
              pendingDocumentIds: [],
              staleTitleDocumentIds: [],
              failedDocumentIds: [],
              documentsChecked: 500,
              finalizedAt: '2026-07-23T06:00:00.000Z',
            }),
          }), 20_000);
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const statusPromise = getTeamMigrationFinalizationStatus(orgId);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(migrationSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);

    await expect(statusPromise).resolves.toMatchObject({
      complete: true,
      documentsChecked: 500,
    });
  });
});
