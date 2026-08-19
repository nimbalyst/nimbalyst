import React, { useCallback, useEffect, useState } from 'react';

export interface LocalKeyPrefixConfig {
  prefix: string;
  hasIssuedNumbers: boolean;
  matchesTeamPrefix: boolean;
  warning?: string;
}

const LOCAL_KEY_PREFIX_PATTERN = /^[A-Z]{2,5}$/;

export function LocalKeyPrefixInput({ config, teamPrefix, onChange }: {
  config: LocalKeyPrefixConfig;
  teamPrefix: string;
  onChange: (prefix: string) => Promise<LocalKeyPrefixConfig>;
}) {
  const [draft, setDraft] = useState(config.prefix);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(config.prefix);
    setError('');
  }, [config.prefix]);

  const handleBlur = useCallback(async () => {
    const upper = draft.trim().toUpperCase();
    if (!LOCAL_KEY_PREFIX_PATTERN.test(upper)) {
      setError('Must be 2-5 uppercase letters');
      return;
    }
    if (upper === config.prefix) return;

    // Renumbering is not what happens -- `NIM.42` becomes `NIC.42` -- but an
    // already-written reference to the old letters stops resolving, so say so
    // before doing it rather than after.
    if (config.hasIssuedNumbers && !window.confirm(
      `Rename this project's existing local numbers from ${config.prefix}. to ${upper}.?\n\n`
      + `The numbers themselves stay the same. Anything already referring to a `
      + `${config.prefix}. number will stop resolving.`,
    )) {
      setDraft(config.prefix);
      return;
    }

    setSaving(true);
    setError('');
    try {
      const next = await onChange(upper);
      setDraft(next.prefix);
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : 'Could not change the local prefix.');
    } finally {
      setSaving(false);
    }
  }, [config.prefix, draft, onChange]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      (event.target as HTMLInputElement).blur();
    }
  }, []);

  return (
    <div className="local-key-prefix-section provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
      <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)]">
        Local Number Prefix
      </h4>
      <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
        Private and draft items use a dot so agents cannot mistake them for shared keys (e.g., <code className="text-[11px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 py-[1px] rounded">{draft || 'NIM'}.42</code>).
      </p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          disabled={saving}
          onChange={(event) => {
            setDraft(event.target.value.toUpperCase());
            setError('');
          }}
          onBlur={() => void handleBlur()}
          onKeyDown={handleKeyDown}
          maxLength={5}
          placeholder="NIM"
          aria-label="Local tracker number prefix"
          className="local-key-prefix-input w-24 px-2.5 py-1.5 text-[13px] font-mono bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        />
        <span className="text-[13px] text-[var(--nim-text-faint)]">.123</span>
      </div>
      {error && <p className="text-[11px] text-[var(--nim-error)] mt-1.5">{error}</p>}
      {config.warning && !error && (
        <p className="local-key-prefix-warning text-[11px] text-[var(--nim-warning)] mt-1.5">{config.warning}</p>
      )}
      <p className="text-[11px] text-[var(--nim-text-faint)] mt-2">
        {config.hasIssuedNumbers
          ? `Changing this renames the numbers this project has already issued, keeping each number. Its team prefix is ${teamPrefix || 'not assigned'}.`
          : 'This project has not issued a local number yet, so changing the prefix affects nothing. Another local project cannot use the same prefix.'}
      </p>
    </div>
  );
}
