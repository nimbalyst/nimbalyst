import { describe, expect, it, vi } from 'vitest';

import {
  requireSuccessfulCollabBackups,
  verifyOrMarkCollabBackups,
  type CollabBackupSweepSummary,
} from '../CollabBackupMigrationGate';

function summary(
  overrides: Partial<CollabBackupSweepSummary> = {},
): CollabBackupSweepSummary {
  return {
    success: true,
    orgId: 'org-1',
    projectId: 'project-1',
    total: 2,
    backedUp: 2,
    skipped: 0,
    failures: [],
    ...overrides,
  };
}

describe('pre-migration collaboration backup gate', () => {
  it('returns every verified project recovery point', () => {
    expect(requireSuccessfulCollabBackups([
      summary(),
      summary({ projectId: null }),
    ])).toEqual(['project-1', null]);
  });

  it('blocks migration when any item did not produce a fresh backup', () => {
    expect(() => requireSuccessfulCollabBackups([
      summary({
        success: false,
        backedUp: 1,
        failures: [{ documentId: 'tracker-content/item-1', error: 'size-guard' }],
      }),
    ])).toThrow(
      'Encryption migration blocked: plaintext backup failed for 1 of 2 collaborative items ' +
      '(tracker-content/item-1: size-guard).',
    );
  });

  it('marks every attempted project as needing recovery when the gate fails', async () => {
    const markNeedsRecovery = vi.fn().mockResolvedValue(undefined);
    const summaries = [
      summary({ projectId: 'project-1' }),
      summary({
        projectId: 'project-2',
        success: false,
        backedUp: 0,
        failures: [{ documentId: 'doc-2', error: 'decrypt failed' }],
      }),
    ];

    await expect(verifyOrMarkCollabBackups(summaries, markNeedsRecovery)).rejects.toThrow(
      'Encryption migration blocked',
    );
    expect(markNeedsRecovery).toHaveBeenCalledWith(
      ['project-1', 'project-2'],
      expect.stringContaining('decrypt failed'),
    );
  });
});
