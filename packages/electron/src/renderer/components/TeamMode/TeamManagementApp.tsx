import { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';

import { DialogProvider } from '../../contexts/DialogContext';
import { selectedOrgIdAtom } from '../../store/atoms/orgScope';
import { organizationDirectoryStateAtom } from '../../store/atoms/settingsDomains';
import { OrgModeHost } from './OrgModeHost';
import { useOrgWindowCommandSource } from './useOrgWindowCommandSource';
import { useOrgWindowPendingRoute } from './onboarding/useOrgWindowPendingRoute';
import { readOrgWindowPendingRoute } from './onboarding/orgOnboardingStorage';
import { parsePendingRoute } from './onboarding/orgWelcomeModel';
import {
  conversationRoute,
  inboxRoute,
  ORG_WINDOW_SURFACE_ID,
  orgWindowRouteAtomFamily,
} from './orgWindowState';
import { requestInboxRowSelection } from './orgWindowCommandBus';
import {
  persistLastSelectedOrgId,
  readLastSelectedOrgId,
  resolveOrgWindowTargetId,
} from './defaultOrg';
import './TeamManagementWindow.css';

const IS_MAC = typeof navigator !== 'undefined'
  && navigator.platform.startsWith('Mac');

/**
 * Root of the organization messages ("Team") OS window.
 *
 * Rendered when the SPA boots with `?mode=team-management` (see App.tsx). The
 * window is the organization's Inbox, rooms and DMs; administration is the
 * `ORG_MANAGEMENT` dialog, which opens in whichever window the user is already
 * in — this one included, through its own `DialogProvider` below (NIM-2322,
 * superseding the 2026-07-17 "administration is its own window" correction).
 * This window wrapper reads the initial target from the URL, keeps it in sync
 * when the single reusable window is retargeted, and passes explicit identity
 * into the shared OrgModeHost component tree.
 *
 * Auth/org atoms are hydrated by App's top-level effects (initStytchAuthListeners
 * etc.), which run for every window mode before the early return; OrgModeHost
 * and its panels otherwise read live state over IPC.
 */

interface WindowTarget {
  orgId: string | null;
  workspacePath: string | null;
  conversationId: string | null;
  /** Set by a `nimbalyst://feedback-request/...` link; selects an Inbox row. */
  feedbackRequestId: string | null;
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
    feedbackRequestId: params.get('feedbackRequestId') || null,
    retargetNonce: 0,
  };
}

export function TeamManagementApp() {
  const setSelectedOrgId = useSetAtom(selectedOrgIdAtom);
  const setOrgWindowRoute = useSetAtom(
    orgWindowRouteAtomFamily(ORG_WINDOW_SURFACE_ID),
  );
  const selectedOrgId = useAtomValue(selectedOrgIdAtom);
  const directory = useAtomValue(organizationDirectoryStateAtom);
  const [target, setTarget] = useState(readTarget);
  // Mounted at the window root, not inside OrgModeHost: the Messages shortcuts
  // have to work on every surface this window shows, the loading and
  // no-organization arms included.
  useOrgWindowCommandSource(ORG_WINDOW_SURFACE_ID);
  // Untargeted opens resolve a default org before OrgModeHost mounts, so the
  // window doesn't flash the "create an organization" surface on the way.
  const [targetResolved, setTargetResolved] = useState(false);

  // Seed the window-owned selected-org atom from the current target so the host targets the
  // right org, and retarget when the reusable window is pointed elsewhere.
  // Opened without an orgId (Window > Organization Messages), an explicit
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

    // Keep the host mounted while the shared directory refreshes; its loading
    // state must not reset conversations or replace a pending destination.
    void Promise.all([
      readLastSelectedOrgId(),
      readOrgWindowPendingRoute(),
    ])
      .then(([lastSelectedOrgId, storedPendingRoute]) => {
        if (cancelled) return;
        const pendingRoute = parsePendingRoute(storedPendingRoute);
        // The pending hand-off is an explicit destination, kept even while
        // team:list is empty or partial — silently choosing the first visible
        // org would route an invited member into the wrong tenant — but only
        // while the directory does not positively say it is unopenable.
        const resolvedOrgId = resolveOrgWindowTargetId(
          pendingRoute?.orgId,
          lastSelectedOrgId,
          directory.entries,
          directory.complete,
        );
        setSelectedOrgId(resolvedOrgId);
        if (resolvedOrgId && resolvedOrgId === pendingRoute?.orgId) {
          void persistLastSelectedOrgId(resolvedOrgId);
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
    directory,
    target.orgId,
    target.retargetNonce,
    setSelectedOrgId,
  ]);

  useEffect(() => {
    window.electronAPI?.setTitle?.('Organization Messages - Nimbalyst');
  }, []);

  // Accepting an invite or finishing the creation wizard queues "#general" for
  // this window rather than dead-ending the user in a settings list.
  useOrgWindowPendingRoute(
    targetResolved ? selectedOrgId : null,
    target.retargetNonce,
    ORG_WINDOW_SURFACE_ID,
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

  // A feedback-request link points the window at the Inbox and asks it to
  // select the row for that request — the respond card renders in the Inbox's
  // context pane. It deliberately does not open the `virtual://feedback-request/`
  // tab, which is the author's results view.
  useEffect(() => {
    if (
      !targetResolved
      || !target.orgId
      || selectedOrgId !== target.orgId
      || !target.feedbackRequestId
    ) {
      return;
    }
    // "Awaiting my reply" is the row a feedback request belongs to; the Inbox's
    // own selection latch clears the filters if the request is not in it.
    setOrgWindowRoute(inboxRoute('awaiting'));
    requestInboxRowSelection(ORG_WINDOW_SURFACE_ID, {
      orgId: target.orgId,
      sourceKind: 'feedbackRequest',
      sourceId: target.feedbackRequestId,
    });
  }, [
    selectedOrgId,
    setOrgWindowRoute,
    target.feedbackRequestId,
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
        feedbackRequestId?: string | null;
      }) => {
        setTarget((previous) => ({
          orgId: next?.orgId ?? null,
          workspacePath: next?.workspacePath ?? null,
          conversationId: next?.conversationId ?? null,
          feedbackRequestId: next?.feedbackRequestId ?? null,
          retargetNonce: previous.retargetNonce + 1,
        }));
      },
    );
    return () => { off?.(); };
  }, []);

  return (
    <DialogProvider workspacePath={target.workspacePath ?? undefined}>
      <div
        className={`team-management-window org-window-chrome ${
          IS_MAC ? 'team-management-window-mac' : ''
        } flex h-screen flex-col overflow-hidden bg-[var(--nim-bg)] text-[var(--nim-text)]`}
        data-component="TeamManagementApp"
        data-platform={IS_MAC ? 'mac' : 'other'}
      >
        {targetResolved
          ? (
            <OrgModeHost
              orgId={selectedOrgId}
              workspacePath={target.workspacePath ?? undefined}
              surfaceId={ORG_WINDOW_SURFACE_ID}
              chrome="window"
              isActive
              onOrgIdChange={setSelectedOrgId}
            />
          )
          : (
            <div className="team-management-resolving flex flex-1 items-center justify-center text-sm text-[var(--nim-text-muted)]">
              Loading organization…
            </div>
          )}
      </div>
    </DialogProvider>
  );
}
