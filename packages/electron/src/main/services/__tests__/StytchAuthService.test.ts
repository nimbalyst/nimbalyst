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

import {
  getAccounts,
  getPersonalSessionJwt,
  getSyncAccount,
  handleAuthCallback,
  initializeStytchAuth,
  isAuthenticated,
  onAuthStateChange,
  refreshPersonalSession,
  refreshPersonalSessionDetailed,
  refreshPersonalSessionForAccountDetailed,
  refreshSession,
  refreshSessionForAccount,
  refreshSessionForAccountDetailed,
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

describe('StytchAuthService auth-state-change dedupe (NIM-1828)', () => {
  beforeEach(async () => {
    await signOut();
    files.clear();
    fetchMock.mockReset();
  });

  it('does not re-emit auth-state-change when a refresh only rotates the token', async () => {
    const personalUserId = 'member-personal';
    const personalOrgId = 'org-personal';
    const initialJwt = createJwt({
      sub: personalUserId,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const rotatedJwt = createJwt({
      sub: personalUserId,
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    await handleAuthCallback({
      sessionToken: 'initial-session-token',
      sessionJwt: initialJwt,
      userId: personalUserId,
      orgId: personalOrgId,
    });

    // Subscribe AFTER sign-in. onAuthStateChange fires once immediately with the
    // current (authenticated) snapshot; count only emissions after that.
    const listener = vi.fn();
    onAuthStateChange(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    listener.mockClear();

    // Refresh returns the SAME identity (user_id + org_id) but a rotated token/JWT.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        session_token: 'rotated-session-token',
        session_jwt: rotatedJwt,
        user_id: personalUserId,
        org_id: personalOrgId,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    });

    await expect(refreshSession('https://sync.example')).resolves.toBe(true);

    // The token really rotated...
    expect(getPersonalSessionJwt()).toBe(rotatedJwt);
    // ...but the observable identity did not, so listeners must NOT be re-notified.
    expect(listener).not.toHaveBeenCalled();
  });

  it('still emits auth-state-change when the identity actually changes', async () => {
    const initialJwt = createJwt({
      sub: 'member-a',
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    await handleAuthCallback({
      sessionToken: 'token-a',
      sessionJwt: initialJwt,
      userId: 'member-a',
      orgId: 'org-a',
    });

    const listener = vi.fn();
    onAuthStateChange(listener);
    listener.mockClear();

    // Sign out is a real identity transition (authenticated -> not).
    await signOut();
    expect(listener).toHaveBeenCalled();
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

describe('StytchAuthService personal refresh outcome classification', () => {
  beforeEach(async () => {
    await signOut();
    files.clear();
    fetchMock.mockReset();
  });

  async function signInPersonal() {
    const personalUserId = 'member-personal';
    const personalOrgId = 'org-personal';
    await handleAuthCallback({
      sessionToken: 'session-token',
      sessionJwt: createJwt({ sub: personalUserId, exp: Math.floor(Date.now() / 1000) - 60 }),
      userId: personalUserId,
      orgId: personalOrgId,
    });
  }

  it('classifies an unreachable sync server as a network failure, not an auth failure', async () => {
    await signInPersonal();

    // Exactly what the live regression produced: the collab worker that serves
    // /auth/refresh was not listening, so net.fetch rejects at the transport level.
    fetchMock.mockRejectedValue(
      Object.assign(new Error('net::ERR_CONNECTION_REFUSED'), { code: 'ECONNREFUSED' }),
    );

    await expect(refreshPersonalSessionDetailed('http://localhost:8790')).resolves.toMatchObject({
      ok: false,
      reason: 'network',
    });
  });

  it('carries the transport error detail so the sync log can name it', async () => {
    await signInPersonal();

    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8790'), {
          code: 'ECONNREFUSED',
        }),
      }),
    );

    const outcome = await refreshPersonalSessionDetailed('ws://localhost:8790');
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ reason: 'network' });
    expect((outcome as { detail?: string }).detail).toContain('ECONNREFUSED');
    expect((outcome as { detail?: string }).detail).toContain('127.0.0.1:8790');
  });

  it('classifies a server-confirmed rejection as an auth failure', async () => {
    await signInPersonal();

    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'session expired' }),
    });

    await expect(refreshPersonalSessionDetailed('https://sync.example')).resolves.toMatchObject({
      ok: false,
      reason: 'auth',
    });
  });

  it('keeps the boolean wrapper behaviour for existing callers', async () => {
    await signInPersonal();
    fetchMock.mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));
    await expect(refreshPersonalSession('http://localhost:8790')).resolves.toBe(false);
  });
});

/**
 * `refreshSessionForAccount` used to reduce every failure to `null`: a server
 * that refused the account's session and a sync URL nothing was listening on
 * were indistinguishable to every caller, and its catch block logged the
 * transport failure as `Account refresh error`. Same collapse the personal path
 * was fixed for, on the multi-account branch.
 */
