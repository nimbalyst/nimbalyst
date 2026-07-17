import React, { useCallback, useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

type KeyCustodyMode = 'legacy-e2e' | 'server-managed';
type MigrationDiagnostic =
  | { status: 'migrating'; startedAt: string }
  | { status: 'complete'; finishedAt: string }
  | { status: 'stuck'; failedAt: string; message: string };

interface Props {
  orgId: string;
  workspacePath?: string;
  isAdmin: boolean;
}

/**
 * Organization encryption is server-managed product infrastructure. Legacy
 * organizations migrate silently in main; this surface intentionally exposes
 * status only and never offers a custody choice, confirmation, or retry action.
 */
export function SecurityEncryptionSection({ orgId }: Props) {
  const [mode, setMode] = useState<KeyCustodyMode | null>(null);
  const [migration, setMigration] = useState<MigrationDiagnostic | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [statusResult, migrationResult] = await Promise.all([
        window.electronAPI.team.getKeyCustodyStatus(orgId),
        window.electronAPI.team.getEncryptionMigrationStatus?.(orgId),
      ]);
      setMode(statusResult?.success && statusResult.mode ? statusResult.mode : null);
      setMigration(migrationResult?.success ? migrationResult.migration ?? null : null);
    } catch {
      setMode(null);
      setMigration(null);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const updating = mode === 'legacy-e2e' || migration?.status === 'migrating';
  const stuck = migration?.status === 'stuck' ? migration : null;

  return (
    <section
      className="security-encryption-section rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-4"
      data-testid="organization-security-encryption"
      data-component="SecurityEncryptionSection"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-[var(--nim-success)]">
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
          ) : stuck ? (
            <div
              className="organization-encryption-diagnostic mt-3 rounded-md border border-[var(--nim-warning)] bg-[rgba(251,191,36,0.08)] p-3"
              data-testid="organization-encryption-stuck"
            >
              <p className="m-0 text-xs font-semibold text-[var(--nim-warning)]">Encryption update needs support</p>
              <p className="m-0 mt-1 select-text text-xs text-[var(--nim-text-muted)]">
                {stuck.message}
              </p>
            </div>
          ) : updating ? (
            <p className="m-0 mt-3 inline-flex items-center gap-1.5 text-xs text-[var(--nim-text-muted)]">
              <MaterialSymbol icon="progress_activity" size={14} className="animate-spin" />
              Updating encryption in the background
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
