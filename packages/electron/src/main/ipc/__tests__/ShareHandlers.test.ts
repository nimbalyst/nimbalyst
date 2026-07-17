import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, accountState } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  accountState: { includeBound: false },
}));

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
  app: { getPath: vi.fn(() => '/tmp/nimbalyst-share-handlers-test-userdata') },
  net: { fetch: fetchMock },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    file: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: vi.fn(),
}));

vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: { get: vi.fn(async () => null) },
}));

vi.mock('../../services/SessionHtmlExporter', () => ({
  exportSessionToHtml: vi.fn(async () => '<html></html>'),
}));

vi.mock('../../utils/transcriptHelpers', () => ({
  loadViewMessages: vi.fn(async () => ({ success: true, messages: [] })),
}));

vi.mock('../../services/FileHtmlExporter', () => ({
  exportFileToHtml: vi.fn(() => '<html></html>'),
}));

vi.mock('../../services/StytchAuthService', () => ({
  getAccounts: vi.fn(() => [
    { personalOrgId: 'personal-sync', email: 'sync@example.com', isSyncAccount: true },
    ...(accountState.includeBound
      ? [{ personalOrgId: 'personal-bound', email: 'bound@example.com', isSyncAccount: false }]
      : []),
  ]),
  getSyncAccount: vi.fn(() => ({
    personalOrgId: 'personal-sync', email: 'sync@example.com', isSyncAccount: true,
  })),
  getPersonalSessionJwtForAccount: vi.fn(() => 'personal-jwt'),
  refreshPersonalSessionForAccount: vi.fn(async () => 'personal-jwt'),
  getSessionJwt: vi.fn(() => 'session-jwt'),
  refreshSession: vi.fn(async () => true),
}));

vi.mock('../../services/TeamService', () => ({
  findTeamForWorkspace: vi.fn(async (workspacePath: string) => (
    workspacePath === '/workspace/team'
      ? { orgId: 'team-org', boundPersonalOrgId: 'personal-bound' }
      : null
  )),
}));

vi.mock('../../utils/store', () => ({
  store: { get: vi.fn(() => undefined), set: vi.fn() },
}));

import {
  getShareList,
  invalidateShareListCache,
  resolveDefaultShareAccount,
} from '../ShareHandlers';

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body, text: async () => '' };
}

function shareListCallCount(): number {
  return fetchMock.mock.calls.filter((call: unknown[]) => typeof call[0] === 'string' && call[0].includes('/shares')).length;
}

describe('ShareHandlers share:list dedup', () => {
  beforeEach(() => {
    accountState.includeBound = false;
    invalidateShareListCache();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => jsonResponse({ shares: [] }));
  });

  afterEach(() => {
    invalidateShareListCache();
  });

  it('collapses N concurrent share:list calls into a single GET /shares', async () => {
    const results = await Promise.all([
      getShareList(),
      getShareList(),
      getShareList(),
      getShareList(),
      getShareList(),
    ]);

    expect(shareListCallCount()).toBe(1);
    for (const result of results) {
      expect(result).toEqual({ success: true, shares: [] });
    }
  });

  it('reuses the cached list for a call shortly after (within the TTL window)', async () => {
    await getShareList();
    await getShareList();

    expect(shareListCallCount()).toBe(1);
  });

  it('invalidateShareListCache forces the next call to refetch', async () => {
    await getShareList();
    invalidateShareListCache();
    await getShareList();

    expect(shareListCallCount()).toBe(2);
  });
});

describe('ShareHandlers account resolution', () => {
  it('defaults a team-workspace share to the account bound to its org', async () => {
    accountState.includeBound = true;
    await expect(resolveDefaultShareAccount('/workspace/team')).resolves.toMatchObject({
      personalOrgId: 'personal-bound',
      source: 'workspace-binding',
    });
  });

  it('defaults a personal share to the sync account', async () => {
    await expect(resolveDefaultShareAccount('/workspace/personal')).resolves.toMatchObject({
      personalOrgId: 'personal-sync',
      source: 'sync-account',
    });
  });
});
