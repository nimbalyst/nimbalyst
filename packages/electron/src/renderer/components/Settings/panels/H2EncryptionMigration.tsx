import React, { useCallback, useEffect, useState } from 'react';
import {
  useFloating,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
  FloatingOverlay,
  FloatingFocusManager,
} from '@floating-ui/react';
import { MaterialSymbol } from '@nimbalyst/runtime';

/**
 * Epic H2 — Security & encryption section + admin-gated migration flow.
 *
 * Replaces the old static "End-to-End Encryption" card. Shows the team's current
 * key-custody mode, and for a legacy-e2e team an admin can review the
 * policy-change copy, acknowledge it (required), and run the client-assisted
 * cutover to server-managed keys. Copy is verbatim from
 * `nimbalyst-local/plans/teams/h2-migration-ux-and-copy.md` (source of truth).
 *
 * Migration order (architecture-constrained): the server must already be in
 * server-managed mode for the re-uploaded plaintext to be DEK-encrypted at rest,
 * so `migrateToServerManaged` flips the mode (admin-gated REST; fails closed for
 * non-admins / network errors before any local change) and then re-uploads local
 * tracker data as plaintext. A failed REST call leaves the team on legacy-e2e.
 */

type KeyCustodyMode = 'legacy-e2e' | 'server-managed';
type MigrationState = 'idle' | 'migrating' | 'done' | 'error';

interface Props {
  orgId: string;
  workspacePath?: string;
  isAdmin: boolean;
}

const SECURITY_DOC_TESTID = 'h2-security-encryption-section';

export function SecurityEncryptionSection({ orgId, workspacePath, isAdmin }: Props) {
  const [mode, setMode] = useState<KeyCustodyMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const refreshMode = useCallback(async () => {
    try {
      const res = await (window as any).electronAPI?.team?.getKeyCustodyStatus?.(orgId);
      if (res?.success && res.mode) {
        setMode(res.mode as KeyCustodyMode);
      } else {
        // Unknown / error: assume legacy so we don't hide the migration path.
        setMode('legacy-e2e');
      }
    } catch {
      setMode('legacy-e2e');
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void refreshMode();
  }, [refreshMode]);

  const serverManaged = mode === 'server-managed';

  return (
    <div
      data-testid={SECURITY_DOC_TESTID}
      className="security-encryption-section p-3.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg"
    >
      <div className="flex items-center gap-2 mb-2">
        <MaterialSymbol icon="lock" size={16} className="text-[var(--nim-success)]" />
        <span className="text-[13px] font-semibold text-[var(--nim-text)]">
          Security &amp; encryption
        </span>
      </div>

      {/* Status chip */}
      <div className="mb-2.5">
        {loading ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--nim-text-faint)]">
            <MaterialSymbol icon="hourglass_empty" size={13} /> Checking encryption status…
          </span>
        ) : serverManaged ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] border border-[var(--nim-success)] text-[var(--nim-success)] bg-[rgba(88,192,138,0.08)]">
            <MaterialSymbol icon="verified_user" size={13} fill />
            Real-time team collaboration on · encrypted &amp; isolated per team
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] border border-[var(--nim-border)] text-[var(--nim-text-muted)] bg-[var(--nim-bg-tertiary)]">
            <MaterialSymbol icon="lock" size={13} />
            End-to-end encrypted · desktop &amp; mobile only
          </span>
        )}
      </div>

      {/* Legacy + admin: banner + Review changes. Legacy + member: read-only note. */}
      {!loading && !serverManaged && (
        isAdmin ? (
          <div className="flex items-center gap-3 p-3 rounded-lg bg-[rgba(251,191,36,0.08)] border border-[rgba(251,191,36,0.3)]">
            <MaterialSymbol icon="enhanced_encryption" size={20} className="text-[var(--nim-warning)] shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-[var(--nim-warning)]">Update team encryption</div>
              <p className="m-0 mt-0.5 text-[12px] text-[var(--nim-text-muted)] leading-snug">
                Enable real-time collaboration, web, CLI, and AI agents for your team.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="shrink-0 px-3 py-1.5 rounded-md text-[13px] font-semibold bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
            >
              Review changes
            </button>
          </div>
        ) : (
          <div className="p-3.5 rounded-lg border border-dashed border-[var(--nim-border)] text-[12px] text-[var(--nim-text-muted)] leading-relaxed">
            Your team admin needs to update encryption settings to enable web, CLI, and AI-agent
            access for this team. Your personal data stays end-to-end encrypted either way.
          </div>
        )
      )}

      {/* Server-managed: short confirmation note. */}
      {!loading && serverManaged && (
        <p className="m-0 text-[12px] text-[var(--nim-text-muted)] leading-relaxed">
          Team trackers and documents are encrypted at rest and in transit, isolated per team, with
          keys managed by Nimbalyst — reachable from the desktop app, web, CLI, and AI agents. Your
          personal sync (sessions, drafts, settings) stays end-to-end encrypted.
        </p>
      )}

      {modalOpen && (
        <MigrationModal
          orgId={orgId}
          workspacePath={workspacePath}
          isAdmin={isAdmin}
          onClose={() => setModalOpen(false)}
          onMigrated={() => { void refreshMode(); }}
        />
      )}
    </div>
  );
}

