import { beforeEach, describe, expect, it, vi } from 'vitest';

const { files, fetchMock } = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  fetchMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user-data') },
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

vi.mock('@nimbalyst/runtime', () => ({
  STYTCH_CONFIG: {
    live: { projectId: 'test', publicToken: 'test', apiBase: 'https://test.invalid' },
  },
  asPersonalJwt: (jwt: string) => jwt,
  asPersonalMemberId: (id: string) => id,
}));

vi.mock('../../utils/store', () => ({
  getSessionSyncConfig: vi.fn(() => ({ serverUrl: 'https://sync.example' })),
  setSessionSyncConfig: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('../analytics/AnalyticsService', () => ({
  AnalyticsService: {
    getInstance: () => ({ sendEvent: vi.fn() }),
  },
}));

vi.mock('../SilentTeamEncryptionMigration', () => ({
  resetSilentMigrationScanState: vi.fn(),
}));

import {
  getAccounts,
  getPersonalSessionJwt,
  getSyncAccount,
  handleAuthCallback,
  initializeStytchAuth,
  refreshPersonalSession,
  refreshSession,
  setSyncAccount,
  signOut,
} from '../StytchAuthService';

function createJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

describe('StytchAuthService personal JWT refresh', () => {
  beforeEach(async () => {
    await signOut();
    files.clear();
    fetchMock.mockReset();
  });

  it('replaces an expired personal JWT after refreshing a personal-org session', async () => {
    const personalUserId = 'member-personal';
    const personalOrgId = 'org-personal';
    const expiredPersonalJwt = createJwt({
      sub: personalUserId,
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const freshPersonalJwt = createJwt({
      sub: personalUserId,
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await handleAuthCallback({
      sessionToken: 'stale-session-token',
      sessionJwt: expiredPersonalJwt,
      userId: personalUserId,
      orgId: personalOrgId,
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        session_token: 'fresh-session-token',
        session_jwt: freshPersonalJwt,
        user_id: personalUserId,
        org_id: personalOrgId,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    });

    expect(getPersonalSessionJwt()).toBe(expiredPersonalJwt);
    await expect(refreshSession('https://sync.example')).resolves.toBe(true);
    expect(getPersonalSessionJwt()).toBe(freshPersonalJwt);
  });

  it('exchanges back to the personal org with the latest session token after refreshing a team-scoped session', async () => {
    const personalUserId = 'member-personal';
    const teamUserId = 'member-team';
    const personalOrgId = 'org-personal';
    const teamOrgId = 'org-team';
    const expiredPersonalJwt = createJwt({
      sub: personalUserId,
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const teamJwt = createJwt({
      sub: teamUserId,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const refreshedTeamJwt = createJwt({
      sub: teamUserId,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const freshPersonalJwt = createJwt({
      sub: personalUserId,
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await handleAuthCallback({
      sessionToken: 'initial-session-token',
      sessionJwt: expiredPersonalJwt,
      userId: personalUserId,
      orgId: personalOrgId,
    });

    // Establish the real-world failure state: the active Stytch session has
    // been exchanged to a team org while personalSessionJwt remains expired.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session_token: 'team-session-token-before-personal-refresh',
        session_jwt: teamJwt,
        user_id: teamUserId,
        org_id: teamOrgId,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    });
    await expect(refreshSession('https://sync.example')).resolves.toBe(true);
    expect(getPersonalSessionJwt()).toBe(expiredPersonalJwt);

    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({
        session_token: 'latest-team-session-token',
        session_jwt: refreshedTeamJwt,
        user_id: teamUserId,
        org_id: teamOrgId,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    }));
    fetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { sessionToken?: string };
      if (body.sessionToken !== 'latest-team-session-token') {
        return { ok: false, status: 401 };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionToken: 'personal-session-token',
          sessionJwt: freshPersonalJwt,
        }),
      };
    });

    await expect(refreshPersonalSession('https://sync.example')).resolves.toBe(true);
    expect(getPersonalSessionJwt()).toBe(freshPersonalJwt);
  });
});

describe('StytchAuthService sync-account persistence', () => {
  beforeEach(async () => {
    await signOut();
    files.clear();
    fetchMock.mockReset();
  });

  it('loads the legacy primaryAccountId key as the sync account and rewrites the renamed key', () => {
    const future = Date.now() + 60_000;
    const accountA = {
      sessionToken: 'token-a',
      sessionJwt: createJwt({ sub: 'member-a' }),
      userId: 'member-a',
      email: 'a@example.com',
      expiresAt: future,
      orgId: 'personal-a',
      personalOrgId: 'personal-a',
      personalUserId: 'member-a',
    };
    const accountB = {
      sessionToken: 'token-b',
      sessionJwt: createJwt({ sub: 'member-b' }),
      userId: 'member-b',
      email: 'b@example.com',
      expiresAt: future,
      orgId: 'personal-b',
      personalOrgId: 'personal-b',
      personalUserId: 'member-b',
    };
    files.set(
      '/mock/user-data/stytch-accounts.enc',
      Buffer.from(JSON.stringify({
        version: 2,
        primaryAccountId: 'personal-b',
        accounts: [accountA, accountB],
      })),
    );

    initializeStytchAuth({
      projectId: 'test',
      publicToken: 'test',
      apiBase: 'https://test.invalid',
    });

    expect(getSyncAccount()?.personalOrgId).toBe('personal-b');
    expect(getAccounts().find((account) => account.personalOrgId === 'personal-b'))
      .toMatchObject({ isSyncAccount: true });

    expect(setSyncAccount('personal-a')).toBe(true);
    expect(getSyncAccount()?.personalOrgId).toBe('personal-a');

    const persisted = JSON.parse(
      files.get('/mock/user-data/stytch-accounts.enc')!.toString('utf8'),
    ) as Record<string, unknown>;
    expect(persisted).toMatchObject({ version: 3, syncAccountId: 'personal-a' });
    expect(persisted).not.toHaveProperty('primaryAccountId');
  });
});
