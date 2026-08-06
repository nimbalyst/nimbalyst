import React, { useCallback, useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

type KeyCustodyMode = 'server-managed' | 'unmigrated';

interface Props {
  orgId: string;
}

/**
 * Organization encryption is server-managed product infrastructure and is the
 * only supported mode. This surface reports whether the organization carries
 * the server-managed marker; one that does not was never converted and the
 * server refuses its team data, so it has to be set up again.
 */
export function SecurityEncryptionSection({ orgId }: Props) {
  const [mode, setMode] = useState<KeyCustodyMode | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const statusResult = await window.electronAPI.team.getKeyCustodyStatus(orgId);
      // Anything other than an explicit success + server-managed is treated as
      // unusable. An unknown value must not read as "fine".
      setMode(statusResult?.success && statusResult.mode === 'server-managed'
        ? 'server-managed'
        : 'unmigrated');
    } catch {
      setMode(null);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const unmigrated = mode === 'unmigrated';

  return (
    <section
      className="security-encryption-section rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-4"
      data-testid="organization-security-encryption"
      data-component="SecurityEncryptionSection"
    >
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 ${unmigrated ? 'text-[var(--nim-warning)]' : 'text-[var(--nim-success)]'}`}>
          <MaterialSymbol icon="verified_user" size={22} fill />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[15px] font-semibold text-[var(--nim-text)]">Encrypted by Nimbalyst</h3>
          <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-[var(--nim-text-muted)]">
            Team data is encrypted in transit and at rest with keys managed by Nimbalyst. This is
            separate from Personal sync encryption, whose keys remain only on your devices.
          </p>

          {loading ? (
            <p className="m-0 mt-3 text-xs text-[var(--nim-text-faint)]">Checking encryption status…</p>
          ) : unmigrated ? (
            <div
              className="organization-encryption-diagnostic mt-3 rounded-md border border-[var(--nim-warning)] bg-[rgba(251,191,36,0.08)] p-3"
              data-testid="organization-encryption-unmigrated"
            >
              <p className="m-0 text-xs font-semibold text-[var(--nim-warning)]">
                This organization uses retired encryption
              </p>
              <p className="m-0 mt-1 select-text text-xs text-[var(--nim-text-muted)]">
                It was never moved to Nimbalyst-managed encryption, which is now the only supported
                mode. Team documents and trackers are unavailable for it. Create a new organization
                and re-share this team&apos;s content.
              </p>
            </div>
          ) : mode === null ? (
            <p className="m-0 mt-3 text-xs text-[var(--nim-text-faint)]">
              Encryption status is unavailable right now.
            </p>
          ) : (
            <p className="m-0 mt-3 inline-flex items-center gap-1.5 text-xs text-[var(--nim-success)]">
              <MaterialSymbol icon="check_circle" size={14} fill />
              Encryption active
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
