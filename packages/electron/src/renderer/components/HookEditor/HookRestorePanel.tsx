/**
 * Lists the backups of one settings file and restores one. Main backs up the
 * file as it is now before it restores, so a restore never loses text.
 */

import { useEffect, useState } from 'react';

import type { BackupInfo, RestoreResult } from '../../../main/services/hookEditor/HookFileService';
import type { SettingsSource } from '../../../main/services/hookEditor/hookFiles';
import { BUTTON } from './hookEditorText';

interface HookRestorePanelProps {
  workspacePath: string;
  source: SettingsSource;
  /**
   * Runs after a restore. The prune warning, if any, goes out here because this panel closes.
   * `restoredFrom` is the date and time text the restored backup's row showed.
   */
  onRestored: (pruneWarning: string | null, restoredFrom: string) => void;
  /** What to say when the file has no backups. */
  emptyText?: string;
  /** How many changes in this file are not saved. A restore reads the file again and drops them, so the confirm step says so. */
  unsavedCount?: number;
}

/** The date and time a backup row shows. The notice after a restore uses the same text. */
export function backupWhen(backup: BackupInfo): string {
  return new Date(backup.savedAt).toLocaleString();
}

export function HookRestorePanel({ workspacePath, source, onRestored, emptyText = 'There are no backups of this file yet.', unsavedCount = 0 }: HookRestorePanelProps) {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // True from the Confirm click until main answers, so a second click cannot start a second restore.
  const [working, setWorking] = useState(false);

  useEffect(() => {
    window.electronAPI
      .invoke('hook-editor:list-backups', workspacePath, source)
      .then((list: BackupInfo[]) => setBackups(list))
      .catch(() => setMessage('Nimbalyst could not list the backups of this file.'));
  }, [workspacePath, source]);

  const restore = async (name: string) => {
    setWorking(true);
    try {
      const result = (await window.electronAPI.invoke('hook-editor:restore', workspacePath, source, name)) as RestoreResult;
      setPicked(null);
      const backup = backups?.find((candidate) => candidate.name === name);
      if (result.status === 'restored') onRestored(result.pruneWarning, backup === undefined ? 'an earlier time' : backupWhen(backup));
      else setMessage(result.reason);
    } catch {
      setPicked(null);
      setMessage('The restore did not run. Your file is unchanged.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="hook-restore-panel flex flex-col gap-2 p-3 text-sm" data-testid="hook-restore-panel">
      {backups !== null && backups.length === 0 && <p className="text-[var(--nim-text-muted)]">{emptyText}</p>}
      {backups?.map((backup) => (
        <div key={backup.name} className="flex items-center gap-2">
          <span className="flex-1 select-text">{backupWhen(backup)}</span>
          <button type="button" data-testid={`hook-restore-${backup.name}`} className={`${BUTTON.secondary} ${BUTTON.small}`} onClick={() => setPicked(backup.name)}>
            Restore
          </button>
        </div>
      ))}
      {picked !== null && (
        <div className="flex items-center gap-2 rounded border border-[var(--nim-warning)] p-2">
          <span className="flex-1">
            Restore this backup? Nimbalyst backs up the file as it is now first.
            {unsavedCount > 0 && (
              <span className="mt-1 block text-[var(--nim-warning)]" data-testid="hook-restore-unsaved">
                You have {unsavedCount === 1 ? '1 change' : `${unsavedCount} changes`} not saved in this file. Restore replaces {unsavedCount === 1 ? 'it' : 'them'}.
              </span>
            )}
          </span>
          <button type="button" data-testid="hook-restore-confirm" className={`${BUTTON.primary} ${BUTTON.small}`} disabled={working} onClick={() => void restore(picked)}>
            Restore
          </button>
          <button type="button" className={`${BUTTON.secondary} ${BUTTON.small}`} onClick={() => setPicked(null)}>
            Cancel
          </button>
        </div>
      )}
      {message !== null && <p className="text-[var(--nim-text-muted)]">{message}</p>}
    </div>
  );
}
