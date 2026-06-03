/**
 * GitHubAccountPanel — choose which `gh` CLI account the PR review feature
 * uses (issue #307). Follows the global-default + per-project-override pattern.
 *
 * - User scope: pick the GLOBAL default account.
 * - Project scope: pick an OVERRIDE for this project (or fall back to default).
 *
 * Nimbalyst stores only the chosen login; the token is resolved from gh's
 * keyring per request and never persisted.
 */

import { useCallback, useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { SettingsScope } from '../SettingsView';
import { getPullRequestService } from '../../../services/RendererPullRequestService';

interface GitHubAccountPanelProps {
  scope: SettingsScope;
  workspacePath?: string;
}

interface GhAccount {
  login: string;
  host: string;
  active: boolean;
}

export function GitHubAccountPanel({ scope, workspacePath }: GitHubAccountPanelProps): JSX.Element {
  const [accounts, setAccounts] = useState<GhAccount[]>([]);
  const [defaultAccount, setDefaultAccount] = useState<string | null>(null);
  const [override, setOverride] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const service = getPullRequestService();
  const isProject = scope === 'project' && !!workspacePath;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accs, config] = await Promise.all([
        service.listAccounts(),
        service.getAccountConfig(workspacePath),
      ]);
      setAccounts(accs);
      setDefaultAccount(config.defaultAccount);
      setOverride(config.override);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load GitHub accounts');
    } finally {
      setLoading(false);
    }
  }, [service, workspacePath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleDefaultChange = useCallback(
    async (login: string | null) => {
      setDefaultAccount(login);
      await service.setDefaultAccount(login);
    },
    [service],
  );

  const handleOverrideChange = useCallback(
    async (login: string | null) => {
      if (!workspacePath) return;
      setOverride(login);
      await service.setAccountOverride(workspacePath, login);
    },
    [service, workspacePath],
  );

  const noAccounts = !loading && accounts.length === 0;

  return (
    <div className="github-account-panel provider-panel flex flex-col" data-testid="github-account-panel">
      <div className="provider-panel-header mb-5 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-1.5 text-[var(--nim-text)]">
          GitHub Account
        </h3>
        <p className="provider-panel-description text-[13px] leading-relaxed text-[var(--nim-text-muted)]">
          {isProject
            ? 'Choose which GitHub CLI account PR review uses for this project. Useful when a project belongs to a different account than your default (e.g. work vs personal).'
            : 'Choose the default GitHub CLI account PR review uses. Each project can override this from its Project settings.'}
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-[var(--nim-text-muted)] text-sm">
          <div className="spinner w-4 h-4 border-[2px] border-[var(--nim-bg-secondary)] border-t-[var(--nim-primary)] rounded-full animate-spin" />
          Loading accounts…
        </div>
      ) : error ? (
        <div className="flex flex-col items-start gap-2 py-4 text-[var(--nim-error)] text-sm">
          <span>{error}</span>
          <button className="text-xs text-[var(--nim-primary)] hover:underline" onClick={() => void reload()}>
            Retry
          </button>
        </div>
      ) : noAccounts ? (
        <div className="flex items-start gap-2.5 p-3 bg-[rgba(96,165,250,0.08)] border border-[rgba(96,165,250,0.2)] rounded-lg text-[13px] text-[var(--nim-text-muted)]">
          <MaterialSymbol icon="info" size={16} className="text-[var(--nim-primary)] shrink-0 mt-0.5" />
          <div>
            No GitHub CLI accounts found. Run <code className="text-[11px] bg-[var(--nim-code-bg)] px-1 py-[1px] rounded">gh auth login</code> in your terminal, then reload.
          </div>
        </div>
      ) : (
        <div className="provider-panel-section py-2">
          <label className="block text-[13px] font-medium text-[var(--nim-text)] mb-2">
            {isProject ? 'Account for this project' : 'Default account'}
          </label>
          <select
            data-testid="github-account-select"
            className="w-full max-w-sm px-2.5 py-2 text-[13px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] transition-colors"
            value={isProject ? override ?? '' : defaultAccount ?? ''}
            onChange={(e) => {
              const value = e.target.value || null;
              if (isProject) void handleOverrideChange(value);
              else void handleDefaultChange(value);
            }}
          >
            <option value="">
              {isProject
                ? `Use default${defaultAccount ? ` (${defaultAccount})` : ''}`
                : 'Active gh account (no preference)'}
            </option>
            {accounts.map((acc) => (
              <option key={`${acc.host}:${acc.login}`} value={acc.login}>
                {acc.login}
                {acc.host !== 'github.com' ? ` — ${acc.host}` : ''}
                {acc.active ? ' (active)' : ''}
              </option>
            ))}
          </select>

          {isProject && (
            <p className="text-[11px] text-[var(--nim-text-faint)] mt-2">
              Effective account:{' '}
              <strong className="text-[var(--nim-text-muted)]">
                {override ?? defaultAccount ?? 'active gh account'}
              </strong>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
