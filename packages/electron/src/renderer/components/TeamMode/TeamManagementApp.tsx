import React, { useEffect, useState } from 'react';
import { useSetAtom } from 'jotai';

import { DialogProvider } from '../../contexts/DialogContext';
import { selectedOrgIdAtom } from '../../store/atoms/orgScope';
import { TeamMode } from './TeamMode';
import {
  persistLastSelectedOrgId,
  readLastSelectedOrgId,
  resolveDefaultOrgId,
  type OrgChoice,
} from './defaultOrg';

/**
 * Root of the dedicated org-management ("Team") OS window.
 *
 * Rendered when the SPA boots with `?mode=team-management` (see App.tsx).
 * Org administration is its own window, not a mode inside the project window
 * (2026-07-17 decision-log correction). This host reads the initial target from
 * the URL, keeps it in sync when the single reusable window is retargeted at a
 * different org, and rehosts the existing TeamMode component tree unchanged.
 *
 * Auth/org atoms are hydrated by App's top-level effects (initStytchAuthListeners
 * etc.), which run for every window mode before the early return; TeamMode and
 * its panels otherwise read live state over IPC.
 */

interface WindowTarget {
  orgId: string | null;
  workspacePath: string | null;
  /**
   * Bumped on every `team-window:set-target`. Retargeting at the org already in
   * the URL must still re-seed the atom — the user may have switched the window
   * elsewhere in the meantime, and an untargeted re-open must re-resolve the
   * default — so the seeding effect keys on this, not just on `orgId`.
   */
  retargetNonce: number;
}

function readTarget(): WindowTarget {
  const params = new URLSearchParams(window.location.search);
  return {
    orgId: params.get('orgId') || null,
    workspacePath: params.get('workspacePath') || null,
    retargetNonce: 0,
  };
}

export function TeamManagementApp() {
  const setSelectedOrgId = useSetAtom(selectedOrgIdAtom);
  const [target, setTarget] = useState(readTarget);
  // Untargeted opens resolve a default org before TeamMode mounts, so the
  // window doesn't flash the "create an organization" surface on the way.
  const [targetResolved, setTargetResolved] = useState(false);

  // Seed the selected-org atom from the current target so TeamMode targets the
  // right org, and retarget when the reusable window is pointed elsewhere.
  // Opened without an orgId (Window > Organization Manager, "New organization"),
  // fall back to the last selected org, then to the first active membership.
  useEffect(() => {
    let cancelled = false;
    if (target.orgId) {
      setSelectedOrgId(target.orgId);
      setTargetResolved(true);
      void persistLastSelectedOrgId(target.orgId);
      return () => { cancelled = true; };
    }

    setTargetResolved(false);
    void Promise.all([readLastSelectedOrgId(), window.electronAPI?.organization?.list?.()])
      .then(([lastSelectedOrgId, directory]) => {
        if (cancelled) return;
        const organizations: OrgChoice[] = directory?.success && Array.isArray(directory.teams)
          ? directory.teams
          : [];
        setSelectedOrgId(resolveDefaultOrgId(lastSelectedOrgId, organizations));
      })
      .catch(() => {
        if (!cancelled) setSelectedOrgId(null);
      })
      .finally(() => {
        if (!cancelled) setTargetResolved(true);
      });
    return () => { cancelled = true; };
  }, [target.orgId, target.retargetNonce, setSelectedOrgId]);

  useEffect(() => {
    window.electronAPI?.setTitle?.('Organization - Nimbalyst');
  }, []);

  useEffect(() => {
    const off = window.electronAPI?.on?.(
      'team-window:set-target',
      (next: { orgId?: string | null; workspacePath?: string | null }) => {
        setTarget((previous) => ({
          orgId: next?.orgId ?? null,
          workspacePath: next?.workspacePath ?? null,
          retargetNonce: previous.retargetNonce + 1,
        }));
      },
    );
    return () => { off?.(); };
  }, []);

  return (
    <DialogProvider workspacePath={target.workspacePath ?? undefined}>
      <div className="team-management-window flex h-screen flex-col overflow-hidden bg-[var(--nim-bg)] text-[var(--nim-text)]" data-component="TeamManagementApp">
        {/* Draggable title-bar strip: the window uses titleBarStyle 'hiddenInset'
            (no native bar), so without this the window can't be moved and the
            macOS traffic lights have no clearance. */}
        <div className="team-management-titlebar h-8 flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
        {targetResolved
          ? <TeamMode workspacePath={target.workspacePath ?? undefined} isActive />
          : (
            <div className="team-management-resolving flex flex-1 items-center justify-center text-sm text-[var(--nim-text-muted)]">
              Loading organization…
            </div>
          )}
      </div>
    </DialogProvider>
  );
}
