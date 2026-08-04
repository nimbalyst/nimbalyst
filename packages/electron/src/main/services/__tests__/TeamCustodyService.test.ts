import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TeamCustodyService is the only remaining reader of team key custody. Two
 * behaviours matter:
 *
 *  - The per-org TTL cache collapses concurrent settings reads into one GET
 *    and memoizes it for the window; a FAILED fetch must not be cached.
 *  - The mode parse is fail-closed: anything that is not the literal
 *    `server-managed` marker reads as `unmigrated`. An unknown value must
 *    never fall through to the permissive reading.
 */

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('electron', () => ({ net: { fetch: fetchMock } }));

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('../../utils/collabSyncUrl', () => ({ getCollabSyncHttpUrl: () => 'https://sync.test' }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../StytchAuthService', () => ({ isAuthenticated: vi.fn(() => true) }));
vi.mock('../TeamService', () => ({ getOrgScopedJwt: vi.fn(async () => 'org-jwt') }));

import {
  fetchTeamKeyStatus,
  invalidateTeamKeyStatusCache,
  setTeamServerManagedCustody,
} from '../TeamCustodyService';

function jsonResponse(body: unknown, ok = true, status = 200): any {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('TeamCustodyService', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    invalidateTeamKeyStatusCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('fail-closed mode parse', () => {
    it('reads the explicit server-managed marker', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ mode: 'server-managed', dekEpoch: 3, dekFingerprint: 'fp-1' }),
      );

      await expect(fetchTeamKeyStatus('org-1', 'jwt')).resolves.toEqual({
        mode: 'server-managed',
        dekEpoch: 3,
        dekFingerprint: 'fp-1',
      });
    });

    const NON_SERVER_MANAGED: Array<[unknown, string]> = [
      ['legacy-e2e', 'the retired client-managed marker'],
      ['unmigrated', 'the explicit unmigrated marker'],
      ['SERVER-MANAGED', 'a case variant'],
      [undefined, 'a missing mode'],
      [null, 'a null mode'],
      ['something-new', 'an unknown future value'],
    ];

    it.each(NON_SERVER_MANAGED)('treats %s as unmigrated (%s)', async (mode) => {
      fetchMock.mockResolvedValue(jsonResponse({ mode }));

      const status = await fetchTeamKeyStatus('org-1', 'jwt');
      expect(status.mode).toBe('unmigrated');
      expect(status.dekEpoch).toBeNull();
      expect(status.dekFingerprint).toBeNull();
    });

    it('rejects rather than guessing a mode when the server errors', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, false, 503));

      await expect(fetchTeamKeyStatus('org-1', 'jwt')).rejects.toThrow(/503/);
    });
  });

  describe('TTL cache', () => {
    it('collapses concurrent reads for the same org into one GET', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ mode: 'server-managed' }));

      const results = await Promise.all([
        fetchTeamKeyStatus('org-1', 'jwt'),
        fetchTeamKeyStatus('org-1', 'jwt'),
        fetchTeamKeyStatus('org-1', 'jwt'),
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(results.every((r) => r.mode === 'server-managed')).toBe(true);
    });

    it('keys the cache per org', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ mode: 'server-managed' }));

      await fetchTeamKeyStatus('org-1', 'jwt');
      await fetchTeamKeyStatus('org-2', 'jwt');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain('/api/teams/org-1/key-status');
      expect(fetchMock.mock.calls[1][0]).toContain('/api/teams/org-2/key-status');
    });

    it('re-fetches once the 60s TTL expires', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(jsonResponse({ mode: 'server-managed' }));

      await fetchTeamKeyStatus('org-1', 'jwt');
      vi.advanceTimersByTime(59_000);
      await fetchTeamKeyStatus('org-1', 'jwt');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2_000);
      await fetchTeamKeyStatus('org-1', 'jwt');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not cache a failed lookup', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 500));
      await expect(fetchTeamKeyStatus('org-1', 'jwt')).rejects.toThrow();

      fetchMock.mockResolvedValue(jsonResponse({ mode: 'server-managed' }));
      await expect(fetchTeamKeyStatus('org-1', 'jwt')).resolves.toMatchObject({
        mode: 'server-managed',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('invalidates one org without dropping the others', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ mode: 'server-managed' }));
      await fetchTeamKeyStatus('org-1', 'jwt');
      await fetchTeamKeyStatus('org-2', 'jwt');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      invalidateTeamKeyStatusCache('org-1');
      await fetchTeamKeyStatus('org-1', 'jwt');
      await fetchTeamKeyStatus('org-2', 'jwt');

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('drops the cached status when a team is marked server-managed', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ mode: 'unmigrated' }));
      await fetchTeamKeyStatus('org-1', 'jwt');

      fetchMock.mockResolvedValue(jsonResponse({ mode: 'server-managed' }));
      await setTeamServerManagedCustody('org-1', 'jwt');

      await expect(fetchTeamKeyStatus('org-1', 'jwt')).resolves.toMatchObject({
        mode: 'server-managed',
      });
    });
  });
});
