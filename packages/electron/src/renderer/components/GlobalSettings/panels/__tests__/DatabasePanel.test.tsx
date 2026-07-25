// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

import { DatabasePanel } from '../DatabasePanel';

type Backend = 'pglite' | 'sqlite';

function installMigrationApi(activeBackend: Backend) {
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
    expect(screen.getByText(/Available only while PGLite is active/i)).toBeTruthy();

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
    expect(screen.getByText(/No further\s+migration is needed/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Migrate to SQLite' })).toBeNull();
  });
});
