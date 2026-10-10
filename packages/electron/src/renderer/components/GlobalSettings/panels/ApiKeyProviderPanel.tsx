import React, { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';

import {
  changeProviderCredential,
  providerCredentialErrorAtom,
  providerCredentialsAtom,
  refreshProviderCredentials,
} from '../../../store/providerCredentials';

export interface ApiKeyProviderPanelProps {
  /** The provider name stored in the credential vault, e.g. 'ollama', 'openrouter', 'deepseek'. */
  providerId: string;
  providerLabel: string;
  description: string;
  fieldLabel: string;
  getKeyUrl: string;
  getKeyLabel: string;
  testId: string;
  /** Extra side effect to run after a successful save/clear, e.g. refreshing a usage meter. */
  onChanged?: () => unknown;
}

export function ApiKeyProviderPanel({
  providerId,
  providerLabel,
  description,
  fieldLabel,
  getKeyUrl,
  getKeyLabel,
  testId,
  onChanged,
}: ApiKeyProviderPanelProps) {
  const snapshot = useAtomValue(providerCredentialsAtom);
  const secureStorageError = useAtomValue(providerCredentialErrorAtom);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const configured = snapshot?.credentials.some(
    (credential) => credential.name === providerId && !credential.workspacePath,
  ) ?? false;
  const fieldId = `${providerId}-api-key`;

  useEffect(() => {
    void refreshProviderCredentials();
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = apiKey.trim();
    if (!value) return;
    setBusy(true);
    setNotice(null);
    try {
      await changeProviderCredential(providerId, value);
      setApiKey('');
      setNotice(`${providerLabel} API key saved securely on this device.`);
      await onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await changeProviderCredential(providerId, null);
      setNotice(`${providerLabel} API key cleared.`);
      await onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${providerId}-provider-panel max-w-[640px]`} data-testid={testId}>
      <h2 className="mb-2 text-lg font-semibold text-[var(--nim-text)]">{providerLabel}</h2>
      <p className="mb-4 text-sm text-[var(--nim-text-muted)]">{description}</p>

      <form onSubmit={save} className="space-y-3">
        <label className="block text-sm font-medium text-[var(--nim-text)]" htmlFor={fieldId}>
          {fieldLabel}
        </label>
        <input
          id={fieldId}
          data-testid={`${providerId}-api-key-input`}
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={configured ? 'A key is saved; enter a replacement' : `Paste your ${providerLabel} API key`}
          className="w-full rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 py-2 text-sm text-[var(--nim-text)]"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="nim-button" disabled={busy || !apiKey.trim()}>
            {busy ? 'Saving…' : configured ? 'Replace key' : 'Save key'}
          </button>
          {configured && (
            <button type="button" className="nim-button" disabled={busy} onClick={() => void clear()}>
              Clear key
            </button>
          )}
          <button
            type="button"
            className="text-sm text-[var(--nim-primary)] hover:underline"
            onClick={() => window.electronAPI.openExternal(getKeyUrl)}
          >
            {getKeyLabel}
          </button>
        </div>
      </form>

      <p className="mt-3 text-sm text-[var(--nim-text-muted)]" role="status">
        {configured ? `${providerLabel} API key configured.` : `No ${providerLabel} API key saved.`}
      </p>
      {(secureStorageError || snapshot?.message) && (
        <p className="mt-2 text-sm text-[var(--nim-error)]" role="alert">
          {secureStorageError || snapshot?.message}
        </p>
      )}
      {notice && <p className="mt-2 text-sm text-[var(--nim-success)]">{notice}</p>}
    </section>
  );
}
