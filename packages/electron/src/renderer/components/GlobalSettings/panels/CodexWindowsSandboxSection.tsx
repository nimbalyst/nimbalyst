import React, { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { WindowsSandboxMode, WindowsSandboxState } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/windowsSandbox';
import { activeWorkspacePathAtom } from '../../../store/atoms/openProjects';
import { openAICodexSandboxStateAtom } from '../../../store/atoms/openAICodexAuth';

export function CodexWindowsSandboxSection() {
  const workspacePath = useAtomValue(activeWorkspacePathAtom);
  const broadcastState = useAtomValue(openAICodexSandboxStateAtom);
  const [status, setStatus] = useState<WindowsSandboxState>({ phase: 'idle' });
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const current = broadcastState ?? status;
  const busy = checking || current.phase === 'running';

  const refresh = async () => {
    setChecking(true);
    setError(undefined);
    try { setStatus(await window.electronAPI.invoke('openai-codex:sandbox-status')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChecking(false); }
  };
  useEffect(() => { void refresh(); }, []);

  const setup = async (mode: WindowsSandboxMode) => {
    if (!workspacePath) return;
    setChecking(true);
    setError(undefined);
    try { setStatus(await window.electronAPI.invoke('openai-codex:sandbox-setup', mode, workspacePath)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChecking(false); }
  };

  return (
    <section className="py-4 mb-4 border-b border-[var(--nim-border)] text-sm text-[var(--nim-text)]">
      <h4 className="text-base font-semibold mb-3">Windows sandbox</h4>
      <p className="text-[var(--nim-text-muted)] mb-3">Enables Codex to edit your project with workspace permissions. Recommended setup may ask for Windows administrator approval.</p>
      <p role="status">{busy ? 'Checking or setting up Windows sandbox…' : current.readiness === 'ready' ? 'Sandbox configured.' : current.readiness === 'updateRequired' ? 'Sandbox update required.' : 'Sandbox setup required.'}</p>
      {(error || current.error) && <p role="alert" className="text-[var(--nim-error)] mt-2">{error || current.error}</p>}
      {!workspacePath && <p className="mt-2 text-[var(--nim-text-muted)]">Open a project to set up its sandbox.</p>}
      <div className="flex gap-3 mt-3 flex-wrap">
        {current.allowedModes?.includes('elevated') && <button className="btn-primary" disabled={busy || !workspacePath} onClick={() => void setup('elevated')}>Set up sandbox (recommended)</button>}
        {current.allowedModes?.includes('unelevated') && <button className="btn-secondary" disabled={busy || !workspacePath} onClick={() => void setup('unelevated')}>Set up without administrator access</button>}
        <button className="btn-secondary" disabled={busy} onClick={() => void refresh()}>Check status</button>
      </div>
    </section>
  );
}
