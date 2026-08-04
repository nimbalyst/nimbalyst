import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { files, fetchMock, openExternalMock } = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  fetchMock: vi.fn(),
  openExternalMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user-data'), focus: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  net: { fetch: fetchMock },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
  shell: { openExternal: openExternalMock },
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
  getAuthState,
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
  setAuthCallbackSuccessHandler,
  setSyncAccount,
  sendMagicLink,
  signInWithGoogle,
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
      intent: 'sign-in',
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
      intent: 'sign-in',
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
      intent: 'sign-in',
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
      intent: 'sign-in',
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

describe('StytchAuthService callback replay', () => {
  beforeEach(async () => {
    await signOut();
    files.clear();
    fetchMock.mockReset();
  });

  it('updates the existing account instead of creating duplicate onboarding identity', async () => {
    const firstJwt = createJwt({
      sub: 'member-personal',
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const replayedJwt = createJwt({
      sub: 'member-personal',
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    await handleAuthCallback({
      intent: 'sign-in',
      sessionToken: 'first-token',
      sessionJwt: firstJwt,
      userId: 'member-personal',
      email: 'member@example.com',
      orgId: 'org-personal',
    });
    await handleAuthCallback({
      intent: 'reauth',
      targetPersonalOrgId: 'org-personal',
      sessionToken: 'replayed-token',
      sessionJwt: replayedJwt,
      userId: 'member-personal',
      email: 'member@example.com',
      orgId: 'org-personal',
    });

    expect(getAccounts()).toHaveLength(1);
    expect(getAccounts()[0]).toMatchObject({
      personalOrgId: 'org-personal',
      personalUserId: 'member-personal',
      email: 'member@example.com',
      isSyncAccount: true,
    });
    expect(getPersonalSessionJwt()).toBe(replayedJwt);
  });
});

describe('StytchAuthService explicit add-account intent regression', () => {
  beforeEach(async () => {
    await signOut();
    files.clear();
    fetchMock.mockReset();
  });

  it('keeps the expired sync account selected when an add-account callback succeeds', async () => {
    const expiredSyncAccount = {
      sessionToken: 'expired-sync-token',
      sessionJwt: createJwt({ sub: 'member-sync' }),
      userId: 'member-sync',
      email: 'sync@example.com',
      expiresAt: Date.now() - 60_000,
      orgId: 'personal-sync',
      personalOrgId: 'personal-sync',
      personalUserId: 'member-sync',
    };
    files.set(
      '/mock/user-data/stytch-accounts.enc',
      Buffer.from(JSON.stringify({
        version: 3,
        syncAccountId: 'personal-sync',
        accounts: [expiredSyncAccount],
      })),
    );
    initializeStytchAuth({
      projectId: 'test',
      publicToken: 'test',
      apiBase: 'https://test.invalid',
    });

    const authStateBefore = getAuthState();
    const syncAccountBefore = getSyncAccount();

    await handleAuthCallback({
      intent: 'add-account',
      sessionToken: 'new-account-token',
      sessionJwt: createJwt({ sub: 'member-new' }),
      userId: 'member-new',
      email: 'new@example.com',
      orgId: 'personal-new',
    });

    expect(getAccounts()).toHaveLength(2);
    expect(getAccounts()).toEqual(expect.arrayContaining([
      expect.objectContaining({ personalOrgId: 'personal-sync', isSyncAccount: true }),
      expect.objectContaining({ personalOrgId: 'personal-new', isSyncAccount: false }),
    ]));
    expect(getSyncAccount()).toEqual(syncAccountBefore);
    expect(getAuthState()).toEqual(authStateBefore);
  });
});

describe('StytchAuthService auth callback intent matrix', () => {
  beforeEach(async () => {
    await signOut();
    files.clear();
    fetchMock.mockReset();
  });

  async function seedTwoAccounts() {
    await handleAuthCallback({
      intent: 'sign-in',
      sessionToken: 'sync-token',
      sessionJwt: createJwt({ sub: 'member-sync' }),
      userId: 'member-sync',
      email: 'sync@example.com',
      orgId: 'personal-sync',
    });
    await handleAuthCallback({
      intent: 'add-account',
      sessionToken: 'secondary-token',
      sessionJwt: createJwt({ sub: 'member-secondary' }),
      userId: 'member-secondary',
      email: 'secondary@example.com',
      orgId: 'personal-secondary',
    });
  }

  function persistedAccounts() {
    return JSON.parse(files.get('/mock/user-data/stytch-accounts.enc')!.toString('utf8')) as {
      syncAccountId: string;
      accounts: Array<{ personalOrgId: string; sessionToken: string }>;
    };
  }

  it('sign-in creates the first account and selects it for sync', async () => {
    await handleAuthCallback({
      intent: 'sign-in',
      sessionToken: 'first-token',
      sessionJwt: createJwt({ sub: 'member-first' }),
      userId: 'member-first',
      email: 'first@example.com',
      orgId: 'personal-first',
    });

    expect(getAccounts()).toEqual([
      expect.objectContaining({ personalOrgId: 'personal-first', isSyncAccount: true }),
    ]);
    expect(getAuthState()).toMatchObject({
      isAuthenticated: true,
      sessionToken: 'first-token',
      personalOrgId: 'personal-first',
    });
    expect(persistedAccounts().syncAccountId).toBe('personal-first');
    expect(files.has('/mock/user-data/stytch-credentials.enc')).toBe(true);
  });

  it('add-account appends a new org without changing singleton or sync stores', async () => {
    await handleAuthCallback({
      intent: 'sign-in',
      sessionToken: 'sync-token',
      sessionJwt: createJwt({ sub: 'member-sync' }),
      userId: 'member-sync',
      orgId: 'personal-sync',
    });
    const authBefore = getAuthState();
    const legacyBefore = files.get('/mock/user-data/stytch-credentials.enc')!.toString('utf8');

    await handleAuthCallback({
      intent: 'add-account',
      sessionToken: 'new-token',
      sessionJwt: createJwt({ sub: 'member-new' }),
      userId: 'member-new',
      orgId: 'personal-new',
    });

    expect(getAccounts()).toHaveLength(2);
    expect(getSyncAccount()?.personalOrgId).toBe('personal-sync');
    expect(getAuthState()).toEqual(authBefore);
    expect(files.get('/mock/user-data/stytch-credentials.enc')!.toString('utf8')).toBe(legacyBefore);
  });

  it('add-account refreshes an existing org in place without changing singleton stores', async () => {
    await seedTwoAccounts();
    const authBefore = getAuthState();
    const legacyBefore = files.get('/mock/user-data/stytch-credentials.enc')!.toString('utf8');

    await handleAuthCallback({
      intent: 'add-account',
      sessionToken: 'secondary-token-refreshed',
      sessionJwt: createJwt({ sub: 'member-secondary' }),
      userId: 'member-secondary',
      email: 'secondary@example.com',
      orgId: 'personal-secondary',
    });

    expect(getAccounts()).toHaveLength(2);
    expect(getSyncAccount()?.personalOrgId).toBe('personal-sync');
    expect(getAuthState()).toEqual(authBefore);
    expect(files.get('/mock/user-data/stytch-credentials.enc')!.toString('utf8')).toBe(legacyBefore);
    expect(persistedAccounts().accounts.find((account) => account.personalOrgId === 'personal-secondary'))
      .toMatchObject({ sessionToken: 'secondary-token-refreshed' });
  });

  /**
   * The Share dialog and Sync panel both render the primary sign-in form
   * whenever the singleton session is gone, which includes a merely-expired
   * sync account. Coming back in through that path must revive the sync
   * account rather than leave the app looking signed out.
   */
  it('add-account on the sync account itself refreshes the singleton state without repointing sync', async () => {
    await seedTwoAccounts();

    await handleAuthCallback({
      intent: 'add-account',
      sessionToken: 'sync-token-refreshed',
      sessionJwt: createJwt({ sub: 'member-sync' }),
      userId: 'member-sync',
      email: 'sync@example.com',
      orgId: 'personal-sync',
    });

    expect(getAccounts()).toHaveLength(2);
    expect(getSyncAccount()?.personalOrgId).toBe('personal-sync');
    expect(getAuthState()).toMatchObject({
      isAuthenticated: true,
      sessionToken: 'sync-token-refreshed',
      personalOrgId: 'personal-sync',
    });
    expect(persistedAccounts().syncAccountId).toBe('personal-sync');
    expect(JSON.parse(files.get('/mock/user-data/stytch-credentials.enc')!.toString('utf8')))
      .toMatchObject({ sessionToken: 'sync-token-refreshed' });
    // The other account is untouched by the refresh.
    expect(persistedAccounts().accounts.find((entry) => entry.personalOrgId === 'personal-secondary'))
      .toMatchObject({ sessionToken: 'secondary-token' });
  });

  it('reauth updates singleton state only for the sync account', async () => {
    await seedTwoAccounts();

    await handleAuthCallback({
      intent: 'reauth',
      targetPersonalOrgId: 'personal-sync',
      sessionToken: 'sync-token-refreshed',
      sessionJwt: createJwt({ sub: 'member-sync' }),
      userId: 'member-sync',
      orgId: 'personal-sync',
    });

    expect(getSyncAccount()?.personalOrgId).toBe('personal-sync');
    expect(getAuthState().sessionToken).toBe('sync-token-refreshed');
    expect(JSON.parse(files.get('/mock/user-data/stytch-credentials.enc')!.toString('utf8')))
      .toMatchObject({ sessionToken: 'sync-token-refreshed' });
    expect(persistedAccounts().accounts.find((account) => account.personalOrgId === 'personal-secondary'))
      .toMatchObject({ sessionToken: 'secondary-token' });
  });

  /**
   * Stytch issues a different member id per org, so an account is identified by
   * (personal org, personal member). A callback that carries the same org with
   * another member is a different person's session: accepting it would silently
   * repoint the stored account's credentials at them.
   */
  it('rejects a reauth callback from a different member of the target org', async () => {
    await seedTwoAccounts();
    const authBefore = getAuthState();
    const persistedBefore = files.get('/mock/user-data/stytch-accounts.enc')!.toString('utf8');

    await expect(handleAuthCallback({
      intent: 'reauth',
      targetPersonalOrgId: 'personal-secondary',
      sessionToken: 'impostor-token',
      sessionJwt: createJwt({ sub: 'member-impostor' }),
      userId: 'member-impostor',
      email: 'impostor@example.com',
      orgId: 'personal-secondary',
    })).rejects.toThrow(/does not match the stored account/);

    expect(files.get('/mock/user-data/stytch-accounts.enc')!.toString('utf8')).toBe(persistedBefore);
    expect(getAuthState()).toEqual(authBefore);
    expect(getAccounts().find((account) => account.personalOrgId === 'personal-secondary'))
      .toMatchObject({ personalUserId: 'member-secondary', email: 'secondary@example.com' });
  });

  it('rejects an add-account callback from a different member of a stored org', async () => {
    await seedTwoAccounts();
    const authBefore = getAuthState();
    const persistedBefore = files.get('/mock/user-data/stytch-accounts.enc')!.toString('utf8');

    await expect(handleAuthCallback({
      intent: 'add-account',
      sessionToken: 'impostor-token',
      sessionJwt: createJwt({ sub: 'member-impostor' }),
      userId: 'member-impostor',
      email: 'impostor@example.com',
      orgId: 'personal-sync',
    })).rejects.toThrow(/does not match the stored account/);

    expect(files.get('/mock/user-data/stytch-accounts.enc')!.toString('utf8')).toBe(persistedBefore);
    expect(getAuthState()).toEqual(authBefore);
    expect(getAuthState().sessionToken).toBe('sync-token');
  });

  // Credentials stored before the account -> member binding existed have no id
  // to compare against, so the refresh is accepted and binds it.
  it('accepts a refresh for a legacy account with no bound member and backfills it', async () => {
    files.set(
      '/mock/user-data/stytch-accounts.enc',
      Buffer.from(JSON.stringify({
        version: 3,
        syncAccountId: 'personal-legacy',
        accounts: [{
          sessionToken: 'legacy-token',
          sessionJwt: createJwt({ sub: 'member-legacy' }),
          userId: '',
          email: 'legacy@example.com',
          expiresAt: Date.now() - 60_000,
          orgId: 'personal-legacy',
          personalOrgId: 'personal-legacy',
        }],
      })),
    );
    initializeStytchAuth({ projectId: 'test', publicToken: 'test', apiBase: 'https://test.invalid' });

    await handleAuthCallback({
      intent: 'reauth',
      targetPersonalOrgId: 'personal-legacy',
      sessionToken: 'legacy-token-refreshed',
      sessionJwt: createJwt({ sub: 'member-legacy' }),
      userId: 'member-legacy',
      email: 'legacy@example.com',
      orgId: 'personal-legacy',
    });

    expect(getAccounts()).toEqual([
      expect.objectContaining({ personalOrgId: 'personal-legacy', personalUserId: 'member-legacy' }),
    ]);
    expect(getAuthState().sessionToken).toBe('legacy-token-refreshed');
  });

  it('reauth updates only the accounts map for a secondary account', async () => {
    await seedTwoAccounts();
    const authBefore = getAuthState();
    const legacyBefore = files.get('/mock/user-data/stytch-credentials.enc')!.toString('utf8');

    await handleAuthCallback({
      intent: 'reauth',
      targetPersonalOrgId: 'personal-secondary',
      sessionToken: 'secondary-token-refreshed',
      sessionJwt: createJwt({ sub: 'member-secondary' }),
      userId: 'member-secondary',
      orgId: 'personal-secondary',
    });

    expect(getSyncAccount()?.personalOrgId).toBe('personal-sync');
    expect(getAuthState()).toEqual(authBefore);
    expect(files.get('/mock/user-data/stytch-credentials.enc')!.toString('utf8')).toBe(legacyBefore);
    expect(persistedAccounts().accounts.find((account) => account.personalOrgId === 'personal-secondary'))
      .toMatchObject({ sessionToken: 'secondary-token-refreshed' });
  });
});

describe('StytchAuthService outgoing auth flow URLs', () => {
  beforeEach(async () => {
    await signOut();
    files.clear();
    fetchMock.mockReset();
    openExternalMock.mockReset();
    initializeStytchAuth({ projectId: 'test', publicToken: 'test', apiBase: 'https://test.invalid' });
  });

  it('starts Google OAuth with a bare loopback client_redirect and separate state', async () => {
    await expect(signInWithGoogle('https://sync.example')).resolves.toEqual({ success: true });

    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    const callbackUrl = new URL(openedUrl.searchParams.get('client_redirect')!);
    expect(openedUrl.origin + openedUrl.pathname).toBe('https://sync.example/auth/login/google');
    expect(callbackUrl.hostname).toBe('127.0.0.1');
    expect(callbackUrl.pathname).toBe('/auth/callback');
    expect(callbackUrl.search).toBe('');
    expect(openedUrl.searchParams.get('state')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('posts a nonce-bearing loopback redirect and renews it on magic-link resend', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });

    await expect(sendMagicLink('user@example.com', 'https://sync.example')).resolves.toEqual({ success: true });
    await expect(sendMagicLink('user@example.com', 'https://sync.example')).resolves.toEqual({ success: true });

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { redirect_url: string };
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as { redirect_url: string };
    const callbackUrl = new URL(firstBody.redirect_url);
    expect(callbackUrl.hostname).toBe('127.0.0.1');
    expect(callbackUrl.pathname).toBe('/auth/callback');
    expect(callbackUrl.searchParams.get('state')).toMatch(/^[a-f0-9]{64}$/);
    expect(secondBody.redirect_url).toBe(firstBody.redirect_url);
  });
});

/**
 * The success handler registered by main rebuilds sync from the current config.
 * Every completed callback used to fire it, so adding a second account tore down
 * a healthy personal sync session that the callback never touched.
 */
describe('StytchAuthService sync reinitialization gating', () => {
  beforeEach(async () => {
    await signOut();
    files.clear();
    fetchMock.mockReset();
    openExternalMock.mockReset();
    initializeStytchAuth({ projectId: 'test', publicToken: 'test', apiBase: 'https://test.invalid' });
  });

  afterEach(() => {
    setAuthCallbackSuccessHandler(null);
  });

  async function signInSyncAccount() {
    await handleAuthCallback({
      intent: 'sign-in',
      sessionToken: 'sync-token',
      sessionJwt: createJwt({ sub: 'member-sync' }),
      userId: 'member-sync',
      email: 'sync@example.com',
      orgId: 'personal-sync',
    });
  }

  /** Deliver the callback to the loopback listener the flow just opened. */
  async function deliverCallback(
    params: Record<string, string>,
    method: 'GET' | 'POST',
  ): Promise<Response> {
    const opened = new URL(String(openExternalMock.mock.calls.at(-1)![0]));
    const callback = new URL(opened.searchParams.get('client_redirect')!);
    callback.searchParams.set('state', opened.searchParams.get('state')!);
    if (method === 'GET') {
      for (const [key, value] of Object.entries(params)) {
        callback.searchParams.set(key, value);
      }
      return fetch(callback.toString());
    }
    return fetch(callback.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  }

  it('does not reinitialize sync when a secondary account is added', async () => {
    await signInSyncAccount();
    const reinitialize = vi.fn();
    setAuthCallbackSuccessHandler(reinitialize);

    await expect(signInWithGoogle('https://sync.example', { intent: 'add-account' }))
      .resolves.toEqual({ success: true });
    const response = await deliverCallback({
      session_token: 'new-token',
      session_jwt: createJwt({ sub: 'member-new' }),
      user_id: 'member-new',
      email: 'new@example.com',
      org_id: 'personal-new',
    }, 'POST');

    expect(response.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(reinitialize).not.toHaveBeenCalled();
    expect(getAccounts()).toHaveLength(2);
    expect(getSyncAccount()?.personalOrgId).toBe('personal-sync');
  });

  it('reinitializes sync when the sync account itself reauthenticates', async () => {
    await signInSyncAccount();
    const reinitialize = vi.fn();
    setAuthCallbackSuccessHandler(reinitialize);

    await expect(signInWithGoogle('https://sync.example', {
      intent: 'reauth',
      targetPersonalOrgId: 'personal-sync',
    })).resolves.toEqual({ success: true });
    const response = await deliverCallback({
      session_token: 'sync-token-refreshed',
      session_jwt: createJwt({ sub: 'member-sync' }),
      user_id: 'member-sync',
      email: 'sync@example.com',
      org_id: 'personal-sync',
    }, 'GET');

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(reinitialize).toHaveBeenCalledOnce());
    expect(getAuthState().sessionToken).toBe('sync-token-refreshed');
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
      intent: 'sign-in',
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
      intent: 'sign-in',
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
