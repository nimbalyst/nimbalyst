/**
 * Two Settings > Database sections that describe state the user cannot
 * otherwise see: a durable refusal to migrate automatically, and the PGLite
 * copies a completed migration left behind.
 *
 * Both exist because the alternative is silence. A refusal that is not shown
 * is a boot that does nothing for a reason nobody can find out, and a
 * preserved copy that is not shown is disk the user cannot account for — which
 * is how a "recovery" copy sat unexamined for nine months in #1347.
 *
 * Neither copy is ever removed on a timer. Deletion is a separate, explicitly
 * acknowledged action that names what it destroys.
 */

import React, { useCallback, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  dbMigratedCopiesAtom,
  dbMigrationBlockedAtom,
  type MigratedCopyView,
  type MigrationRefusalReason,
} from '../../../../store/atoms/dbMigration';
import { formatArtifactDate, formatBytes } from './dbFormat';

/**
 * One sentence per refusal reason. Each says what was measured, not what it
 * proves: every one of these is a reason to look, and none of them is a
 * finding that data is missing.
 */
const BLOCKED_REASON_TEXT: Record<MigrationRefusalReason, string> = {
  backup_dwarfs_live:
    'A database set aside on this computer is much larger than the one in use, so Nimbalyst will not copy the one in use without you looking first.',
  projects_without_sessions:
    'This computer has settings for projects you have opened, but the database Nimbalyst would copy from has no sessions in it.',
  source_unreadable:
    'Nimbalyst could not read the database it would copy from, and an unreadable database is not treated as an empty one.',
  source_missing: 'The database Nimbalyst would copy from is not on disk.',
  insufficient_disk:
    'There is not enough free disk space to hold both databases during the copy.',
};

export function MigrationBlockedSection({
  onCleared,
}: {
  onCleared: () => void;
}): React.ReactElement | null {
  const blocked = useAtomValue(dbMigrationBlockedAtom);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearBlock = useCallback(async () => {
    if (!window.electronAPI) return;
    setClearing(true);
    setError(null);
    try {
      const resp = (await window.electronAPI.invoke('db:migration:clear-block')) as
        | { success: true }
        | { success: false; error: string };
      if (!resp.success) setError(resp.error);
      else onCleared();
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setClearing(false);
    }
  }, [onCleared]);

  if (!blocked) return null;

  return (
    <div className="provider-panel-section nim-database-migration-blocked mb-6 select-text">
      <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)]">
        Automatic migration is held back on this computer
      </h4>
      <div className="rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3">
        <p className="text-sm text-[var(--nim-text)]">
          {BLOCKED_REASON_TEXT[blocked.reasonCode] ?? 'Nimbalyst recorded a reason it cannot describe in this build.'}
        </p>
        <p className="mt-2 text-xs text-[var(--nim-text-muted)]">
          Recorded {formatArtifactDate(blocked.blockedAt)}. Nimbalyst re-checks this on its
          own if what it measures changes. Nothing has been copied, moved, or deleted.
        </p>
      </div>

      <p className="mt-3 text-sm text-[var(--nim-text-muted)]">
        Clearing this lets a later launch assess the migration again. It does not start a
        migration and does not change any data, but it does remove the check that stopped
        Nimbalyst from copying a database it could not confirm was the one holding your
        work. Look at any set-aside copies first.
      </p>

      <button
        type="button"
        onClick={() => { void clearBlock(); }}
        disabled={clearing}
        className="nim-database-clear-block-button setting-button mt-3 inline-flex items-center gap-2 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 py-1.5 text-sm text-[var(--nim-text)] hover:bg-[var(--nim-hover)] disabled:opacity-50"
      >
        <MaterialSymbol icon="refresh" size={16} />
        {clearing ? 'Clearing...' : 'Clear this and re-check on the next launch'}
      </button>

      {error && (
        <div className="mt-3 rounded-md border border-[rgba(220,38,38,0.3)] bg-[rgba(220,38,38,0.1)] p-3 text-sm text-[var(--nim-text)]">
          Could not clear it: {error}
        </div>
      )}
    </div>
  );
}

