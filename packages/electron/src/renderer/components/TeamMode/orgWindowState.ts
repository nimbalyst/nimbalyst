import { atom } from 'jotai';

import { atomFamily } from '../../store/debug/atomFamilyRegistry';
import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';
import { isOrgWindowPendingHandoffRoute } from './onboarding/pendingRouteHandoff';
import type { InboxProvider } from './Inbox/inboxProvider';
import type { InboxRowView } from './Inbox/inboxTypes';
import type { OrgMessagingGating } from './orgSidebarViewModel';

/**
 * Where the organization window is pointed.
 *
 * The window used to hold a local `useState<AdminTab>`, which meant nothing
 * outside the component tree could steer it. Rooms, DMs, the rooms directory
 * and inbox deep links all need to, so selection lives in an atom and is
 * addressed as a route rather than a tab id.
 */
/**
 * `'admin'` is retained as a destination this window *recognizes*, not one it
 * renders: administration moved to the `ORG_MANAGEMENT` dialog (NIM-2322), and
 * an admin route left over from before that — a stale hand-off, a deep link —
 * is redirected to the messaging landing view rather than rendering nothing.
 */
export type OrgWindowView = 'inbox' | 'conversation' | 'directory' | 'admin';

/** The administration panels, which are the management dialog's tabs. */
export type AdminTab =
  | 'members'
  | 'projects'
  | 'settings'
  | 'billing'
  | 'danger';

export interface OrgWindowRoute {
  view: OrgWindowView;
  /** Set when `view` is `'conversation'`. */
  conversationId?: string;
  /** Set when `view` is `'admin'`. */
  adminTab?: AdminTab;
}

/**
 * The window opens on the Inbox: it is the section a user lives in, while the
 * rest of the window is rooms they pick and occasional administration.
 */
export const DEFAULT_ORG_WINDOW_ROUTE: OrgWindowRoute = { view: 'inbox' };

/** The two parameterless destinations, as stable values. */
export const INBOX_ROUTE: OrgWindowRoute = DEFAULT_ORG_WINDOW_ROUTE;
export const DIRECTORY_ROUTE: OrgWindowRoute = { view: 'directory' };

export const orgWindowRouteAtom = atom<OrgWindowRoute>(
  DEFAULT_ORG_WINDOW_ROUTE,
);

const CONVERSATION_ROUTES = new Map<string, OrgWindowRoute>();

/**
 * Cached per id, so a row that re-renders hands the same route object back and
 * a memoized consumer is not invalidated by the descriptor alone. Routes are
 * read-only value objects; nothing mutates one after it is built.
 */
export function conversationRoute(conversationId: string): OrgWindowRoute {
  const cached = CONVERSATION_ROUTES.get(conversationId);
  if (cached) return cached;
  const route: OrgWindowRoute = { view: 'conversation', conversationId };
  CONVERSATION_ROUTES.set(conversationId, route);
  return route;
}

/**
 * One destination as a comparable string.
 *
 * The sidebar's rows do not need the route — they need to know whether they are
 * the selected one. Deriving a primitive key first is what lets each row
 * subscribe to its own boolean below: a route change then re-renders the two
 * rows whose selection actually flipped instead of the whole window.
 */
export function orgWindowRouteKey(route: OrgWindowRoute): string {
  if (route.view === 'conversation') {
    return `conversation:${route.conversationId ?? ''}`;
  }
  if (route.view === 'admin') return `admin:${route.adminTab ?? ''}`;
  return route.view;
}

/** The active destination's key. A primitive, so equal routes notify nobody. */
export const orgWindowRouteKeyAtom = atom((get) =>
  orgWindowRouteKey(get(orgWindowRouteAtom)));

/**
 * Whether one destination is the active one. Each sidebar row subscribes to its
 * own instance, so navigating only re-renders the row being left and the row
 * being entered.
 */
export const orgWindowRouteSelectedAtomFamily = atomFamily(
  (routeKey: string) => atom((get) => get(orgWindowRouteKeyAtom) === routeKey),
);

export function isRouteSelected(
  route: OrgWindowRoute,
  candidate: OrgWindowRoute,
): boolean {
  if (route.view !== candidate.view) return false;
  if (candidate.view === 'conversation') {
    return route.conversationId === candidate.conversationId;
  }
  if (candidate.view === 'admin') return route.adminTab === candidate.adminTab;
  return true;
}

/**
 * Where the window points once its organization changes — which includes the
 * window's first mount.
 *
 * A conversation id belongs to exactly one organization, so a room selected in
 * the old one has to be dropped. The exception is the invite-accept / creation
 * wizard hand-off: it may land either before or after this runs, and when it
 * has already pointed the window at `#general` this must not undo it and send
 * the brand-new member to the Inbox instead.
 */
export function routeAfterOrgChange(
  orgId: string,
  route: OrgWindowRoute,
): OrgWindowRoute {
  if (isOrgWindowPendingHandoffRoute(orgId, route)) return route;
  return route.view === 'conversation' ? DEFAULT_ORG_WINDOW_ROUTE : route;
}

/**
 * Move the window off a destination its organization has turned off, or that
 * this window no longer has.
 *
 * Turning rooms or DMs off while someone is reading one has to land them
 * somewhere, and the Inbox is never gated. A conversation the directory has
 * not loaded yet is left alone — the window's own "loading / no longer
 * available" arm covers it, and bouncing would break deep links that arrive
 * before the listing does.
 *
 * Administration is not gated by role here any more; it is not in this window
 * at all (NIM-2322), so every admin route lands on the messaging default
 * regardless of the viewer's role or which panel was addressed.
 */
export function gateOrgWindowRoute(
  route: OrgWindowRoute,
  gating: OrgMessagingGating,
  conversations: readonly ConversationDirectoryEntry[] = [],
): OrgWindowRoute {
  if (route.view === 'admin') return DEFAULT_ORG_WINDOW_ROUTE;
  if (route.view === 'directory' && !gating.roomsVisible) {
    return DEFAULT_ORG_WINDOW_ROUTE;
  }
  if (route.view === 'conversation') {
    const entry = conversations.find((candidate) => candidate.id === route.conversationId);
    if (!entry) return route;
    if (entry.kind === 'orgRoom' && !gating.roomsVisible) {
      return DEFAULT_ORG_WINDOW_ROUTE;
    }
    if (entry.kind === 'dm' && !gating.dmsVisible) {
      return DEFAULT_ORG_WINDOW_ROUTE;
    }
  }
  return route;
}

/**
 * The in-window destination for an inbox delivery, or null when the delivery
 * belongs somewhere else (a tracker, a document, another organization) and the
 * existing deep-link IPC should keep handling it.
 */
export function routeForInboxRow(
  row: InboxRowView,
  orgId: string,
): OrgWindowRoute | null {
  if (row.orgId !== orgId) return null;
  if (row.availability !== 'available') return null;
  if (!row.sourceId) return null;
  if (row.sourceKind !== 'roomMessage' && row.sourceKind !== 'dmMessage') {
    return null;
  }
  return conversationRoute(row.sourceId);
}

/**
 * Wrap an inbox provider so activating a room or DM delivery opens that
 * conversation in this window instead of asking the main process to route a
 * deep link out to the project window.
 */
export function withOrgWindowRouting(
  provider: InboxProvider,
  orgId: string,
  openRoute: (route: OrgWindowRoute) => void,
): InboxProvider {
  return {
    ...provider,
    async navigate(row: InboxRowView) {
      const route = routeForInboxRow(row, orgId);
      if (!route) return provider.navigate(row);
      openRoute(route);
      return true;
    },
  };
}
