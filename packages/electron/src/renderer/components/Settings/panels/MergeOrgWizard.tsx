import { useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

/**
 * Epic H3 P4 — "Merge into another org" wizard.
 *
 * Merge moves EVERY project of this (drained) org into a survivor org, unions
 * the rosters (higher role wins), and optionally deletes the drained org. It is
 * the most destructive consolidation action, so it requires a typed confirmation
 * of the drained org's name. Gated server-side on server-managed custody (both
 * orgs) and admin on both.
 */

interface MergeResultSummary {
  movedProjects: Array<{ projectId: string; destTeamProjectId: string }>;
  rosterElevated: number;
  rosterToInvite: number;
  drainedDeleted: boolean;
  partial: boolean;
  failedProjectId?: string;
  error?: string;
}

interface MergeOrgWizardProps {
  drainedOrg: { orgId: string; name: string };
  /** Survivor candidates — orgs the caller owns/admins (drained filtered out). */
  survivorCandidates: { orgId: string; name: string }[];
  /** Counts for the summary (read from already-loaded org state). */
  projectCount: number;
  memberCount: number;
  onClose: () => void;
  onMerged: (result: MergeResultSummary) => void;
}

type Step = 'configure' | 'running' | 'done';

export function MergeOrgWizard({ drainedOrg, survivorCandidates, projectCount, memberCount, onClose, onMerged }: MergeOrgWizardProps) {
  const candidates = survivorCandidates.filter(o => o.orgId !== drainedOrg.orgId);
  const [step, setStep] = useState<Step>('configure');
  const [survivorOrgId, setSurvivorOrgId] = useState<string | null>(null);
  const [deleteDrained, setDeleteDrained] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MergeResultSummary | null>(null);

  const survivorName = candidates.find(o => o.orgId === survivorOrgId)?.name ?? '';
  const confirmOk = !!survivorOrgId && confirmText.trim() === drainedOrg.name.trim() && drainedOrg.name.length > 0;

  const runMerge = async () => {
    if (!survivorOrgId) return;
    setStep('running');
    setError(null);
    try {
      const res = await (window as any).electronAPI.team.mergeOrg(drainedOrg.orgId, survivorOrgId, deleteDrained);
      if (res?.success && res.result) {
        const r = res.result as MergeResultSummary;
        setResult(r);
        setStep('done');
        onMerged(r);
      } else {
        setError(res?.error || 'Merge failed');
        setStep('configure');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('configure');
    }
  };

  return (
    <div
      className="merge-org-wizard-overlay fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] p-4"
      onClick={step === 'running' ? undefined : onClose}
      data-testid="merge-org-wizard-overlay"
    >
      <div
        className="merge-org-wizard bg-[var(--nim-bg)] rounded-xl p-6 max-w-[520px] w-full max-h-[85vh] overflow-y-auto relative shadow-[0_20px_40px_rgba(0,0,0,0.3)]"
        onClick={(e) => e.stopPropagation()}
        data-testid="merge-org-wizard"
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[16px] font-semibold text-[var(--nim-text)] flex items-center gap-2">
            <MaterialSymbol icon="merge" size={20} className="text-[var(--nim-primary)]" />
            Merge organization into another
          </h3>
          {step !== 'running' && (
            <button className="text-[var(--nim-text-faint)] hover:text-[var(--nim-text)]" onClick={onClose} aria-label="Close" data-testid="merge-org-close">
              <MaterialSymbol icon="close" size={20} />
            </button>
          )}
        </div>
        <p className="text-[12px] text-[var(--nim-text-muted)] mb-4">
          Moves all of <span className="font-medium text-[var(--nim-text)]">{drainedOrg.name}</span>&apos;s projects
          ({projectCount}) and members ({memberCount}) into another organization. This cannot be undone.
        </p>

        {error && (
          <div className="mb-3 px-3 py-2 rounded-md bg-[var(--nim-error-bg,rgba(220,38,38,0.12))] text-[12px] text-[var(--nim-error,#dc2626)]" data-testid="merge-org-error">
            {error}
          </div>
        )}

        {step === 'configure' && (
          <div data-testid="merge-org-configure">
            {candidates.length === 0 ? (
              <p className="text-[13px] text-[var(--nim-text-muted)]">
                You don&apos;t own or admin another organization to merge into.
              </p>
            ) : (
              <>
                <label className="text-[12px] font-medium text-[var(--nim-text-muted)] block mb-1">Merge into (survivor)</label>
                <div className="flex flex-col gap-1.5 mb-4">
                  {candidates.map(o => (
                    <button
                      key={o.orgId}
                      className={`text-left px-3.5 py-2.5 rounded-lg border transition-colors ${
                        survivorOrgId === o.orgId
                          ? 'border-[var(--nim-primary)] bg-[var(--nim-primary-bg,rgba(99,102,241,0.1))]'
                          : 'border-[var(--nim-border)] hover:bg-[var(--nim-bg-secondary)]'
                      }`}
                      onClick={() => setSurvivorOrgId(o.orgId)}
                      data-testid={`merge-org-survivor-${o.orgId}`}
                    >
                      <span className="text-[13px] font-medium text-[var(--nim-text)]">{o.name}</span>
                    </button>
                  ))}
                </div>

                <label className="flex items-center gap-2 text-[12px] text-[var(--nim-text-muted)] mb-4 cursor-pointer">
                  <input type="checkbox" checked={deleteDrained} onChange={(e) => setDeleteDrained(e.target.checked)} data-testid="merge-org-delete-drained" />
                  Delete <span className="font-medium text-[var(--nim-text)]">{drainedOrg.name}</span> after the merge (only if it fully empties)
                </label>

                <label className="text-[12px] text-[var(--nim-text-muted)] block mb-1">
                  Type <span className="font-mono font-semibold text-[var(--nim-text)]">{drainedOrg.name}</span> to confirm:
                </label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  className="w-full px-3 py-2 text-[13px] rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)]"
                  placeholder={drainedOrg.name}
                  data-testid="merge-org-confirm-input"
                />
              </>
            )}
          </div>
        )}

        {step === 'running' && (
          <div className="py-6 text-center text-[13px] text-[var(--nim-text-muted)]" data-testid="merge-org-running">
            <MaterialSymbol icon="progress_activity" size={28} className="text-[var(--nim-primary)] animate-spin" />
            <div className="mt-2">Merging… moving projects, transferring access, uniting members.</div>
            <div className="mt-1 text-[11px] text-[var(--nim-text-faint)]">Do not close this window.</div>
          </div>
        )}

        {step === 'done' && result && (
          <div className="py-4 text-[13px] text-[var(--nim-text)]" data-testid="merge-org-done">
            <div className={`flex items-center gap-2 font-medium mb-2 ${result.partial ? 'text-[var(--nim-warning,#d97706)]' : 'text-[var(--nim-success,#16a34a)]'}`}>
              <MaterialSymbol icon={result.partial ? 'warning' : 'check_circle'} size={20} />
              {result.partial ? 'Merge partially completed' : `Merged into ${survivorName}`}
            </div>
            <ul className="text-[12px] text-[var(--nim-text-muted)] list-disc pl-5 space-y-0.5">
              <li>{result.movedProjects.length} project{result.movedProjects.length === 1 ? '' : 's'} moved</li>
              {result.rosterElevated > 0 && <li>{result.rosterElevated} member role{result.rosterElevated === 1 ? '' : 's'} elevated</li>}
              {result.rosterToInvite > 0 && <li>{result.rosterToInvite} member{result.rosterToInvite === 1 ? '' : 's'} invited to the survivor</li>}
              <li>{result.drainedDeleted ? `${drainedOrg.name} was deleted` : `${drainedOrg.name} kept`}</li>
              {result.partial && <li className="text-[var(--nim-warning,#d97706)]">Stopped at project {result.failedProjectId}: {result.error}</li>}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          {step === 'configure' && (
            <>
              <button className="px-3.5 py-2 text-[13px] rounded-md text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-secondary)]" onClick={onClose} data-testid="merge-org-cancel">
                Cancel
              </button>
              <button
                className="px-3.5 py-2 text-[13px] rounded-md bg-[var(--nim-error,#dc2626)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={runMerge}
                disabled={!confirmOk}
                data-testid="merge-org-run"
              >
                Merge organization
              </button>
            </>
          )}
          {step === 'done' && (
            <button className="px-3.5 py-2 text-[13px] rounded-md bg-[var(--nim-primary)] text-white" onClick={onClose} data-testid="merge-org-finish">
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