function MigrationModal({
  orgId, workspacePath, isAdmin, onClose, onMigrated,
}: {
  orgId: string;
  workspacePath?: string;
  isAdmin: boolean;
  onClose: () => void;
  onMigrated: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [state, setState] = useState<MigrationState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [itemsMarked, setItemsMarked] = useState<number | null>(null);

  // Dismissable only while idle/done/error — never mid-migration.
  const dismissable = state === 'idle' || state === 'done' || state === 'error';
  const { refs, context } = useFloating({
    open: true,
    onOpenChange: (open) => { if (!open && dismissable) onClose(); },
  });
  const dismiss = useDismiss(context, { outsidePress: dismissable, escapeKey: dismissable });
  const role = useRole(context, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const runMigration = useCallback(async () => {
    if (!workspacePath) {
      setError('No workspace is linked to this team; open the team’s project first.');
      setState('error');
      return;
    }
    setState('migrating');
    setError(null);
    try {
      const res = await (window as any).electronAPI?.trackerSync?.migrateToServerManaged?.(orgId, workspacePath);
      if (!res?.success) {
        throw new Error(res?.error || 'Migration failed');
      }
      setItemsMarked(typeof res.itemsMarked === 'number' ? res.itemsMarked : null);
      setState('done');
      onMigrated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }, [workspacePath, onMigrated]);

  return (
    <FloatingPortal>
      <FloatingOverlay
        lockScroll
        className="z-[1000] grid place-items-center bg-[rgba(0,0,0,0.55)] p-4"
      >
        <FloatingFocusManager context={context}>
          <div
            ref={refs.setFloating}
            {...getFloatingProps()}
            data-testid="h2-encryption-migration-modal"
            className="h2-encryption-migration-modal w-full max-w-[600px] max-h-[88vh] overflow-y-auto rounded-2xl bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-2xl"
            aria-labelledby="h2-migration-title"
          >
            {state === 'migrating' ? (
              <MigratingBody />
            ) : state === 'done' ? (
              <DoneBody itemsMarked={itemsMarked} onClose={onClose} />
            ) : (
              <IdleBody
                isAdmin={isAdmin}
                acknowledged={acknowledged}
                setAcknowledged={setAcknowledged}
                error={state === 'error' ? error : null}
                onCancel={onClose}
                onMigrate={runMigration}
              />
            )}
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  );
}

function IdleBody({
  isAdmin, acknowledged, setAcknowledged, error, onCancel, onMigrate,
}: {
  isAdmin: boolean;
  acknowledged: boolean;
  setAcknowledged: (v: boolean) => void;
  error: string | null;
  onCancel: () => void;
  onMigrate: () => void;
}) {
  const canMigrate = isAdmin && acknowledged;
  return (
    <>
      <div className="px-6 pt-5 pb-1.5">
        <h2 id="h2-migration-title" className="m-0 text-[17px] font-semibold text-[var(--nim-text)]">
          Update team encryption
        </h2>
      </div>

      <div className="px-6 py-2.5 flex flex-col gap-3.5">
        <p className="m-0 text-[13px] text-[var(--nim-text)] leading-relaxed">
          This turns on real-time team collaboration — including from the web, CLI, and AI agents — by
          letting Nimbalyst manage this team&apos;s shared encryption keys instead of only your devices.
          Your <b>personal</b> data (sessions, drafts, settings) stays end-to-end encrypted.
        </p>

        <label className="flex gap-2.5 items-start p-3 rounded-lg bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] cursor-pointer">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-[var(--nim-primary)] cursor-pointer"
          />
          <span className="text-[12.5px] leading-relaxed text-[var(--nim-text)]">
            Nimbalyst will manage this team&apos;s shared encryption keys to enable real-time
            collaboration — no longer zero-knowledge. My personal data stays end-to-end encrypted.
          </span>
        </label>

        {!isAdmin && (
          <p className="m-0 text-[12px] text-[var(--nim-warning)] leading-snug">
            Only a team owner or admin can migrate the team.
          </p>
        )}
        {error && (
          <p className="m-0 text-[12px] text-[var(--nim-error)] leading-snug">
            Migration could not complete: {error}. Your team is still end-to-end encrypted. You can retry.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-[var(--nim-border)] mt-2">
        <span className="text-[12px] text-[var(--nim-text-faint)]">
          One-time change for this team
        </span>
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-2 rounded-md text-[13px] font-semibold bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
          >
            Not now
          </button>
          <button
            type="button"
            data-testid="h2-migrate-button"
            disabled={!canMigrate}
            onClick={onMigrate}
            className={`h2-migrate-button px-3.5 py-2 rounded-md text-[13px] font-semibold border ${
              canMigrate
                ? 'bg-[var(--nim-primary)] text-white border-[var(--nim-primary)] hover:opacity-90 cursor-pointer'
                : 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)] border-[var(--nim-border)] cursor-not-allowed'
            }`}
          >
            Acknowledge &amp; migrate
          </button>
        </div>
      </div>
    </>
  );
}

function MigratingBody() {
  return (
    <div className="px-6 py-7">
      <div className="text-[14px] text-[var(--nim-text)] mb-3">
        Re-encrypting your team&apos;s trackers and documents…
      </div>
      <div className="h-2 rounded-full bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] overflow-hidden">
        <div className="h-full w-3/5 bg-[var(--nim-primary)] animate-pulse" />
      </div>
      <p className="m-0 mt-3 text-[12px] text-[var(--nim-text-faint)] leading-relaxed">
        Your existing team data is being re-encrypted under the new model. This can take a moment;
        keep Nimbalyst open until it finishes.
      </p>
    </div>
  );
}

function DoneBody({ itemsMarked, onClose }: { itemsMarked: number | null; onClose: () => void }) {
  return (
    <div className="px-6 py-7">
      <div className="flex items-center gap-2 mb-2">
        <MaterialSymbol icon="check_circle" size={20} className="text-[var(--nim-success)]" fill />
        <span className="text-[15px] font-semibold text-[var(--nim-text)]">Migration complete</span>
      </div>
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] border border-[var(--nim-success)] text-[var(--nim-success)] bg-[rgba(88,192,138,0.08)] mb-3">
        <MaterialSymbol icon="verified_user" size={13} fill />
        Real-time team collaboration on · encrypted &amp; isolated per team
      </span>
      <p className="m-0 mt-1 text-[13px] text-[var(--nim-text)] leading-relaxed">
        Your team can now collaborate in real time from the web, CLI, and AI agents.
        {typeof itemsMarked === 'number' && itemsMarked > 0
          ? ` ${itemsMarked} tracker item${itemsMarked === 1 ? '' : 's'} are being re-encrypted in the background.`
          : ''}{' '}
        Your personal sync stays end-to-end encrypted.
      </p>
      <div className="flex justify-end mt-5">
        <button
          type="button"
          onClick={onClose}
          className="px-3.5 py-2 rounded-md text-[13px] font-semibold bg-[var(--nim-primary)] text-white border border-[var(--nim-primary)] hover:opacity-90 cursor-pointer"
        >
          Done
        </button>
      </div>
    </div>
  );
}
