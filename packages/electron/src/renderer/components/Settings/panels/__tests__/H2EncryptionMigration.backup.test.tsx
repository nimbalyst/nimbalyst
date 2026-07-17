// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SecurityEncryptionSection } from '../H2EncryptionMigration';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));

describe('organization encryption status', () => {
  const migrateToServerManaged = vi.fn();
  const backupAll = vi.fn();

  beforeEach(() => {
    (window as any).electronAPI = {
      team: {
        getKeyCustodyStatus: vi.fn().mockResolvedValue({ success: true, mode: 'legacy-e2e' }),
        getEncryptionMigrationStatus: vi.fn().mockResolvedValue({
          success: true,
          migration: { status: 'migrating', startedAt: '2026-07-13T12:00:00.000Z' },
        }),
      },
      trackerSync: { migrateToServerManaged },
      collabBackup: { backupAll },
    };
  });

  afterEach(() => cleanup());

  it('is status-only while a forced legacy migration runs silently', async () => {
    render(<SecurityEncryptionSection orgId="org-1" workspacePath="/workspace" isAdmin />);

    await screen.findByText('Encrypted by Nimbalyst');
    expect(screen.getByText('Updating encryption in the background')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /migrate|review changes|back up all now/i })).toBeNull();
    expect(migrateToServerManaged).not.toHaveBeenCalled();
    expect(backupAll).not.toHaveBeenCalled();
  });

  it('shows a passive support diagnostic when background migration is stuck', async () => {
    (window as any).electronAPI.team.getEncryptionMigrationStatus.mockResolvedValue({
      success: true,
      migration: { status: 'stuck', failedAt: '2026-07-13T12:00:00.000Z', message: 'backup gate failed' },
    });

    render(<SecurityEncryptionSection orgId="org-1" isAdmin={false} />);

    await waitFor(() => expect(screen.getByText('Encryption update needs support')).toBeTruthy());
    expect(screen.getByText(/backup gate failed/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
