import React, { useState } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';

import { ApiKeyProviderPanel } from './ApiKeyProviderPanel';
import { refreshOllamaUsage } from '../../../store/listeners/ollamaUsageListeners';
import { activeWorkspacePathAtom } from '../../../store/atoms/openProjects';
import { ollamaUsageAtom, type OllamaUsageData } from '../../../store/atoms/ollamaUsageAtoms';

export function OllamaPanel() {
  const workspacePath = useAtomValue(activeWorkspacePathAtom);
  const usage = useAtomValue(ollamaUsageAtom);
  const setUsage = useSetAtom(ollamaUsageAtom);
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const forgetSignIn = async () => {
    if (!workspacePath) return;
    setBusy(true);
    setNotice(null);
    try {
      await window.electronAPI.invoke('ollama-usage:disconnect', workspacePath);
      await refreshOllamaUsage();
      setNotice('Ollama sign-in forgotten.');
    } catch {
      setNotice('Ollama sign-in could not be cleared.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ApiKeyProviderPanel
        providerId="ollama"
        providerLabel="Ollama"
        description="Optionally save an Ollama API key for existing integrations. Sign in to your Ollama account below to show usage, plan, credits, and limits."
        fieldLabel="Ollama API key"
        getKeyUrl="https://ollama.com/settings"
        getKeyLabel="Get a key from Ollama"
        testId="ollama-provider-settings"
        onChanged={refreshOllamaUsage}
      />
      <section className="mt-6 max-w-[640px] border-t border-nim pt-4">
        <h3 className="mb-2 font-semibold text-nim">Ollama account usage</h3>
        <p className="mb-3 text-sm text-nim-muted">
          Sign-in is stored privately for this feature on this device. The API key is separate from dashboard sign-in.
        </p>
        <p className="mb-3 text-sm text-nim-muted" role="status">
          {usage?.error ?? (usage?.authStatus === 'connected' ? `Connected${usage.plan ? ` · ${usage.plan} plan` : ''}` : usage?.authStatus === 'sign-in-required' ? 'Sign-in required to show usage.' : 'Usage sign-in status is not available yet.')}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="nim-button"
            disabled={!workspacePath || busy}
            onClick={async () => {
              if (!workspacePath) return;
              setBusy(true);
              setNotice(null);
              try {
                const result = await window.electronAPI.invoke('ollama-usage:connect', workspacePath) as OllamaUsageData | null;
                if (result && store.get(activeWorkspacePathAtom) === workspacePath) setUsage(result);
                if (result?.source === 'ollama-dashboard' && result.authStatus === 'connected' && !result.error) {
                  setNotice('Ollama account connected.');
                } else if (result?.authStatus === 'sign-in-required') {
                  setNotice('Ollama sign-in was cancelled or did not complete.');
                } else {
                  setNotice('Ollama sign-in could not be verified.');
                }
              } catch {
                setNotice('Ollama sign-in could not be completed.');
              } finally {
                setBusy(false);
              }
            }}
          >
            Sign in to Ollama
          </button>
          <button type="button" className="nim-button" disabled={!workspacePath || busy} onClick={() => void forgetSignIn()}>
            Forget sign-in
          </button>
          <button type="button" className="nim-button" disabled={!workspacePath || busy} onClick={() => void refreshOllamaUsage()}>
            Refresh usage
          </button>
        </div>
        {notice && <p className="mt-3 text-sm text-nim-muted" role="status">{notice}</p>}
      </section>
    </>
  );
}
