// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'jotai';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

import { store } from '@nimbalyst/runtime/store';
import { DatabasePanel } from '../DatabasePanel';
import { refreshDbRecoveryState } from '../../../../store/listeners/dbMigrationListeners';
import {
  dbMigratedCopiesAtom,
  dbMigrationBlockedAtom,
  dbRecoveryCandidatesAtom,
  dbRecoveryOfferAtom,
  type MigratedCopyView,
  type MigrationBlockedState,
  type RecoveryCandidateView,
} from '../../../../store/atoms/dbMigration';

type Backend = 'pglite' | 'sqlite';

interface RecoveryFixtures {
  candidates?: RecoveryCandidateView[];
  migratedCopies?: MigratedCopyView[];
  migrationBlocked?: MigrationBlockedState | null;
}

function candidate(overrides: Partial<RecoveryCandidateView> = {}): RecoveryCandidateView {
  return {
    id: 'artifact:pglite-db.backup-2026-08-21T04-11-02-004Z',
    name: 'pglite-db.backup-2026-08-21T04-11-02-004Z',
    path: '/u/pglite-db.backup-2026-08-21T04-11-02-004Z',
    sizeBytes: 512 * 1024 * 1024,
    sizeBucket: 'under-1gb',
    createdAt: '2026-08-21T04:11:02.004Z',
    verdict: 'recovery_recommended',
    reasonCode: 'live_empty_on_established_install',
    mayOfferProactively: true,
    factsFingerprint: 'fp-abc',
    restoreAvailable: true,
    restoreUnavailableReason: null,
    ...overrides,
  };
}

function installMigrationApi(activeBackend: Backend, recovery: RecoveryFixtures = {}) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:migration:get-status') {
      return {
        success: true,
        activeBackend,
        pgliteDirExists: activeBackend === 'pglite',
        sqliteDirExists: activeBackend === 'sqlite',
        migratedDirs: (recovery.migratedCopies ?? []).map((c) => c.name),
        migrationBlocked: recovery.migrationBlocked ?? null,
        running: false,
        runningDryRun: false,
      };
    }
    if (channel === 'db:migration:dry-run-status') {
      return { success: true, available: false };
    }
    if (channel === 'db:recovery:list-candidates') {
      return {
        success: true,
        activeBackend,
        live: {
          backend: activeBackend,
          path: '/u/pglite-db',
          sizeBytes: 3 * 1024 * 1024,
          sizeBucket: 'under-32mb',
        },
        candidates: recovery.candidates ?? [],
      };
    }
    if (channel === 'db:recovery:list-migrated') {
      return { success: true, activeBackend, copies: recovery.migratedCopies ?? [] };
    }
    if (channel === 'db:recovery:recover') {
      return { success: true, outcome: { ok: true } };
    }
    if (channel === 'db:migration:clear-block' || channel === 'db:recovery:delete-migrated') {
      return { success: true };
    }
    if (channel === 'db:migration:dry-run') {
      return { success: false, error: 'not expected in this test' };
    }
    throw new Error(`Unexpected IPC channel: ${channel}`);
  });
  (window as any).electronAPI = { invoke };
  return invoke;
}

function renderPanel() {
  return render(
    <Provider store={store}>
      <DatabasePanel />
    </Provider>,
  );
}

function resetRecoveryAtoms() {
  store.set(dbRecoveryCandidatesAtom, []);
  store.set(dbRecoveryOfferAtom, null);
  store.set(dbMigratedCopiesAtom, []);
  store.set(dbMigrationBlockedAtom, null);
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
});

describe('recovery candidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRecoveryAtoms();
  });

  afterEach(() => {
    cleanup();
    delete (window as any).electronAPI;
  });

  // The whole point of the verdict vocabulary: an ambiguous candidate is
  // visible but never raised as a recommendation, and two recommendations are
  // a choice we do not make for the user.
  it('only raises a proactive offer for a single candidate cleared for one', async () => {
    installMigrationApi('pglite', {
      candidates: [candidate({ verdict: 'needs_review', mayOfferProactively: false })],
    });
    await refreshDbRecoveryState();
    expect(store.get(dbRecoveryOfferAtom)).toBeNull();
    expect(store.get(dbRecoveryCandidatesAtom)).toHaveLength(1);

    installMigrationApi('pglite', {
      candidates: [
        candidate({ id: 'artifact:a', name: 'a' }),
        candidate({ id: 'artifact:b', name: 'b' }),
      ],
    });
    await refreshDbRecoveryState();
    expect(store.get(dbRecoveryOfferAtom)).toBeNull();

    installMigrationApi('pglite', { candidates: [candidate()] });
    await refreshDbRecoveryState();
    expect(store.get(dbRecoveryOfferAtom)?.id).toBe(candidate().id);
  });

  it('will not restore until the user acknowledges what the confirmation named', async () => {
    const invoke = installMigrationApi('pglite', { candidates: [candidate()] });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Review restoring this copy/i }));

    const confirm = await screen.findByRole('button', { name: /Restore from this copy/i });
    fireEvent.click(confirm);
    expect(invoke).not.toHaveBeenCalledWith('db:recovery:recover', expect.anything());

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Restore from this copy/i }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('db:recovery:recover', {
        candidateId: candidate().id,
        // The user consented to the facts they were shown, not to whatever
        // the facts happen to be by the time the transaction runs.
        expectedFingerprint: 'fp-abc',
      });
    });
  });
});

describe('migration blocked state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRecoveryAtoms();
  });

  afterEach(() => {
    cleanup();
    delete (window as any).electronAPI;
  });

  it('clears a durable refusal through the migration handler', async () => {
    const invoke = installMigrationApi('pglite', {
      migrationBlocked: {
        reasonCode: 'backup_dwarfs_live',
        facts: {},
        factsFingerprint: 'fp-blocked',
        blockedAt: '2026-08-21T04:11:02.004Z',
        assessmentVersion: 1,
      },
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Clear this and re-check/i }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('db:migration:clear-block');
    });
  });
});

describe('preserved PGLite copies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRecoveryAtoms();
  });

  afterEach(() => {
    cleanup();
    delete (window as any).electronAPI;
  });

  // Deleting the rollback source is the one action on this panel that destroys
  // a copy outright, so it carries the acknowledgement the main-process guard
  // requires rather than relying on the guard to reject an unacknowledged one.
  it('deletes a rollback source only after an explicit acknowledgement', async () => {
    const copy: MigratedCopyView = {
      name: 'pglite-db.migrated-2026-08-19T09-00-00-000Z',
      path: '/u/pglite-db.migrated-2026-08-19T09-00-00-000Z',
      sizeBytes: 900 * 1024 * 1024,
      createdAt: '2026-08-19T09:00:00.000Z',
      isRollbackSource: true,
    };
    const invoke = installMigrationApi('sqlite', { migratedCopies: [copy] });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /^Delete this copy$/i }));

    fireEvent.click(await screen.findByRole('button', { name: /Delete permanently/i }));
    expect(invoke).not.toHaveBeenCalledWith('db:recovery:delete-migrated', expect.anything());

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Delete permanently/i }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('db:recovery:delete-migrated', {
        name: copy.name,
        acknowledgedRollbackLoss: true,
      });
    });
  });
});
