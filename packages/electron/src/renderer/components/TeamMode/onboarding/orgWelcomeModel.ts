/**
 * Pure model behind the invited-member welcome card and the "open the org
 * window on #general" hand-off.
 *
 * Both pieces are storage-backed (app-settings, never localStorage — see
 * DATABASE.md), so the decisions they make are kept here as plain functions and
 * the IPC lives in `orgOnboardingStorage.ts`.
 */

import { conversationRoute, type OrgWindowRoute } from '../orgWindowState';
import { GENERAL_ROOM_ID } from './orgWizardModel';

/** app-settings key holding the orgs whose welcome card has been dismissed. */
export const ORG_WELCOME_DISMISSED_SETTING_KEY = 'orgWelcomeDismissedOrgIds';

/**
 * app-settings key holding where a freshly opened org window should land. Set
 * by the invite-accept path and by the creation wizard, which both run in a
 * different window than the one that has to do the navigating.
 */
export const ORG_WINDOW_PENDING_ROUTE_SETTING_KEY = 'orgWindowPendingRoute';

export interface OrgWindowPendingRoute {
  orgId: string;
  conversationId: string;
}

export function generalRoomRoute(): OrgWindowRoute {
  return conversationRoute(GENERAL_ROOM_ID);
}

/**
 * The welcome card is mounted inside the room it talks about, so every room
 * view asks this rather than each of them knowing the id.
 */
export function isGeneralRoomId(conversationId: string | null | undefined): boolean {
  return conversationId === GENERAL_ROOM_ID;
}

export function pendingGeneralRoute(orgId: string): OrgWindowPendingRoute {
  return { orgId, conversationId: GENERAL_ROOM_ID };
}

/** Tolerant of anything the store hands back — the key is user-writable state. */
export function parsePendingRoute(stored: unknown): OrgWindowPendingRoute | null {
  if (!stored || typeof stored !== 'object') return null;
  const candidate = stored as Partial<OrgWindowPendingRoute>;
  if (typeof candidate.orgId !== 'string' || !candidate.orgId) return null;
  if (typeof candidate.conversationId !== 'string' || !candidate.conversationId) {
    return null;
  }
  return { orgId: candidate.orgId, conversationId: candidate.conversationId };
}

/**
 * The route a window showing `orgId` should take, or null when the queued
 * hand-off was meant for a different organization (the single reusable window
 * may have been retargeted since).
 */
export function routeForPending(
  stored: unknown,
  orgId: string | null | undefined,
): OrgWindowRoute | null {
  const pending = parsePendingRoute(stored);
  if (!pending || !orgId || pending.orgId !== orgId) return null;
  return conversationRoute(pending.conversationId);
}

export function parseDismissedOrgIds(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter((entry): entry is string => typeof entry === 'string' && !!entry);
}

export function withDismissedOrgId(stored: unknown, orgId: string): string[] {
  const current = parseDismissedOrgIds(stored);
  return current.includes(orgId) ? current : [...current, orgId];
}

export interface OrgWelcomeCardInput {
  orgName: string;
  memberCount: number;
  /** The member who sent the invite, when the roster can identify one. */
  inviterName?: string | null;
  dismissed: boolean;
  /** False until the roster has resolved; the card must not flash empty. */
  ready: boolean;
}

export interface OrgWelcomeCardView {
  title: string;
  subtitle: string;
  points: string[];
}

export function shouldShowOrgWelcome(input: OrgWelcomeCardInput): boolean {
  return input.ready && !input.dismissed;
}

export function buildOrgWelcomeCard(
  input: OrgWelcomeCardInput,
): OrgWelcomeCardView {
  const name = input.orgName.trim() || 'your organization';
  const members = input.memberCount === 1
    ? '1 member'
    : `${input.memberCount} members`;
  return {
    title: `Welcome to ${name}`,
    subtitle: input.inviterName
      ? `${input.inviterName} invited you. ${members} so far.`
      : `${members} so far.`,
    points: [
      'Inbox collects mentions, replies and activity addressed to you.',
      'Rooms and direct messages are in the sidebar — #general has everyone in it.',
      'Administration lives under Admin at the bottom of the sidebar.',
    ],
  };
}
