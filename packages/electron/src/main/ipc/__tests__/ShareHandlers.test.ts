import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

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

vi.mock('../../services/StytchAuthService', () => ({
  getSessionJwt: vi.fn(() => 'session-jwt'),
  refreshSession: vi.fn(async () => true),
}));

vi.mock('../../utils/store', () => ({
  store: { get: vi.fn(() => undefined), set: vi.fn() },
}));

import { getShareList, invalidateShareListCache } from '../ShareHandlers';

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body, text: async () => '' };
}

function shareListCallCount(): number {
  return fetchMock.mock.calls.filter((call: unknown[]) => typeof call[0] === 'string' && call[0].includes('/shares')).length;
}

describe('ShareHandlers share:list dedup', () => {
  beforeEach(() => {
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
