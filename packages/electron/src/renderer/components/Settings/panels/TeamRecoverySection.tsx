import React, { useEffect, useRef, useState } from 'react';
import { TEAM_RECOVERY_PASSPHRASE_COMMANDS, type TeamRecoveryCommand, type TeamRecoveryOverview } from '../../../../shared/teamRecovery';

const buttonClass = 'rounded border border-[var(--nim-border)] px-3 py-1.5 text-xs text-[var(--nim-text)] disabled:cursor-not-allowed disabled:opacity-40';

export function TeamRecoverySection({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);
  const [overview, setOverview] = useState<TeamRecoveryOverview | null>(null);
  const [busy, setBusy] = useState<TeamRecoveryCommand | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const generation = useRef(0);
  const opened = useRef(false);
  useEffect(() => {
    generation.current++;
    setOpen(false); setOverview(null); setBusy(null); setError(null); setPassword(''); setReviewed(false);
    return () => {
      generation.current++;
      // Main holds this organization's decrypted recovery content between steps.
      // Leaving the section, or switching organization, drops it; resuming
      // re-imports the saved bundle and the server keeps every checkpoint.
      if (opened.current) {
        opened.current = false;
        try { void Promise.resolve(window.electronAPI.team.recovery(orgId, 'release')).catch(() => undefined); } catch { /* Unmounting must not throw. */ }
      }
    };
  }, [orgId]);

  const run = async (command: TeamRecoveryCommand) => {
    const current = generation.current;
    opened.current = true;
    setBusy(command); setError(null);
    if (['inspect', 'collect', 'import', 'reset'].includes(command)) setReviewed(false);
    try {
      const response = await window.electronAPI.team.recovery(orgId, command, TEAM_RECOVERY_PASSPHRASE_COMMANDS.has(command) ? { password } : {});
      if (current !== generation.current) return;
      if (response.overview && response.overview.orgId !== orgId) throw new Error('Recovery organization changed; reopen these settings');
      if (response.overview) setOverview(response.overview);
      if (!response.success || !response.overview) throw new Error(response.error || 'Recovery is unavailable');
      if (response.overview.orgId !== orgId) throw new Error('Recovery organization changed; reopen these settings');
      setOverview(response.overview);
      if (response.overview.operation?.phase === 'completed') setPassword('');
    } catch (failure) {
      if (current === generation.current) setError(failure instanceof Error ? failure.message : 'Recovery request failed. Check its status before retrying.');
    } finally { if (current === generation.current) setBusy(null); }
  };
  const operation = overview?.operation;
  const complete = operation?.phase === 'completed';
  const validPassword = password.length >= 16 && password.length <= 1024;
  const restored = operation?.rooms.filter(room => room.restored).length ?? 0;
  const verified = operation?.rooms.filter(room => room.verified).length ?? 0;

  return <div className="team-recovery-section mt-4 border-t border-[var(--nim-border)] pt-3">
    {!open ? <button className={buttonClass} type="button" onClick={() => { setOpen(true); void run('status'); }}>Recover this organization</button> : <div className="space-y-3 select-text">
      <h4 className="m-0 text-sm font-semibold text-[var(--nim-text)]">Recover collaboration in place</h4>
      <p className="m-0 text-xs text-[var(--nim-text-muted)]">An owner or administrator can preserve this organization’s projects, documents, and ticket numbers. Start by inspecting it and collecting complete sources. Keep every device’s local data until recovery is verified.</p>
      <p className="m-0 break-all text-xs text-[var(--nim-text-faint)]">Organization: {orgId}</p>
      {error && <p role="alert" className="m-0 text-xs text-[var(--nim-warning)]">{error}</p>}
      {busy && <p role="status" className="m-0 text-xs text-[var(--nim-text-muted)]">{busy === 'restore' ? 'Restoring content and recording checkpoints…' : busy === 'verify' ? 'Reading back every restored object and checking its contents…' : 'Checking and preserving recovery sources…'} Keep this window open.</p>}
      {complete ? <p role="status" className="m-0 text-xs text-[var(--nim-success)]">Recovery verified and complete. Team sync can resume. Keep the encrypted recovery bundle and original devices until you have checked your documents and ticket references.</p> : <>
        {!operation && <div className="flex flex-wrap gap-2">
          <button className={buttonClass} type="button" disabled={!!busy} onClick={() => void run('inspect')}>Inspect organization</button>
          <button className={buttonClass} type="button" disabled={!!busy || !overview?.diagnostics} onClick={() => void run('collect')}>Collect sources from a folder</button>
        </div>}
        {overview && <p className="m-0 text-xs text-[var(--nim-text)]">{overview.counts.projects} projects · {overview.counts.items} tickets · {overview.counts.documents} readable bodies · {overview.counts.attachments} attachments</p>}
        {!!overview?.blockers.length && <div className="rounded border border-[var(--nim-warning)] p-2">
          <p className="m-0 text-xs font-medium text-[var(--nim-warning)]">Recovery cannot start: {overview.blockers.length} sources or identities need attention.</p>
          <ul className="my-2 max-h-40 overflow-y-auto pl-4 text-xs text-[var(--nim-text-muted)]">{overview.blockers.map((blocker, index) => <li key={`${blocker.id}-${index}`}><span>{blocker.reason}</span><span className="ml-1 break-all text-[var(--nim-text-faint)]">({blocker.id})</span></li>)}</ul>
          <p className="m-0 text-xs text-[var(--nim-text-muted)]">You can save these sources now, then import a bundle collected from another device. Missing current content is never replaced with an empty document.</p>
        </div>}
        {!!overview?.notices?.length && <ul className="team-recovery-notices m-0 pl-4 text-xs text-[var(--nim-text-muted)]">{overview.notices.map(notice => <li key={notice.id}>{notice.reason}</li>)}</ul>}
        {!!overview?.identityAssignments.length && <details>
          <summary className="cursor-pointer text-xs text-[var(--nim-text)]">Review {overview.identityAssignments.length} ticket assignments</summary>
          <ul className="max-h-48 overflow-y-auto pl-4 text-xs text-[var(--nim-text-muted)]">{overview.identityAssignments.map(item => <li className="break-all" key={`${item.projectId}:${item.itemId}`}><strong>{item.issueKey ?? 'Unassigned'}</strong> → {item.itemId} ({item.existing ? 'existing server item' : 'preserved local item'})</li>)}</ul>
        </details>}
        <label className="block text-xs text-[var(--nim-text-muted)]">Recovery bundle passphrase
          <input className="mt-1 block w-full rounded border border-[var(--nim-border)] bg-[var(--nim-bg-primary)] p-2 text-[var(--nim-text)]" type="password" autoComplete="off" minLength={16} maxLength={1024} value={password} disabled={!!busy} onChange={event => setPassword(event.target.value)} placeholder="At least 16 characters; keep it separately from the bundle" />
        </label>
        <div className="flex flex-wrap gap-2">
          {!operation && <button className={buttonClass} type="button" disabled={!!busy || !overview?.diagnostics || !validPassword} onClick={() => void run('save')}>Save encrypted bundle</button>}
          <button className={buttonClass} type="button" disabled={!!busy || !validPassword} onClick={() => void run('import')}>Import encrypted bundle</button>
          <button className={buttonClass} type="button" disabled={!!busy} onClick={() => void run('status')}>Refresh recovery status</button>
          <button className={buttonClass} type="button" disabled={!!busy} onClick={() => void run('export-diagnostics')}>Export diagnostics</button>
        </div>
        {overview?.saved && <p className="m-0 text-xs text-[var(--nim-success)]">Encrypted bundle saved and read back successfully: {overview.artifactName}</p>}
        {!operation && overview && <>
          <p className="m-0 text-xs text-[var(--nim-text-muted)]">Starting pauses team writes while current content is restored under Nimbalyst-managed encryption. Original server records and attachments are retained. Retained historical ciphertext may remain unreadable.</p>
          <label className="flex items-start gap-2 text-xs text-[var(--nim-text)]"><input type="checkbox" checked={reviewed} disabled={!!busy || !overview.ready || !overview.saved} onChange={event => setReviewed(event.target.checked)} />I reviewed this organization, its ticket assignments, and source coverage, and have kept the encrypted bundle.</label>
          <button className={buttonClass} type="button" disabled={!!busy || !overview.ready || !overview.saved || !reviewed || !validPassword} onClick={() => void run('restore')}>Start recovery</button>
        </>}
        {operation && <>
          <p className="m-0 text-xs text-[var(--nim-text)]">Recovery {operation.phase}: {restored}/{operation.rooms.length} content groups restored, {verified}/{operation.rooms.length} verified.</p>
          <p className="m-0 text-xs text-[var(--nim-text-muted)]">Recovery stays paused across disconnects and restarts. Import the same saved bundle to continue. Local edits remain on their devices.</p>
          {['fenced', 'restoring', 'resetting'].includes(operation.phase) && !operation.rooms.some(room => room.restored) && <div>
            <button className={buttonClass} type="button" disabled={!!busy} onClick={() => void run('reset')}>Recheck changed sources</button>
            <p className="m-0 text-xs text-[var(--nim-text-muted)]">Available only before any content has been replaced. The server checks every saved checkpoint before allowing a new inspection.</p>
          </div>}
          {['fenced', 'restoring'].includes(operation.phase) ? <button className={buttonClass} type="button" disabled={!!busy || !overview?.saved || !validPassword} onClick={() => void run('restore')}>Resume recovery</button>
            : operation.phase === 'resetting' ? null : overview?.independentClient ? <button className={buttonClass} type="button" disabled={!!busy || !overview.saved || !validPassword} onClick={() => void run('verify')}>Verify all content and resume sync</button>
              : <p className="m-0 text-xs text-[var(--nim-warning)]">On a second Nimbalyst device, open this organization’s Security &amp; Encryption settings and import the saved bundle. That device must verify the restored content before sync resumes.</p>}
        </>}
      </>}
    </div>}
  </div>;
}
