/**
 * A Pages section's Search as a desktop tab (`virtual://pages-search/<lane>`):
 * the section's pages from its docs session, typed pages from the tracker
 * atoms through the desktop tracker data source, authors from the team
 * directory, and page text from the session's search index. Rows open as
 * Pages tabs through the section's host.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useAtomValue, useStore } from 'jotai';
import type { CollabHost, CollabScope, TeamMemberSummary } from '@nimbalyst/collab-client/core';
import type { CollabDocsSession, SharedDocument } from '@nimbalyst/collab-client/docs';
import { DESKTOP_TRACKER_UI_CAPABILITIES, TrackersUIProvider } from '@nimbalyst/collab-client/trackers-ui';
import { EMPTY_PAGES_SEARCH, PagesSearchView, pagesSearchQuery } from '@nimbalyst/collab-client/trackers-ui/page';
import { ElectronTrackerDataSource } from '../../services/ElectronTrackerDataSource';
import {
  getElectronCollabDocsSession,
  getElectronCollabHost,
  getPersonalCollabHost,
  resolveDesktopCollabScope,
} from '../../store/atoms/collabDocuments';
import { createDesktopTrackerDataSource } from '../EmbedFrame/desktopTrackerDataSource';
import { useDesktopTrackerIdentity } from '../EmbedFrame/useDesktopTrackerIdentity';
import { useTrackerTeamMembers } from '../TrackerMode/useTrackerTeamMembers';
import type { PagesSectionLane } from './pagesSectionTabs';

export interface PagesSectionData {
  scope: CollabScope;
  session: CollabDocsSession;
  host: CollabHost;
  /** The tracker data source and identity a `TrackersUIProvider` over this section takes. */
  provider: Omit<React.ComponentProps<typeof TrackersUIProvider>, 'children'>;
  me: string | null;
}

/** The workspace's team scope: undefined while it resolves, null without a team. */
function useTeamScope(lane: PagesSectionLane, workspacePath: string): CollabScope | null | undefined {
  const [teamScope, setTeamScope] = useState<CollabScope | null | undefined>(undefined);
  useEffect(() => {
    if (lane !== 'team') return undefined;
    let cancelled = false;
    void resolveDesktopCollabScope(workspacePath).then(({ scope }) => {
      if (!cancelled) setTeamScope(scope);
    });
    return () => {
      cancelled = true;
    };
  }, [lane, workspacePath]);
  return teamScope;
}

/** The section's scope, docs session, host and tracker data: undefined while Team resolves, null without a team. */
export function usePagesSectionData(lane: PagesSectionLane, workspacePath: string): PagesSectionData | null | undefined {
  const store = useStore();
  const teamScope = useTeamScope(lane, workspacePath);
  const identity = useDesktopTrackerIdentity(workspacePath);
  const teamMembers = useTrackerTeamMembers(workspacePath);
  const writer = useMemo(() => new ElectronTrackerDataSource({ workspacePath }), [workspacePath]);
  useEffect(() => () => writer.dispose(), [writer]);
  const dataSource = useMemo(() => createDesktopTrackerDataSource({ workspacePath, store, writer }), [workspacePath, store, writer]);
  return useMemo(() => {
    const scope = lane === 'team' ? teamScope : getPersonalCollabHost(workspacePath).scope;
    if (!scope) return scope;
    return {
      scope,
      session: getElectronCollabDocsSession(scope),
      host: lane === 'team' ? getElectronCollabHost(scope) : getPersonalCollabHost(workspacePath),
      // `TrackerIdentity.email` is nullable; the provider's "me" needs one to stamp edits.
      provider: { dataSource, identity: identity?.email ? identity : null, capabilities: DESKTOP_TRACKER_UI_CAPABILITIES, teamMembers },
      me: (lane === 'team' ? scope.indexConfig.userEmail : null) ?? identity?.email ?? null,
    };
  }, [lane, teamScope, workspacePath, dataSource, identity, teamMembers]);
}

/** The team directory, fetched and kept current (it arrives after the team room syncs). */
function useMembers(host: CollabHost, orgId: string | null): TeamMemberSummary[] {
  const [members, setMembers] = useState<TeamMemberSummary[]>([]);
  useEffect(() => {
    if (!orgId) return undefined;
    let cancelled = false;
    const load = () => {
      host.getMembers(orgId)
        .then((result) => { if (!cancelled) setMembers(result); })
        .catch((error: unknown) => console.warn('[PagesSearchTab] Failed to load the team member directory:', error));
    };
    load();
    const unsubscribe = host.onMembersChanged?.(load);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [host, orgId]);
  return members;
}

export interface PagesSectionTabProps {
  lane: PagesSectionLane;
  workspacePath: string;
}

/** What a Team tab shows while its scope resolves (nothing) or when there is no team. */
export function PagesSectionUnavailable({ section }: { section: null | undefined }) {
  if (section === undefined) return null;
  return <div className="pages-section-unavailable flex h-full items-center justify-center text-sm text-nim-faint">Sign in and share this project to see team pages</div>;
}

export const PagesSearchTab: React.FC<PagesSectionTabProps> = ({ lane, workspacePath }) => {
  const section = usePagesSectionData(lane, workspacePath);
  if (!section) return <PagesSectionUnavailable section={section} />;
  return <PagesSearchTabBody lane={lane} section={section} />;
};

function PagesSearchTabBody({ lane, section }: { lane: PagesSectionLane; section: PagesSectionData }) {
  const { scope, session, host, me } = section;
  const pages = useAtomValue<readonly SharedDocument[]>(session.atoms.sharedDocuments);
  const typePlacements = useAtomValue(session.atoms.typePlacements);
  const members = useMembers(host, lane === 'team' ? scope.orgId : null);
  const [search, setSearch] = useState(() => pagesSearchQuery(EMPTY_PAGES_SEARCH));

  const { memberEmail, authorLabel } = useMemo(() => {
    const byId = new Map(members.map((member) => [String(member.memberId), member]));
    const byEmail = new Map(members.flatMap((member) => (member.email ? [[member.email.toLowerCase(), member] as const] : [])));
    return {
      memberEmail: (memberId: string) => byId.get(memberId)?.email ?? null,
      authorLabel: (author: string) => {
        if (me && author.toLowerCase() === me.toLowerCase()) return 'You';
        const member = byEmail.get(author.toLowerCase()) ?? byId.get(author);
        return member?.name || member?.email || (author.includes('@') ? author.split('@')[0] : 'Unknown');
      },
    };
  }, [members, me]);
  const searchPages = useMemo(() => session.searchPages.bind(session), [session]);
  const teamProjectId = scope.indexConfig.teamProjectId ?? null;

  return (
    <TrackersUIProvider {...section.provider}>
      <PagesSearchView
        lane={lane}
        pages={pages}
        typePlacements={typePlacements}
        memberEmail={memberEmail}
        authorLabel={authorLabel}
        me={me}
        search={search}
        onSearchChange={(next) => setSearch(next)}
        searchPages={searchPages}
        onOpenPage={(documentId, options) => host.openArtifact({ kind: 'document', scope, documentId, teamProjectId }, 'sidebar', options)}
        onOpenItem={(trackerId, options) => host.openArtifact({ kind: 'tracker', scope, trackerId }, 'sidebar', options)}
      />
    </TrackersUIProvider>
  );
}
