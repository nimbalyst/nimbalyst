import { useCallback, useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

/**
 * Epic H3 P3 — "Move project to another org" wizard.
 *
 * Drives the server move engine (P1 data relocation + P2 grant transfer) from
 * the UI. Multi-step because the operation is destructive and cross-org:
 *   1. pick destination org (orgs the caller owns/admins)
 *   2. review pre-flight (custody block, slug collision, per-member seat delta,
 *      per-person opt-out) — read-only `move-project/preview`
 *   3. typed confirmation, then run `move-project`
 *   4. result
 *
 * Gated server-side on server-managed custody (both orgs) and admin on both —
 * the wizard surfaces the custody block and routes the admin to update encryption
 * rather than attempting a move that would 409.
 */

interface MovePreviewMember {
  email: string | null;
  projectRole: string;
  inDest: boolean;
  willInvite: boolean;
}
interface MovePreview {
  projectId: string;
  slug: string | null;
  slugCollision: boolean;
  custodyBlocked: boolean;
  members: MovePreviewMember[];
  seatDelta: number;
}
interface MoveResultSummary {
  destTeamProjectId: string;
  movedDocuments: number;
  grantsTransferred: number;
  grantsPending: number;
  grantsDropped: number;
  grantsSkipped: number;
}

interface MoveProjectWizardProps {
  srcOrgId: string;
  project: { projectId: string; name: string };
  /** Orgs the caller owns/admins (the source org is filtered out internally). */
  destCandidates: { orgId: string; name: string }[];
  onClose: () => void;
  onMoved: (result: MoveResultSummary) => void;
  /** P5: deep-link the custody-blocked branch into the H2 "update encryption"
   *  migration surface (closes the wizard and reveals Security & Encryption). */
  onUpdateEncryption?: () => void;
}

type Step = 'pick' | 'review' | 'running' | 'done';

export function MoveProjectWizard({ srcOrgId, project, destCandidates, onClose, onMoved, onUpdateEncryption }: MoveProjectWizardProps) {
  const candidates = destCandidates.filter(o => o.orgId !== srcOrgId);
  const [step, setStep] = useState<Step>('pick');
  const [destOrgId, setDestOrgId] = useState<string | null>(null);
  const [preview, setPreview] = useState<MovePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Emails the admin opted OUT of (dropped instead of transferred/invited).
  const [optedOut, setOptedOut] = useState<Set<string>>(new Set());
  const [confirmText, setConfirmText] = useState('');
  const [result, setResult] = useState<MoveResultSummary | null>(null);

  const destName = candidates.find(o => o.orgId === destOrgId)?.name ?? '';
  const projectLabel = project.name || 'this project';

  const loadPreview = useCallback(async (dest: string) => {
    setPreviewLoading(true);
    setError(null);
    try {
      const res = await (window as any).electronAPI.team.moveProjectPreview(srcOrgId, project.projectId, dest);
      if (res?.success && res.preview) {
        setPreview(res.preview as MovePreview);
        setStep('review');
      } else {
        setError(res?.error || 'Failed to load move preview');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  }, [srcOrgId, project.projectId]);

  // When a destination is picked, fetch the preview.
  useEffect(() => {
    if (destOrgId) loadPreview(destOrgId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destOrgId]);

  const toggleOptOut = (email: string) => {
    setOptedOut(prev => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email); else next.add(email);
      return next;
    });
  };

  const runMove = async () => {
    if (!destOrgId) return;
    setStep('running');
    setError(null);
    try {
      const dropMemberEmails = Array.from(optedOut);
      const res = await (window as any).electronAPI.team.moveProject(
        srcOrgId, project.projectId, destOrgId, dropMemberEmails.length ? dropMemberEmails : undefined,
      );
      if (res?.success && res.result) {
        setResult(res.result as MoveResultSummary);
        setStep('done');
        onMoved(res.result as MoveResultSummary);
      } else {
        setError(res?.error || 'Move failed');
        setStep('review');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('review');
    }
  };

  const confirmOk = confirmText.trim() === destName.trim() && destName.length > 0;
  const seatDelta = preview
    ? preview.members.filter(m => m.willInvite && (!m.email || !optedOut.has(m.email))).length
    : 0;

  return (
    <div
      className="move-project-wizard-overlay fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] p-4"
      onClick={step === 'running' ? undefined : onClose}
      data-testid="move-project-wizard-overlay"
    >
      <div
        className="move-project-wizard bg-[var(--nim-bg)] rounded-xl p-6 max-w-[520px] w-full max-h-[85vh] overflow-y-auto relative shadow-[0_20px_40px_rgba(0,0,0,0.3)]"
        onClick={(e) => e.stopPropagation()}
        data-testid="move-project-wizard"
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[16px] font-semibold text-[var(--nim-text)] flex items-center gap-2">
            <MaterialSymbol icon="drive_file_move" size={20} className="text-[var(--nim-primary)]" />
            Move project to another organization
          </h3>
          {step !== 'running' && (
            <button
              className="text-[var(--nim-text-faint)] hover:text-[var(--nim-text)]"
              onClick={onClose}
              data-testid="move-project-wizard-close"
              aria-label="Close"
            >
              <MaterialSymbol icon="close" size={20} />
            </button>
          )}
        </div>
        <p className="text-[12px] text-[var(--nim-text-muted)] mb-4">
          Moving <span className="font-medium text-[var(--nim-text)]">{projectLabel}</span> relocates its trackers,
          documents, and member access into another organization. The originals are removed from this org.
        </p>

        {error && (
          <div className="mb-3 px-3 py-2 rounded-md bg-[var(--nim-error-bg,rgba(220,38,38,0.12))] text-[12px] text-[var(--nim-error,#dc2626)]" data-testid="move-project-wizard-error">
            {error}
          </div>
        )}

        {/* Step 1: pick destination */}
        {step === 'pick' && (
          <div data-testid="move-project-wizard-pick">
            {candidates.length === 0 ? (
              <p className="text-[13px] text-[var(--nim-text-muted)]">
                You don&apos;t own or admin any other organization to move this project into.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <label className="text-[12px] font-medium text-[var(--nim-text-muted)] mb-1">Destination organization</label>
                {candidates.map(o => (
                  <button
                    key={o.orgId}
                    className={`text-left px-3.5 py-2.5 rounded-lg border transition-colors ${
                      destOrgId === o.orgId
                        ? 'border-[var(--nim-primary)] bg-[var(--nim-primary-bg,rgba(99,102,241,0.1))]'
                        : 'border-[var(--nim-border)] hover:bg-[var(--nim-bg-secondary)]'
                    }`}
                    onClick={() => setDestOrgId(o.orgId)}
                    data-testid={`move-project-dest-${o.orgId}`}
                  >
                    <span className="text-[13px] font-medium text-[var(--nim-text)]">{o.name}</span>
                  </button>
                ))}
                {previewLoading && (
                  <div className="text-[12px] text-[var(--nim-text-faint)] mt-2">Loading preview…</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 2: review */}
        {step === 'review' && preview && (
          <div data-testid="move-project-wizard-review">
            {preview.custodyBlocked ? (
              <div className="px-3 py-3 rounded-md bg-[var(--nim-warning-bg,rgba(217,119,6,0.12))] text-[12px] text-[var(--nim-text)]" data-testid="move-project-custody-blocked">
                <div className="font-medium mb-1 flex items-center gap-1.5">
                  <MaterialSymbol icon="lock" size={16} /> Encryption update required
                </div>
                This move needs both organizations on server-managed encryption. Update this team&apos;s encryption
                (Security &amp; Encryption) before moving the project.
              </div>
            ) : (
              <>
                <div className="text-[13px] text-[var(--nim-text)] mb-2">
                  Moving to <span className="font-semibold">{destName}</span>.
                </div>
                {preview.slugCollision && (
                  <div className="mb-3 px-3 py-2 rounded-md bg-[var(--nim-warning-bg,rgba(217,119,6,0.12))] text-[12px] text-[var(--nim-text)]" data-testid="move-project-slug-collision">
                    A project with this name already exists in {destName}. Both will coexist; deep links may be ambiguous.
                  </div>
                )}

                <div className="text-[12px] font-medium text-[var(--nim-text-muted)] mt-3 mb-1.5">
                  Members &amp; access ({preview.members.length})
                </div>
                <div className="bg-[var(--nim-bg-secondary)] rounded-lg overflow-hidden mb-2">
                  {preview.members.length === 0 && (
                    <div className="px-3.5 py-2.5 text-[12px] text-[var(--nim-text-faint)]">No project-specific grants to transfer.</div>
                  )}
                  {preview.members.map((m, i) => {
                    const email = m.email;
                    const dropped = email != null && optedOut.has(email);
                    return (
                      <div key={email ?? `noemail-${i}`} className="flex items-center gap-2.5 px-3.5 py-2 border-b border-[var(--nim-bg)] last:border-b-0">
                        <input
                          type="checkbox"
                          checked={!dropped}
                          disabled={!email}
                          onChange={() => email && toggleOptOut(email)}
                          data-testid={`move-project-member-${email ?? 'noemail'}`}
                          title={email ? 'Uncheck to drop this member from the destination' : 'No email on record — cannot transfer'}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] text-[var(--nim-text)] truncate">{email ?? '(no email on record)'}</div>
                          <div className="text-[11px] text-[var(--nim-text-faint)]">
                            {m.projectRole.replace('project-', '')}
                            {m.willInvite && !dropped && <span className="text-[var(--nim-primary)]"> · will be invited (new seat)</span>}
                            {m.inDest && <span> · already a member</span>}
                            {dropped && <span className="text-[var(--nim-error,#dc2626)]"> · dropped</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="text-[12px] text-[var(--nim-text-muted)] mb-3" data-testid="move-project-seat-delta">
                  Seat impact on {destName}: <span className="font-semibold text-[var(--nim-text)]">+{seatDelta}</span> {seatDelta === 1 ? 'seat' : 'seats'}.
                </div>

                <label className="text-[12px] text-[var(--nim-text-muted)] block mb-1">
                  Type <span className="font-mono font-semibold text-[var(--nim-text)]">{destName}</span> to confirm this move:
                </label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  className="w-full px-3 py-2 text-[13px] rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] mb-1"
                  placeholder={destName}
                  data-testid="move-project-confirm-input"
                />
              </>
            )}
          </div>
        )}

        {/* Step 3: running */}
        {step === 'running' && (
          <div className="py-6 text-center text-[13px] text-[var(--nim-text-muted)]" data-testid="move-project-wizard-running">
            <MaterialSymbol icon="progress_activity" size={28} className="text-[var(--nim-primary)] animate-spin" />
            <div className="mt-2">Moving project… relocating trackers, documents, and access.</div>
            <div className="mt-1 text-[11px] text-[var(--nim-text-faint)]">Do not close this window.</div>
          </div>
        )}

        {/* Step 4: done */}
        {step === 'done' && result && (
          <div className="py-4 text-[13px] text-[var(--nim-text)]" data-testid="move-project-wizard-done">
            <div className="flex items-center gap-2 text-[var(--nim-success,#16a34a)] font-medium mb-2">
              <MaterialSymbol icon="check_circle" size={20} /> Project moved to {destName}
            </div>
            <ul className="text-[12px] text-[var(--nim-text-muted)] list-disc pl-5 space-y-0.5">
              <li>{result.movedDocuments} document{result.movedDocuments === 1 ? '' : 's'} relocated</li>
              <li>{result.grantsTransferred} member grant{result.grantsTransferred === 1 ? '' : 's'} transferred</li>
              {result.grantsPending > 0 && <li>{result.grantsPending} invited (grant activates on accept)</li>}
              {result.grantsDropped > 0 && <li>{result.grantsDropped} dropped per your selection</li>}
              {result.grantsSkipped > 0 && <li>{result.grantsSkipped} skipped (no email on record)</li>}
            </ul>
          </div>
        )}

        {/* Footer actions */}
        <div className="flex justify-end gap-2 mt-5">
          {step === 'review' && !preview?.custodyBlocked && (
            <>
              <button
                className="px-3.5 py-2 text-[13px] rounded-md text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-secondary)]"
                onClick={() => { setStep('pick'); setPreview(null); setConfirmText(''); }}
                data-testid="move-project-back"
              >
                Back
              </button>
              <button
                className="px-3.5 py-2 text-[13px] rounded-md bg-[var(--nim-primary)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={runMove}
                disabled={!confirmOk}
                data-testid="move-project-run"
              >
                Move project
              </button>
            </>
          )}
          {step === 'review' && preview?.custodyBlocked && onUpdateEncryption && (
            <button
              className="px-3.5 py-2 text-[13px] rounded-md bg-[var(--nim-primary)] text-white"
              onClick={() => { onClose(); onUpdateEncryption(); }}
              data-testid="move-project-update-encryption"
            >
              Update encryption
            </button>
          )}
          {(step === 'pick' || (step === 'review' && preview?.custodyBlocked)) && (
            <button
              className="px-3.5 py-2 text-[13px] rounded-md text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-secondary)]"
              onClick={onClose}
              data-testid="move-project-cancel"
            >
              Cancel
            </button>
          )}
          {step === 'done' && (
            <button
              className="px-3.5 py-2 text-[13px] rounded-md bg-[var(--nim-primary)] text-white"
              onClick={onClose}
              data-testid="move-project-finish"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
