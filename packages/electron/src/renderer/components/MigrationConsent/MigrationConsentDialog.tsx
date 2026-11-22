/**
 * Launch prompt offering to migrate a PGLite database that is above the
 * automatic SQLite ceiling (3 GiB).
 *
 * Shown at most once per launch, to the first window, when boot decided
 * `offer_consent` (see main/database/sqlite/migrationConsentOffer.ts). Runs
 * the same `db:migration:*` flow as Settings > Database, which ordinary users
 * cannot see, so this dialog is the only way most of them can migrate.
 *
 * "Not now" and "Migrate now" both record an answer, after which the prompt
 * never shows again. A preflight that fails (for example, not enough disk
 * space) records nothing, so the next launch asks again.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  dbMigrationPhaseAtom,
  dbMigrationProgressAtom,
} from '../../store/atoms/dbMigration';
import { formatBytes } from '../GlobalSettings/panels/database/dbFormat';
import { DryRunProgress } from '../GlobalSettings/panels/database/MigrationProgressViews';

interface PreflightResult {
  ok: boolean;
  reason?: string;
  pgliteDirBytes: number;
  freeBytes: number;
  requiredBytes: number;
}

type Step =
  | { kind: 'checking' }
  | { kind: 'ready'; preflight: PreflightResult }
  | { kind: 'cannot'; reason: string }
  | { kind: 'running' }
  | { kind: 'done' }
  | { kind: 'failed'; message: string };

export interface MigrationConsentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Analytics hook: the user chose to migrate (true) or declined (false). */
  onAnswer: (accepted: boolean) => void;
}

export function MigrationConsentDialog({ isOpen, onClose, onAnswer }: MigrationConsentDialogProps): React.ReactElement | null {
  const [step, setStep] = useState<Step>({ kind: 'checking' });
  const phase = useAtomValue(dbMigrationPhaseAtom);
  const progress = useAtomValue(dbMigrationProgressAtom);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const resp = (await window.electronAPI.invoke('db:migration:preflight')) as
          | ({ success: true } & PreflightResult)
          | { success: false; error: string };
        if (cancelled) return;
        if (!resp.success) setStep({ kind: 'cannot', reason: resp.error });
        else if (!resp.ok) setStep({ kind: 'cannot', reason: resp.reason ?? 'The database cannot be migrated right now.' });
        else setStep({ kind: 'ready', preflight: resp });
      } catch (err) {
        if (!cancelled) setStep({ kind: 'cannot', reason: String((err as Error).message ?? err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const decline = useCallback(() => {
    void window.electronAPI.invoke('db:migration:answer-consent-prompt');
    onAnswer(false);
    onClose();
  }, [onAnswer, onClose]);

  const migrate = useCallback(async () => {
    void window.electronAPI.invoke('db:migration:answer-consent-prompt');
    onAnswer(true);
    setStep({ kind: 'running' });
    try {
      const resp = (await window.electronAPI.invoke('db:migration:start')) as
        | { success: true }
        | { success: false; error: string };
      setStep(resp.success ? { kind: 'done' } : { kind: 'failed', message: resp.error });
    } catch (err) {
      setStep({ kind: 'failed', message: String((err as Error).message ?? err) });
    }
  }, [onAnswer]);

  if (!isOpen) return null;

  // Nothing may dismiss the dialog while the copy runs; the outcome has to
  // reach the user.
  const dismissable = step.kind !== 'running';

  return (
    <div className="migration-consent-dialog nim-overlay bg-black/60" onClick={dismissable && step.kind !== 'ready' ? onClose : undefined}>
      <div
        className="relative rounded-2xl w-[500px] max-w-[90vw] nim-animate-slide-up bg-nim border border-nim shadow-[0_8px_32px_rgba(0,0,0,0.4)] px-8 pt-8 pb-6 select-text"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="migration-consent-title"
      >
        <h2 id="migration-consent-title" className="m-0 mb-3 text-xl font-semibold text-nim">
          Move your database to SQLite
        </h2>

        {step.kind === 'checking' && <p className="text-sm text-nim-muted">Checking your database...</p>}

        {step.kind === 'ready' && (
          <>
            <p className="mb-3 text-sm leading-relaxed text-nim-muted">
              Nimbalyst now stores sessions, trackers and document history in SQLite. Smaller databases were moved
              automatically; yours is large enough that we ask first.
            </p>
            <ul className="mb-4 pl-5 text-sm leading-relaxed text-nim-muted list-disc">
              <li>Database size: {formatBytes(step.preflight.pgliteDirBytes)}</li>
              <li>
                Disk space needed: {formatBytes(step.preflight.requiredBytes)} (
                {formatBytes(step.preflight.freeBytes)} free)
              </li>
              <li>Your current database is kept unchanged as a recovery copy.</li>
              <li>Nimbalyst restarts when the copy finishes. You can keep working until then.</li>
            </ul>
            <div className="flex justify-end gap-2">
              <button type="button" className="nim-btn-secondary" onClick={decline}>
                Not now
              </button>
              <button type="button" className="nim-btn-primary" onClick={() => void migrate()}>
                Migrate now
              </button>
            </div>
          </>
        )}

        {step.kind === 'cannot' && (
          <>
            <p className="mb-4 text-sm leading-relaxed text-nim-muted">
              Your database cannot be moved right now: {step.reason} Nimbalyst keeps using it as before and will ask
              again on a later launch.
            </p>
            <div className="flex justify-end">
              <button type="button" className="nim-btn-secondary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}

        {step.kind === 'running' && <DryRunProgress phase={phase} progress={progress} />}

        {step.kind === 'done' && (
          <>
            <p className="mb-4 text-sm leading-relaxed text-nim-muted">
              The copy is complete and verified. Restart Nimbalyst to switch to it.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="nim-btn-secondary" onClick={onClose}>
                Restart later
              </button>
              <button
                type="button"
                className="nim-btn-primary"
                onClick={() => void window.electronAPI.invoke('db:migration:restart')}
              >
                Restart now
              </button>
            </div>
          </>
        )}

        {step.kind === 'failed' && (
          <>
            <p className="mb-4 text-sm leading-relaxed text-nim-muted">
              The migration stopped: {step.message} Your database was not changed and Nimbalyst keeps using it.
            </p>
            <div className="flex justify-end">
              <button type="button" className="nim-btn-secondary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
