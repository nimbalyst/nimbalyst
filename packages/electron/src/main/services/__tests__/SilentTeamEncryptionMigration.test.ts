import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initializeServerManagedOrganization,
  resetSilentMigrationScanState,
  runSilentTeamEncryptionMigrations,
} from '../SilentTeamEncryptionMigration';

describe('silent forced team encryption migration', () => {
  beforeEach(() => {
    resetSilentMigrationScanState();
  });

  afterEach(() => {
    resetSilentMigrationScanState();
    vi.useRealTimers();
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

  it('cooldowns a failed status check so a persistent 401 cannot loop', async () => {
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
    expect(first).toEqual({ attempted: 1, migrated: 0, failed: ['flaky'] });
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
    expect(result).toEqual({ attempted: 2, migrated: 1, failed: ['bad'] });
  });

  it('finalizes pending documents for an already server-managed organization', async () => {
    const finalizeDocument = vi.fn(async () => undefined);
    const finalizeTitles = vi.fn(async () => undefined);
    const getFinalizationStatus = vi.fn()
      .mockResolvedValueOnce({
        mode: 'server-managed',
        complete: false,
        pendingDocumentIds: ['doc-1', 'doc-2'],
        staleTitleDocumentIds: ['doc-1'],
        failedDocumentIds: [],
        documentsChecked: 2,
        finalizedAt: null,
      })
      .mockResolvedValueOnce({
        mode: 'server-managed',
        complete: true,
        pendingDocumentIds: [],
        staleTitleDocumentIds: [],
        failedDocumentIds: [],
        documentsChecked: 2,
        finalizedAt: '2026-07-23T12:00:00.000Z',
      });

    const result = await runSilentTeamEncryptionMigrations([
      { orgId: 'already-cut-over', role: 'admin', membershipType: 'active_member' },
    ], {
      getStatus: vi.fn().mockResolvedValue('server-managed'),
      migrate: vi.fn(),
      getFinalizationStatus,
      finalizeDocument,
      finalizeTitles,
    });

    expect(finalizeTitles).toHaveBeenCalledWith('already-cut-over');
    expect(finalizeDocument.mock.calls).toEqual([
      ['already-cut-over', 'doc-1'],
      ['already-cut-over', 'doc-2'],
    ]);
    expect(result).toEqual({ attempted: 1, migrated: 0, failed: [] });
  });

  it('retries a stuck migration in the same app run', async () => {
    vi.useFakeTimers();
    const getStatus = vi.fn()
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValue('server-managed');
    const candidate = { orgId: 'retry-me', role: 'admin', membershipType: 'active_member' };

    const first = await runSilentTeamEncryptionMigrations([candidate], {
      getStatus,
      migrate: vi.fn(),
    });
    expect(first.failed).toEqual(['retry-me']);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('initializes new organizations directly in server-managed mode', async () => {
    const setServerManaged = vi.fn().mockResolvedValue(undefined);
    const createLegacyOrgKey = vi.fn();

    await initializeServerManagedOrganization('org-new', { setServerManaged });

    expect(setServerManaged).toHaveBeenCalledWith('org-new');
    expect(createLegacyOrgKey).not.toHaveBeenCalled();
  });
});
