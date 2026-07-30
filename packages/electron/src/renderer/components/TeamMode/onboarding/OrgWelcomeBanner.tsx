/**
 * Host for the invited-member welcome card: decides whether it shows.
 *
 * Mounted inside the `#general` room view, under the room header (2026-07-28
 * layout decision) — not in the window shell — so the card sits in the room it
 * is telling the new member about and spans the room content, not the window.
 * That is also why it carries no "Open #general" action any more.
 */

import React from 'react';

import { OrgWelcomeCard } from './OrgWelcomeCard';
import { useOrgWelcome } from './useOrgWelcome';

export function OrgWelcomeBanner({ orgId }: { orgId: string | null | undefined }) {
  const { visible, card, dismiss } = useOrgWelcome(orgId);

  if (!visible || !card) return null;

  return <OrgWelcomeCard card={card} onDismiss={dismiss} />;
}