describe('StytchAuthService account refresh outcome classification', () => {
  const future = Date.now() + 60_000;

  function seedNonSyncAccount() {
    const syncAccount = {
      sessionToken: 'token-sync',
      sessionJwt: createJwt({ sub: 'member-sync' }),
      userId: 'member-sync',
      email: 'sync@example.com',
      expiresAt: future,
      orgId: 'personal-sync',
      personalOrgId: 'personal-sync',
      personalUserId: 'member-sync',
    };
    const otherAccount = {
      sessionToken: 'token-other',
      sessionJwt: createJwt({ sub: 'member-other' }),
      userId: 'member-other',
      email: 'other@example.com',
      expiresAt: future,
      orgId: 'personal-other',
      personalOrgId: 'personal-other',
      personalUserId: 'member-other',
    };
    files.set(
      '/mock/user-data/stytch-accounts.enc',
      Buffer.from(JSON.stringify({
        version: 3,
        syncAccountId: 'personal-sync',
        accounts: [syncAccount, otherAccount],
      })),
    );
    initializeStytchAuth({ projectId: 'test', publicToken: 'test', apiBase: 'https://test.invalid' });
  }

  beforeEach(async () => {
    await signOut();
    files.clear();
    fetchMock.mockReset();
    seedNonSyncAccount();
  });

  it('classifies an unreachable sync server as a network failure for a non-sync account', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8790'), { code: 'ECONNREFUSED' }),
      }),
    );

    const outcome = await refreshSessionForAccountDetailed('personal-other');
    expect(outcome).toMatchObject({ ok: false, reason: 'network' });
    expect((outcome as { detail?: string }).detail).toContain('ECONNREFUSED');
    expect((outcome as { detail?: string }).detail).toContain('127.0.0.1:8790');
  });

  it('classifies a server-confirmed rejection as an auth failure for a non-sync account', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: 'session expired' }) });

    await expect(refreshSessionForAccountDetailed('personal-other')).resolves.toMatchObject({
      ok: false,
      reason: 'auth',
    });
  });

  it('reports a missing session token as no-session rather than an auth failure', async () => {
    await expect(refreshSessionForAccountDetailed('personal-unknown')).resolves.toMatchObject({
      ok: false,
      reason: 'no-session',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the nullable wrapper behaviour for existing callers', async () => {
    fetchMock.mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));
    await expect(refreshSessionForAccount('personal-other')).resolves.toBeNull();
  });

  it('returns the fresh JWT on success', async () => {
    const freshJwt = createJwt({ sub: 'member-other', exp: Math.floor(Date.now() / 1000) + 300 });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        session_token: 'token-other-2',
        session_jwt: freshJwt,
        user_id: 'member-other',
        expires_at: new Date(future).toISOString(),
      }),
    });

    await expect(refreshSessionForAccountDetailed('personal-other')).resolves.toEqual({
      ok: true,
      jwt: freshJwt,
    });
  });

  it('propagates the transport classification through the personal-account wrapper', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND sync.nimbalyst.com'), { code: 'ENOTFOUND' }),
      }),
    );

    const outcome = await refreshPersonalSessionForAccountDetailed('personal-other');
    expect(outcome).toMatchObject({ ok: false, reason: 'network' });
    expect((outcome as { detail?: string }).detail).toContain('ENOTFOUND');
  });
});

/**
 * The dangerous escalation in this area: a refresh that cannot reach the collab
 * server must never look like "your session ended". If a failed refresh cleared
 * credentials, pointing sync at an unreachable URL would silently sign the user
 * out -- turning a transport outage into a real, data-losing auth event.
 */
describe('StytchAuthService refresh failure does not clear credentials', () => {
  beforeEach(async () => {
    await signOut();
    files.clear();
    fetchMock.mockReset();
  });

  async function signInPersonal() {
    await handleAuthCallback({
      sessionToken: 'session-token',
      sessionJwt: createJwt({ sub: 'member-personal', exp: Math.floor(Date.now() / 1000) - 60 }),
      userId: 'member-personal',
      orgId: 'org-personal',
    });
  }

  /**
   * Assert on the PERSISTED credential files, not just the in-memory account
   * list: `clearStytchCredentials()` unlinks the credentials file while leaving
   * the accounts map intact, so an in-memory-only assertion passes even when
   * credentials have been destroyed on disk.
   */
  function credentialSnapshot() {
    return {
      files: [...files.keys()].sort(),
      accounts: getAccounts().length,
      syncOrg: getSyncAccount()?.personalOrgId ?? null,
      authenticated: isAuthenticated(),
      personalJwt: getPersonalSessionJwt(),
    };
  }

  it('keeps credentials after an unreachable-server refresh', async () => {
    await signInPersonal();
    const before = credentialSnapshot();
    expect(before.accounts).toBe(1);
    expect(before.authenticated).toBe(true);
    expect(before.files.length).toBeGreaterThan(0);

    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8790'), {
          code: 'ECONNREFUSED',
        }),
      }),
    );

    // Hammer it the way a reconnect loop against a dead localhost:8790 would.
    for (let i = 0; i < 5; i++) {
      await refreshPersonalSessionDetailed('ws://localhost:8790');
      await refreshSession('ws://localhost:8790').catch(() => undefined);
    }

    expect(credentialSnapshot()).toEqual(before);
  });

  it('keeps credentials even after a server-confirmed 401', async () => {
    await signInPersonal();
    const before = credentialSnapshot();

    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'session expired' }),
    });

    await refreshPersonalSessionDetailed('https://sync.example');
    await refreshSession('https://sync.example').catch(() => undefined);

    // Auto-signOut on 401 was removed deliberately: background refreshes were
    // nuking credentials out from under share handlers. Only an explicit
    // signOut()/removeAccount() may clear them.
    expect(credentialSnapshot()).toEqual(before);
  });
});
