import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initializeServerManagedOrganization,
  resetSilentMigrationScanState,
  runSilentTeamEncryptionMigrations,
} from '../SilentTeamEncryptionMigration';

describe('silent forced team encryption migration', () => {
  beforeEach(() => {
    resetSilentMigrationScanState();
  });

  it('migrates only active legacy organizations that the caller can administer', async () => {
    const getStatus = vi.fn(async (orgId: string) => orgId === 'legacy' ? 'legacy-e2e' as const : 'server-managed' as const);
    const migrate = vi.fn(async () => undefined);

    await runSilentTeamEncryptionMigrations([
      { orgId: 'legacy', role: 'admin', membershipType: 'active_member' },
      { orgId: 'current', role: 'owner', membershipType: 'active_member' },
      { orgId: 'member', role: 'member', membershipType: 'active_member' },
      { orgId: 'pending', role: 'admin', membershipType: 'pending_member' },
    ], { getStatus, migrate });

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith('legacy');
  });

  it('is best-effort and continues after one organization fails', async () => {
    const migrate = vi.fn()
      .mockRejectedValueOnce(new Error('backup gate failed'))
      .mockResolvedValueOnce(undefined);

    const result = await runSilentTeamEncryptionMigrations([
      { orgId: 'one', role: 'admin', membershipType: 'active_member' },
      { orgId: 'two', role: 'owner', membershipType: 'active_member' },
    ], {
      getStatus: vi.fn().mockResolvedValue('legacy-e2e'),
      migrate,
    });

    expect(migrate).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ attempted: 2, migrated: 1, failed: ['one'] });
  });

  it('never re-scans an org once attempted, so a persistent 401 cannot loop', async () => {
    // getStatus throwing simulates getOrgScopedJwt() returning HTTP 401. That 401
    // triggers a session refresh, which fires another auth-state-change and
    // re-invokes the scan. The guard must ensure the org is checked only once.
    const getStatus = vi.fn(async () => { throw new Error('HTTP 401'); });
    const migrate = vi.fn(async () => undefined);
    const candidates = [{ orgId: 'flaky', role: 'admin', membershipType: 'active_member' }];

    const first = await runSilentTeamEncryptionMigrations(candidates, { getStatus, migrate });
    const second = await runSilentTeamEncryptionMigrations(candidates, { getStatus, migrate });

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(migrate).not.toHaveBeenCalled();
    expect(first).toEqual({ attempted: 0, migrated: 0, failed: ['flaky'] });
    expect(second).toEqual({ attempted: 0, migrated: 0, failed: [] });
  });

  it('keeps migrating other orgs after one org status check fails', async () => {
    const getStatus = vi.fn(async (orgId: string) => {
      if (orgId === 'bad') throw new Error('HTTP 401');
      return 'legacy-e2e' as const;
    });
    const migrate = vi.fn(async () => undefined);

    const result = await runSilentTeamEncryptionMigrations([
      { orgId: 'bad', role: 'admin', membershipType: 'active_member' },
      { orgId: 'good', role: 'owner', membershipType: 'active_member' },
    ], { getStatus, migrate });

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith('good');
    expect(result).toEqual({ attempted: 1, migrated: 1, failed: ['bad'] });
  });

  it('initializes new organizations directly in server-managed mode', async () => {
    const setServerManaged = vi.fn().mockResolvedValue(undefined);
    const createLegacyOrgKey = vi.fn();

    await initializeServerManagedOrganization('org-new', { setServerManaged });

    expect(setServerManaged).toHaveBeenCalledWith('org-new');
    expect(createLegacyOrgKey).not.toHaveBeenCalled();
  });
});
