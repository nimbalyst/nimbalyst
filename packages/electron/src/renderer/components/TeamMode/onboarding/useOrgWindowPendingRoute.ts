/**
 * Consumes the "land on #general" hand-off left behind by the creation wizard
 * and the invite-accept buttons.
 *
 * Those buttons live in Account settings and the Members panel — often in a
 * different window than the org window they are opening — so the destination
 * travels through app-settings rather than through a prop. It remains there
 * until the destination room has actually hydrated, so a close, restart, or
 * transient directory failure can safely replay it.
 */

import { useEffect } from 'react';
import { useSetAtom } from 'jotai';

import { orgWindowRouteAtom } from '../orgWindowState';
import {
  acknowledgeOrgWindowPendingRoute,
  readOrgWindowPendingRoute,
} from './orgOnboardingStorage';
import { routeForPending } from './orgWelcomeModel';
import {
  clearOrgWindowPendingHandoff,
  recordOrgWindowPendingHandoff,
} from './pendingRouteHandoff';

export function useOrgWindowPendingRoute(
  orgId: string | null | undefined,
  /** Bumped when the window is retargeted, so the hand-off is re-checked. */
  nonce: number = 0,
): void {
  const setRoute = useSetAtom(orgWindowRouteAtom);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void readOrgWindowPendingRoute()
      .then(async (stored) => {
        if (cancelled) return;
        const route = routeForPending(stored, orgId);
        if (!route) return;
        // Recorded before the atom write so the org window's own mount reset,
        // which may run in either order against this, can recognize the
        // hand-off instead of bouncing the new member to the Inbox.
        recordOrgWindowPendingHandoff(orgId, route);
        setRoute(route);
      })
      .catch(() => {
        // A hand-off that cannot be read just leaves the window on its default.
      });
    return () => { cancelled = true; };
  }, [nonce, orgId, setRoute]);
}

/**
 * A hand-off is consumed only after the target room exists in the hydrated
 * directory. Until then it remains durable across a close, restart, retarget,
 * or transient directory failure.
 */
export function useAcknowledgeOrgWindowPendingRoute(
  orgId: string,
  conversationId: string | undefined,
  destinationReady: boolean,
): void {
  useEffect(() => {
    if (!conversationId || !destinationReady) return;
    const route = { view: 'conversation' as const, conversationId };
    let cancelled = false;
    void acknowledgeOrgWindowPendingRoute(orgId, conversationId)
      .then((cleared) => {
        if (!cancelled && cleared) {
          clearOrgWindowPendingHandoff(orgId, route);
        }
      });
    return () => { cancelled = true; };
  }, [conversationId, destinationReady, orgId]);
}
