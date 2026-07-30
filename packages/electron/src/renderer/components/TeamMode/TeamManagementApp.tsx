import React, { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';

import { DialogProvider } from '../../contexts/DialogContext';
import { selectedOrgIdAtom } from '../../store/atoms/orgScope';
import { organizationDirectoryAtom } from '../../store/atoms/settingsDomains';
import { store } from '../../store';
import { TeamMode } from './TeamMode';
import { useOrgWindowCommandSource } from './useOrgWindowCommandSource';
import { useOrgWindowPendingRoute } from './onboarding/useOrgWindowPendingRoute';
import { readOrgWindowPendingRoute } from './onboarding/orgOnboardingStorage';
import { parsePendingRoute } from './onboarding/orgWelcomeModel';
import {
  createAtomInboxProvider,
  InboxProviderContext,
} from './Inbox/inboxProvider';
import {
  conversationRoute,
  orgWindowRouteAtom,
} from './orgWindowState';
import {
  persistLastSelectedOrgId,
  readLastSelectedOrgId,
  resolveDefaultOrgId,
  type OrgChoice,
} from './defaultOrg';
import './TeamManagementWindow.css';

const IS_MAC = typeof navigator !== 'undefined'
  && navigator.platform.startsWith('Mac');

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
  conversationId: string | null;
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
    conversationId: params.get('conversationId') || null,
    retargetNonce: 0,
  };
}

export function TeamManagementApp() {
  const inboxProvider = React.useMemo(
    () => createAtomInboxProvider(store),
    [],
  );
  const setSelectedOrgId = useSetAtom(selectedOrgIdAtom);
  const setOrgWindowRoute = useSetAtom(orgWindowRouteAtom);
  const selectedOrgId = useAtomValue(selectedOrgIdAtom);
  const hydratedOrganizations = useAtomValue(organizationDirectoryAtom);
  const [target, setTarget] = useState(readTarget);
  // Mounted at the window root, not inside TeamMode: the Messages shortcuts
  // have to work on every surface this window shows, the loading and
  // no-organization arms included.
  useOrgWindowCommandSource();
  // Untargeted opens resolve a default org before TeamMode mounts, so the
  // window doesn't flash the "create an organization" surface on the way.
  const [targetResolved, setTargetResolved] = useState(false);

  // Seed the selected-org atom from the current target so TeamMode targets the
  // right org, and retarget when the reusable window is pointed elsewhere.
  // Opened without an orgId (Window > Organization Manager), an explicit
  // pending onboarding destination wins; otherwise use the last selected org,
  // then the first active membership.
  useEffect(() => {
    let cancelled = false;
    if (target.orgId) {
      setSelectedOrgId(target.orgId);
      setTargetResolved(true);
      void persistLastSelectedOrgId(target.orgId);
      return () => { cancelled = true; };
    }

    setTargetResolved(false);
    void Promise.all([
      readLastSelectedOrgId(),
      readOrgWindowPendingRoute(),
      window.electronAPI?.organization?.list?.().catch(() => null),
    ])
      .then(([lastSelectedOrgId, storedPendingRoute, directory]) => {
        if (cancelled) return;
        const pendingRoute = parsePendingRoute(storedPendingRoute);
        const organizations: OrgChoice[] = directory?.success && Array.isArray(directory.teams)
          ? directory.teams
          : hydratedOrganizations;
        // The pending hand-off is an explicit destination. Keep targeting it
        // even while team:list is empty or partial; silently choosing the first
        // visible org would route an invited member into the wrong tenant.
        const resolvedOrgId = pendingRoute?.orgId
          ?? resolveDefaultOrgId(lastSelectedOrgId, organizations);
        setSelectedOrgId(resolvedOrgId);
        if (pendingRoute?.orgId) {
          void persistLastSelectedOrgId(pendingRoute.orgId);
        }
      })
      .catch(() => {
        if (!cancelled) setSelectedOrgId(null);
      })
      .finally(() => {
        if (!cancelled) setTargetResolved(true);
      });
    return () => { cancelled = true; };
  }, [
    hydratedOrganizations,
    target.orgId,
    target.retargetNonce,
    setSelectedOrgId,
  ]);

  useEffect(() => {
    window.electronAPI?.setTitle?.('Organization - Nimbalyst');
  }, []);

  // Accepting an invite or finishing the creation wizard queues "#general" for
  // this window rather than dead-ending the user in a settings list.
  useOrgWindowPendingRoute(
    targetResolved ? selectedOrgId : null,
    target.retargetNonce,
  );

  useEffect(() => {
    if (
      !targetResolved
      || !target.orgId
      || selectedOrgId !== target.orgId
      || !target.conversationId
    ) {
      return;
    }
    setOrgWindowRoute(conversationRoute(target.conversationId));
  }, [
    selectedOrgId,
    setOrgWindowRoute,
    target.conversationId,
    target.orgId,
    target.retargetNonce,
    targetResolved,
  ]);

  useEffect(() => {
    const off = window.electronAPI?.on?.(
      'team-window:set-target',
      (next: {
        orgId?: string | null;
        workspacePath?: string | null;
        conversationId?: string | null;
      }) => {
        setTarget((previous) => ({
          orgId: next?.orgId ?? null,
          workspacePath: next?.workspacePath ?? null,
          conversationId: next?.conversationId ?? null,
          retargetNonce: previous.retargetNonce + 1,
        }));
      },
    );
    return () => { off?.(); };
  }, []);

  return (
    <InboxProviderContext.Provider value={inboxProvider}>
      <DialogProvider workspacePath={target.workspacePath ?? undefined}>
        <div
          className={`team-management-window ${
            IS_MAC ? 'team-management-window-mac' : ''
          } flex h-screen flex-col overflow-hidden bg-[var(--nim-bg)] text-[var(--nim-text)]`}
          data-component="TeamManagementApp"
          data-platform={IS_MAC ? 'mac' : 'other'}
        >
          {targetResolved
            ? <TeamMode workspacePath={target.workspacePath ?? undefined} isActive />
            : (
              <div className="team-management-resolving flex flex-1 items-center justify-center text-sm text-[var(--nim-text-muted)]">
                Loading organization…
              </div>
            )}
        </div>
      </DialogProvider>
    </InboxProviderContext.Provider>
  );
}
