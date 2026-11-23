/**
 * The last look before a save: what changes in plain sentences, where it is
 * saved, and that a backup comes first. Main runs the checks again and makes
 * the backup; this panel only shows the answer.
 */

import { useState } from 'react';

import type { SaveRequest, SaveResult } from '../../../main/services/hookEditor/HookFileService';
import type { CheckResult } from '../../../shared/hookEditor/hookChecks';
import { SAVE_CONFLICT_REASON } from '../../../shared/hookEditor/savePlan';
import { HookChangesPane } from './HookChangesPane';
import { HookRestorePanel } from './HookRestorePanel';
import { changeSentences, saveRequestOf, writeTab, type EditorTab } from './hookEditorState';
import { BUTTON } from './hookEditorText';

interface HookReviewPanelProps {
  workspacePath: string;
  tab: EditorTab;
  onBack: () => void;
  /** Runs after a save. The prune warning, if any, goes out here because this panel closes. */
  onSaved: (text: string, pruneWarning: string | null, savedPaused: SaveRequest['paused']) => void;
  /** Read the file again. The tab's unsaved changes and undo steps are dropped. */
  onReload: () => void;
  /** Runs after a Restore. The prune warning, if any, goes out here because this panel closes. */
  onRestored: (pruneWarning: string | null, restoredFrom: string) => void;
  /** Runs when a failed check stopped the save. This panel closes, so the reason goes out here too. */
  onChecksFailed: (checks: CheckResult[], reason: string) => void;
}

export function HookReviewPanel({ workspacePath, tab, onBack, onSaved, onReload, onRestored, onChecksFailed }: HookReviewPanelProps) {
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [offerRestore, setOfferRestore] = useState(false);
  const written = writeTab(tab);
  const request = saveRequestOf(tab);

  const save = async () => {
    // Nothing to write: never send a save without a request.
    if (request === null) return;
    setSaving(true);
    setReason(null);
    setOfferRestore(false);
    try {
      const result = (await window.electronAPI.invoke('hook-editor:save', workspacePath, request)) as SaveResult;
      if (result.status === 'saved') {
        onSaved(result.text, result.pruneWarning, request.paused);
      } else if (result.status === 'refused') {
        setReason(result.reason);
        if (result.checks.some((check) => check.status === 'failed')) onChecksFailed(result.checks, result.reason);
      } else {
        setReason(result.reason);
        setOfferRestore(true);
      }
    } catch {
      setReason('Nimbalyst could not reach the file. Nothing was saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="hook-review-panel flex flex-col gap-3 p-3 text-sm" data-testid="hook-review-panel">
      <h3 className="select-text font-semibold">Save to {tab.filePath}?</h3>
      <ul className="list-disc pl-5">
        {/* Two changes can read the same, for example two copies of one hook, so the place in the list is part of the key. */}
        {changeSentences(tab).map((sentence, index) => <li key={`${index}-${sentence}`}>{sentence}</li>)}
      </ul>
      {written !== null && (
        <p className="text-[var(--nim-text-muted)]">
          {written.diff.added} lines added, {written.diff.changed} changed, {written.diff.removed} removed.
        </p>
      )}
      <p className="text-[var(--nim-text-muted)]">{tab.exists ? 'A backup is saved first.' : 'This makes a new file.'}</p>
      {tab.source === 'projectSettings' && (
        <p className="rounded border border-[var(--nim-warning)] p-2" data-testid="hook-git-warning">
          This file is usually in git. A save changes a file that other people on the project may share. Check git before you commit it.
        </p>
      )}
      <p className="text-[var(--nim-text-muted)]">Changes start in new sessions. Sessions already open keep the old hooks.</p>
      {written !== null && <HookChangesPane parts={written.diff.parts} />}
      {reason !== null && (
        <p className="select-text text-[var(--nim-error)]" data-testid="hook-save-reason">
          {reason}
        </p>
      )}
      {reason === SAVE_CONFLICT_REASON && (
        <div className="flex items-center gap-2">
          <button type="button" data-testid="hook-reload" className={`${BUTTON.secondary} ${BUTTON.small}`} onClick={onReload}>
            Reload the file
          </button>
          <span className="text-[var(--nim-warning)]">Reload reads the file again. Your unsaved changes in this file are lost.</span>
        </div>
      )}
      {offerRestore && <HookRestorePanel workspacePath={workspacePath} source={tab.source} unsavedCount={changeSentences(tab).length} onRestored={onRestored} />}
      <div className="flex gap-2">
        <button type="button" className={BUTTON.secondary} onClick={onBack}>
          Back
        </button>
        <button type="button" data-testid="hook-save" className={BUTTON.primary} disabled={saving || request === null} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}
