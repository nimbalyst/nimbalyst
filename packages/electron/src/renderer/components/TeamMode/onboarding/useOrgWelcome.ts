/**
 * First-open state for the invited-member welcome card.
 *
 * Dismissal is persisted in app-settings (never localStorage), and the org
 * details behind the card are only fetched when the card is actually going to
 * render — a member who dismissed it once pays a single settings read per open.
 */

import { useCallback, useEffect, useState } from 'react';

import { markOrgWelcomeDismissed, readOrgWelcomeDismissed } from './orgOnboardingStorage';
import {
  buildOrgWelcomeCard,
  shouldShowOrgWelcome,
  type OrgWelcomeCardView,
} from './orgWelcomeModel';

interface OrgSummary {
  orgId: string;
  name: string;
}

export interface UseOrgWelcomeResult {
  visible: boolean;
  card: OrgWelcomeCardView | null;
  dismiss: () => void;
}

async function loadOrgDetails(orgId: string): Promise<{ name: string; memberCount: number }> {
  const [directory, roster] = await Promise.all([
    window.electronAPI?.organization?.list?.(),
    window.electronAPI?.organization?.listMembers?.(orgId),
  ]);
  const organizations: OrgSummary[] = directory?.success && Array.isArray(directory.teams)
    ? directory.teams
    : [];
  const members = roster?.success && Array.isArray(roster.members) ? roster.members : [];
  return {
    name: organizations.find((organization) => organization.orgId === orgId)?.name ?? '',
    memberCount: members.length,
  };
}

export function useOrgWelcome(orgId: string | null | undefined): UseOrgWelcomeResult {
  const [card, setCard] = useState<OrgWelcomeCardView | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (!orgId) {
      setCard(null);
      setDismissed(true);
      return;
    }
    let cancelled = false;
    void readOrgWelcomeDismissed(orgId)
      .then(async (alreadyDismissed) => {
        if (cancelled) return;
        if (alreadyDismissed) {
          setDismissed(true);
          setCard(null);
          return;
        }
        const details = await loadOrgDetails(orgId);
        if (cancelled) return;
        const input = {
          orgName: details.name,
          memberCount: details.memberCount,
          // The invite record does not travel with the roster, so the card
          // stays truthful and simply omits the inviter until it does.
          inviterName: null,
          dismissed: false,
          ready: true,
        };
        setDismissed(!shouldShowOrgWelcome(input));
        setCard(buildOrgWelcomeCard(input));
      })
      .catch(() => {
        if (!cancelled) setDismissed(true);
      });
    return () => { cancelled = true; };
  }, [orgId]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (orgId) void markOrgWelcomeDismissed(orgId);
  }, [orgId]);

  return { visible: !dismissed && card !== null, card, dismiss };
}
