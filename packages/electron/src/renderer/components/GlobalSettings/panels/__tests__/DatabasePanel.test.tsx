// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

import { DatabasePanel } from '../DatabasePanel';

type Backend = 'pglite' | 'sqlite';

interface StorageHealth {
  databaseSizeBytes: number;
  aiSessionsRelationSizeBytes: number;
  aiSessionsLiveRowBytes: number;
  retainedBackupBytes: number;
  projectedPeakBytes: number;
  sessionPhysicalToLiveRatio: number;
  maintenanceRecommended: boolean;
  operatorGuidance: string | null;
}

function installMigrationApi(activeBackend: Backend, storageHealth: StorageHealth | null = null) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:migration:get-status') {
      return {
        success: true,
        activeBackend,
        pgliteDirExists: activeBackend === 'pglite',
        sqliteDirExists: activeBackend === 'sqlite',
        migratedDirs: [],
        running: false,
        runningDryRun: false,
        storageHealth: activeBackend === 'pglite' ? storageHealth : null,
      };
    }
    if (channel === 'db:migration:dry-run-status') {
      return { success: true, available: false };
    }
    if (channel === 'db:migration:dry-run') {
      return { success: false, error: 'not expected in this test' };
    }
    throw new Error(`Unexpected IPC channel: ${channel}`);
  });
  (window as any).electronAPI = { invoke };
  return invoke;
}

describe('DatabasePanel dry-run eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    delete (window as any).electronAPI;
  });

  it('shows and invokes the dry-run control while PGLite is active', async () => {
    const invoke = installMigrationApi('pglite');
    render(<DatabasePanel />);

    const button = await screen.findByRole('button', { name: 'Run dry-run migration' });
    screen.getByText(/Available only while PGLite is active/i);

    fireEvent.click(button);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('db:migration:dry-run');
    });
  });

  it('hides the dry-run controls while SQLite is active', async () => {
    const invoke = installMigrationApi('sqlite');
    render(<DatabasePanel />);

    await screen.findByText('SQLite (new)');
    expect(screen.queryByRole('button', { name: 'Run dry-run migration' })).toBeNull();
    expect(screen.queryByText(/Safe to run any time/i)).toBeNull();
    expect(screen.queryByText(/Test the SQLite migration/i)).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('db:migration:dry-run');
  });

  it('confirms the migration is complete while SQLite is active', async () => {
    installMigrationApi('sqlite');
    render(<DatabasePanel />);

    await screen.findByText('SQLite (new)');
    screen.getByText(/No further\s+migration is needed/i);
    expect(screen.queryByRole('button', { name: 'Migrate to SQLite' })).toBeNull();
  });

  it('projects abnormal physical growth and keeps the existing dry-run action available', async () => {
    const invoke = installMigrationApi('pglite', {
      databaseSizeBytes: 5 * 1024 ** 3,
      aiSessionsRelationSizeBytes: 1800 * 1024 ** 2,
      aiSessionsLiveRowBytes: 2 * 1024 ** 2,
      retainedBackupBytes: 15 * 1024 ** 3,
      projectedPeakBytes: 25 * 1024 ** 3,
      sessionPhysicalToLiveRatio: 900,
      maintenanceRecommended: true,
      operatorGuidance: 'Open Settings > Database and run the SQLite migration dry-run before the next backup.',
    });
    render(<DatabasePanel />);

    await screen.findByRole('heading', { name: 'Physical storage' });
    expect(screen.getByText('5.00 GB')).toBeTruthy();
    expect(screen.getByText('1.76 GB')).toBeTruthy();
    expect(screen.getByText('2.0 MB')).toBeTruthy();
    expect(screen.getByText('15.00 GB')).toBeTruthy();
    expect(screen.getByText('25.00 GB')).toBeTruthy();
    expect(screen.getByText('Maintenance recommended')).toBeTruthy();
    expect(screen.getByText(/run the SQLite migration dry-run before the next backup/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Run dry-run migration' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('db:migration:dry-run');
    });
  });

  it('projects healthy physical storage without a maintenance warning', async () => {
    installMigrationApi('pglite', {
      databaseSizeBytes: 100 * 1024 ** 2,
      aiSessionsRelationSizeBytes: 2 * 1024 ** 2,
      aiSessionsLiveRowBytes: 1 * 1024 ** 2,
      retainedBackupBytes: 200 * 1024 ** 2,
      projectedPeakBytes: 400 * 1024 ** 2,
      sessionPhysicalToLiveRatio: 2,
      maintenanceRecommended: false,
      operatorGuidance: null,
    });
    render(<DatabasePanel />);

    await screen.findByRole('heading', { name: 'Physical storage' });
    expect(screen.getByText('100.0 MB')).toBeTruthy();
    expect(screen.getByText('No abnormal session-metadata amplification detected.')).toBeTruthy();
    expect(screen.queryByText('Maintenance recommended')).toBeNull();
  });
});
