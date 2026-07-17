import React, { useEffect, useState } from 'react';
import { useSetAtom } from 'jotai';

import { DialogProvider } from '../../contexts/DialogContext';
import { selectedOrgIdAtom } from '../../store/atoms/orgScope';
import { TeamMode } from './TeamMode';

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

function readTarget(): { orgId: string | null; workspacePath: string | null } {
  const params = new URLSearchParams(window.location.search);
  return {
    orgId: params.get('orgId') || null,
    workspacePath: params.get('workspacePath') || null,
  };
}

export function TeamManagementApp() {
  const setSelectedOrgId = useSetAtom(selectedOrgIdAtom);
  const [target, setTarget] = useState(readTarget);

  // Seed the selected-org atom from the current target so TeamMode targets the
  // right org, and retarget when the reusable window is pointed elsewhere.
  useEffect(() => {
    setSelectedOrgId(target.orgId);
  }, [target.orgId, setSelectedOrgId]);

  useEffect(() => {
    window.electronAPI?.setTitle?.('Organization - Nimbalyst');
  }, []);

  useEffect(() => {
    const off = window.electronAPI?.on?.(
      'team-window:set-target',
      (next: { orgId?: string | null; workspacePath?: string | null }) => {
        setTarget({
          orgId: next?.orgId ?? null,
          workspacePath: next?.workspacePath ?? null,
        });
      },
    );
    return () => { off?.(); };
  }, []);

  return (
    <DialogProvider workspacePath={target.workspacePath ?? undefined}>
      <div className="team-management-window flex h-screen flex-col overflow-hidden bg-[var(--nim-bg)] text-[var(--nim-text)]" data-component="TeamManagementApp">
        <TeamMode workspacePath={target.workspacePath ?? undefined} isActive />
      </div>
    </DialogProvider>
  );
}