export function MigratedCopiesSection({
  onChanged,
}: {
  onChanged: () => void;
}): React.ReactElement | null {
  const copies = useAtomValue(dbMigratedCopiesAtom);
  const [deleting, setDeleting] = useState<MigratedCopyView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reveal = useCallback(async (name: string) => {
    await window.electronAPI?.invoke('db:recovery:reveal', { name });
  }, []);

  const deleteCopy = useCallback(async (copy: MigratedCopyView) => {
    if (!window.electronAPI) return;
    setError(null);
    try {
      const resp = (await window.electronAPI.invoke('db:recovery:delete-migrated', {
        name: copy.name,
        acknowledgedRollbackLoss: copy.isRollbackSource,
      })) as { success: true } | { success: false; error: string };
      if (!resp.success) setError(resp.error);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setDeleting(null);
      onChanged();
    }
  }, [onChanged]);

  if (copies.length === 0) return null;

  return (
    <div className="provider-panel-section nim-database-migrated-copies mb-6 select-text">
      <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)]">
        PGLite copies kept from a migration
      </h4>
      <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-3">
        A migration keeps the PGLite database it copied from. These stay until you remove
        them; Nimbalyst does not delete them on a schedule.
      </p>

      <div className="flex flex-col gap-3">
        {copies.map((copy) => (
          <div
            key={copy.name}
            className="nim-database-migrated-copy rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3"
          >
            <div className="text-sm font-medium font-mono text-[var(--nim-text)]">{copy.name}</div>
            <div className="mt-1 text-xs text-[var(--nim-text-muted)]">
              {formatArtifactDate(copy.createdAt)} · {formatBytes(copy.sizeBytes)}
            </div>
            <p className="mt-2 text-sm text-[var(--nim-text)]">
              {copy.isRollbackSource
                ? 'This is the copy "Restore from preserved PGLite" would use.'
                : 'Kept on disk. It is not the copy a rollback would use.'}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => { void reveal(copy.name); }}
                className="nim-database-migrated-reveal-button setting-button inline-flex items-center gap-2 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-primary)] px-3 py-1.5 text-sm text-[var(--nim-text)] hover:bg-[var(--nim-hover)]"
              >
                <MaterialSymbol icon="folder_open" size={16} />
                Show in Finder
              </button>
              <button
                type="button"
                onClick={() => { setError(null); setDeleting(copy); }}
                className="nim-database-migrated-delete-button setting-button inline-flex items-center gap-2 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-primary)] px-3 py-1.5 text-sm text-[var(--nim-text)] hover:bg-[var(--nim-hover)]"
              >
                <MaterialSymbol icon="delete" size={16} />
                Delete this copy
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-[rgba(220,38,38,0.3)] bg-[rgba(220,38,38,0.1)] p-3 text-sm text-[var(--nim-text)]">
          Nothing was deleted: {error}
        </div>
      )}

      {deleting && (
        <DeleteCopyConfirmation
          copy={deleting}
          onCancel={() => setDeleting(null)}
          onReveal={() => { void reveal(deleting.name); }}
          onDelete={() => { void deleteCopy(deleting); }}
        />
      )}
    </div>
  );
}

function DeleteCopyConfirmation({
  copy,
  onCancel,
  onReveal,
  onDelete,
}: {
  copy: MigratedCopyView;
  onCancel: () => void;
  onReveal: () => void;
  onDelete: () => void;
}): React.ReactElement {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/45 px-4">
      <div className="nim-database-delete-confirmation w-full max-w-xl select-text rounded-xl border border-[var(--nim-border)] bg-[var(--nim-bg-primary)] p-6 shadow-2xl">
        <h4 className="text-lg font-semibold text-[var(--nim-text)]">Delete a preserved copy</h4>

        <div className="mt-4 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-4 text-sm text-[var(--nim-text)]">
          <div className="font-mono">{copy.name}</div>
          <p className="mt-2">
            This permanently removes {formatBytes(copy.sizeBytes)} — the PGLite database as
            it stood on {formatArtifactDate(copy.createdAt)}, before it was migrated.
            Sessions and document history that exist only in this copy cannot be recovered
            afterwards.
          </p>
          {copy.isRollbackSource && (
            <p className="mt-2">
              This is the copy a rollback restores from. Once it is gone, this install
              cannot be put back onto PGLite.
            </p>
          )}
          <p className="mt-2 text-[var(--nim-text-muted)]">
            The database you are using now is not touched.
          </p>
        </div>

        <label className="nim-database-delete-acknowledge mt-4 flex items-start gap-2 text-sm text-[var(--nim-text)]">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5"
          />
          <span>I understand this copy cannot be recovered after deleting it.</span>
        </label>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="nim-database-delete-cancel-button rounded-md border border-[var(--nim-border)] px-3 py-2 text-sm text-[var(--nim-text)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onReveal}
            className="nim-database-delete-reveal-button rounded-md border border-[var(--nim-border)] px-3 py-2 text-sm text-[var(--nim-text)]"
          >
            Show in Finder
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={!acknowledged}
            className="nim-database-delete-confirm-button rounded-md border border-[rgba(220,38,38,0.4)] bg-[rgba(220,38,38,0.12)] px-3 py-2 text-sm font-medium text-[var(--nim-text)] disabled:opacity-50"
          >
            Delete permanently
          </button>
        </div>
      </div>
    </div>
  );
}
