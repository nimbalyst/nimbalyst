import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { TrackerItem } from '@nimbalyst/runtime/core/DocumentService';
import { trackerItemToRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { replaceAllTrackerItemsAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { useAtom, useAtomValue, useStore } from 'jotai';

// The one administration panel this window still hosts: its unbound arm, where
// there is no organization to open the management dialog against.
import { OrganizationMembersRolesPanel } from '../Settings/panels/OrganizationMembersRolesPanel';
import { AlphaBadge } from '../common/AlphaBadge';
import { TEAM_ALPHA_TOOLTIP, TeamAlphaNotice } from '../common/TeamAlphaNotice';
import { selectedOrgIdAtom } from '../../store/atoms/orgScope';
import {
  organizationCreationEnabled,
  organizationDirectoryAtom,
} from '../../store/atoms/settingsDomains';
import {
  conversationDirectoryAtomFamily,
  conversationDirectoryLoadStateAtomFamily,
  conversationMembershipsByIdAtomFamily,
  conversationParticipantsByIdAtomFamily,
} from '../../store/atoms/conversations';
import {
  orgInboxUnreadCountAtomFamily,
  orgPresenceAtomFamily,
  orgUnreadCountsByConversationAtomFamily,
  teamInboxSnapshotAtom,
} from '../../store/atoms/teamInbox';
import {
  refreshConversationDirectory,
  refreshConversationMembers,
  setConversationMemberships,
} from '../../store/listeners/conversationDirectoryListeners';
import { orgSettingsAtomFamily } from '../../store/atoms/orgSettings';
import { initOrgWindowFreshnessListeners } from '../../store/listeners/orgWindowFreshnessListeners';
import { OrgWindowStatusBar } from './OrgWindowStatusBar';
import { OrgSidebar } from './OrgSidebar';
import { OrgRail } from './OrgRail';
import { OrgUserIndicator } from './OrgUserIndicator';
import {
  OrgProjectsSidebarSection,
  resolveConversationProjectWorkspace,
  useOrgProjectLocalStates,
} from './OrgProjectsSidebarSection';
import { OrgWelcomeBanner } from './onboarding/OrgWelcomeBanner';
import { isGeneralRoomId } from './onboarding/orgWelcomeModel';
import {
  useAcknowledgeOrgWindowPendingRoute,
} from './onboarding/useOrgWindowPendingRoute';
import { isOrgWindowPendingHandoffRoute } from './onboarding/pendingRouteHandoff';
import { RoomView } from './RoomView';
import { RoomsDirectory } from './RoomsDirectory';
import { ComposeDestinationDialog } from './ComposeDestinationDialog';
import { OrgWindowCommandBridge } from './OrgWindowCommandBridge';
import { CreateRoomDialog } from './CreateRoomDialog';
import { NewDirectMessageDialog } from './NewDirectMessageDialog';
import { OrgPreferencesDialog } from './OrgPreferencesDialog';
import { RoomSettingsDialog, type RoomSettingsSection } from './RoomSettingsDialog';
import { InboxSection } from './Inbox';
import {
  InboxProviderContext,
  useInboxProvider,
  type InboxProvider,
} from './Inbox/inboxProvider';
import { activeOrganizations, isActiveMembership, persistLastSelectedOrgId } from './defaultOrg';
import {
  buildOrgSidebar,
  isOrgAdminRole,
} from './orgSidebarViewModel';
import { shouldRenderOrgRail } from './orgWindowRailViewModel';
import {
  DIRECTORY_ROUTE,
  conversationRoute,
  gateOrgWindowRoute,
  orgWindowRouteAtom,
  routeAfterOrgChange,
  withOrgWindowRouting,
  type OrgWindowRoute,
} from './orgWindowState';
import { useOrgRoster } from './useOrgRoster';
import { useRoutedConversation } from './useRoutedConversation';
import { unreadDeliveryIdsForConversation } from '../../store/conversationDirectoryViewModel';
import { normalizeTeamAnalyticsCallerRole } from '../../../shared/analytics/teamAnalytics';
import { trackTeamAnalyticsEvent } from '../../utils/teamAnalytics';

// Workstream F will replace this interim destination with the shipped console route.
export const TEAM_CONSOLE_URL = 'https://console.nimbalyst.com';

export type { AdminTab, OrgWindowRoute } from './orgWindowState';

interface TeamSummary {
  orgId: string;
  name: string;
  boundPersonalOrgId?: string | null;
  sourceEmail?: string | null;
  owningPersonalOrgId?: string | null;
  membershipType?: string;
  role?: string;
}

export function TeamMode({ workspacePath, isActive = true }: { workspacePath?: string; isActive?: boolean }) {
  const [selectedOrgId, setSelectedOrgId] = useAtom(selectedOrgIdAtom);
  const hydratedOrganizations = useAtomValue(organizationDirectoryAtom);
  const [team, setTeam] = useState<TeamSummary | null>(null);
  const [organizations, setOrganizations] = useState<TeamSummary[]>([]);
  const [boundEmail, setBoundEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [organizationLoadError, setOrganizationLoadError] = useState<string | null>(null);
  const [organizationReloadNonce, setOrganizationReloadNonce] = useState(0);
  const surfaceOpenRecordedRef = useRef(false);

  const selectOrganization = useCallback((orgId: string) => {
    const selectedOrganization = organizations.find((organization) => organization.orgId === orgId);
    trackTeamAnalyticsEvent('team_organization_switched', {
      surface: 'desktop',
      entryPoint: 'org_switcher',
      callerRole: normalizeTeamAnalyticsCallerRole(selectedOrganization?.role),
    });
    setSelectedOrgId(orgId);
    void persistLastSelectedOrgId(orgId);
  }, [organizations, setSelectedOrgId]);

  useEffect(() => {
    if (!isActive) return;
    setLoading(true);
    setOrganizationLoadError(null);
    let cancelled = false;
    void Promise.all([
      // Only the workspace-hosted surface falls back to the workspace's team.
      // The standalone org window always targets an explicitly selected org.
      workspacePath
        ? window.electronAPI.team.findForWorkspace(workspacePath)
        : Promise.resolve(null),
      window.electronAPI.stytch.getAccounts(),
      // Always listed: the switcher offers every active membership, not just
      // the targeted one. `team:list` is cached in main, so this is cheap.
      window.electronAPI.organization.list(),
    ]).then(([result, accounts, directory]) => {
      if (cancelled) return;
      if (directory?.success === false) {
        throw new Error(directory.error || 'Organization directory unavailable');
      }
      const workspaceTeam = result?.team ?? result ?? null;
      const listedOrganizations: TeamSummary[] =
        directory?.success && Array.isArray(directory.teams)
          ? directory.teams
          : [];
      const organizations = listedOrganizations.length > 0
        ? listedOrganizations
        : hydratedOrganizations;
      setOrganizations(organizations);
      const selectedTeam = selectedOrgId
        ? organizations.find((organization) =>
          organization.orgId === selectedOrgId && isActiveMembership(organization.membershipType)) ?? null
        : null;

      const found = selectedOrgId ? selectedTeam : workspaceTeam;
      setTeam(found?.orgId ? found : null);
      if (!surfaceOpenRecordedRef.current) {
        surfaceOpenRecordedRef.current = true;
        trackTeamAnalyticsEvent('team_surface_opened', {
          surface: 'desktop',
          entryPoint: 'account_org_list',
          hasActiveOrganization: !!found?.orgId,
          callerRole: normalizeTeamAnalyticsCallerRole(found?.role),
        });
      }
      const personalOrgId = found?.boundPersonalOrgId ?? found?.owningPersonalOrgId;
      setBoundEmail(accounts.find((account) => account.personalOrgId === personalOrgId)?.email ?? found?.sourceEmail ?? null);
      setLoading(false);
    }).catch((error) => {
      if (!cancelled) {
        setOrganizationLoadError(
          error instanceof Error ? error.message : String(error),
        );
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [
    hydratedOrganizations,
    isActive,
    organizationReloadNonce,
    selectedOrgId,
    workspacePath,
  ]);

  // Every arm carries the title-bar strip: the traffic lights are drawn over
  // the window whatever it is showing, and they must never land on content.
  if (loading) {
    return (
      <section className="team-mode team-mode-loading-arm flex h-full flex-col overflow-hidden" data-component="TeamMode">
        <OrgWindowTitleBar />
        <div className="team-mode-loading flex flex-1 items-center justify-center text-sm text-[var(--nim-text-muted)]">Loading organization…</div>
      </section>
    );
  }

  // No org resolved: offer to create one (or accept a pending invite).
  if (!team) {
    return (
      <section className="team-mode team-mode-unbound flex h-full flex-col overflow-hidden" data-component="TeamMode">
        <OrgWindowTitleBar />
        <header
          className="team-mode-header org-window-drag-region border-b border-[var(--nim-border)] px-6 py-5"
          data-window-drag-region="true"
        >
          <h1 className="m-0 flex items-center gap-2 text-xl font-semibold text-[var(--nim-text)]">
            Organizations
            <AlphaBadge size="sm" tooltip={TEAM_ALPHA_TOOLTIP} className="org-window-no-drag" />
          </h1>
          <p className="m-0 mt-1 text-sm text-[var(--nim-text-muted)]">
            {selectedOrgId
              ? 'This organization is not available yet. Your destination has been preserved.'
              : organizationCreationEnabled
                ? 'Create an organization to collaborate with a team, or accept a pending invitation.'
                : 'Creating an organization is temporarily unavailable. Accept a pending invitation to get started.'}
          </p>
          <TeamAlphaNotice className="mt-2.5 max-w-[640px]" />
        </header>
        <main className="team-mode-content flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-[900px]">
            {/* Escape hatch: never leave the user here with orgs they could
                administer but no way to reach them. */}
            <div className="team-mode-organization-choices mb-3 flex flex-col gap-2" data-testid="team-mode-organization-choices">
              {activeOrganizations(organizations).map((organization) => (
                <button
                  key={organization.orgId}
                  type="button"
                  className="team-mode-organization-choice flex items-center justify-between rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 py-2 text-left text-sm text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                  data-testid="team-mode-organization-choice"
                  data-org-id={organization.orgId}
                  onClick={() => selectOrganization(organization.orgId)}
                >
                  <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                  {organization.role && (
                    <span className="ml-2 shrink-0 text-[11px] capitalize text-[var(--nim-text-muted)]">
                      {organization.role}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {selectedOrgId && (
              <div
                className="team-mode-organization-recovery mb-4 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-4"
                data-testid="team-mode-organization-recovery"
              >
                <p className="m-0 text-sm text-[var(--nim-text)]">
                  {organizationLoadError ?? 'Waiting for your organization membership to finish loading.'}
                </p>
                <button
                  type="button"
                  className="mt-3 rounded-md bg-[var(--nim-primary)] px-3 py-1.5 text-xs font-semibold text-[var(--nim-on-primary)]"
                  data-testid="team-mode-retry-organization"
                  onClick={() => setOrganizationReloadNonce((value) => value + 1)}
                >
                  Retry
                </button>
              </div>
            )}
            {!selectedOrgId && <OrganizationMembersRolesPanel orgId="" />}
          </div>
        </main>
      </section>
    );
  }

  return (
    <OrgWindowBody
      team={team}
      organizations={organizations}
      boundEmail={boundEmail}
      onSelectOrganization={selectOrganization}
    />
  );
}

/**
 * The bound-organization window: messaging sidebar plus one main surface.
 *
 * Messaging is all of it since NIM-2322 — administration is the
 * `ORG_MANAGEMENT` dialog, which opens in whichever window the user is already
 * in, this one included.
 *
 * Split out from `TeamMode` because the org-scoped hooks below (directory,
 * roster, unread derivation) only make sense once an organization is resolved —
 * the unbound and loading arms above must not run them.
 */
function OrgWindowBody({
  team,
  organizations,
  boundEmail,
  onSelectOrganization,
}: {
  team: TeamSummary;
  organizations: TeamSummary[];
  boundEmail: string | null;
  onSelectOrganization: (orgId: string) => void;
}) {
  const orgId = team.orgId;
  const trackerStore = useStore();
  // The route lives here rather than in `TeamMode` above: the window's identity
  // arms do not navigate, and holding it at the root re-rendered every one of
  // them on each hop. Everything below that only needs to know whether it is
  // the selected destination reads its own atom instead of taking a prop.
  const [route, setRoute] = useAtom(orgWindowRouteAtom);
  const onRoute = setRoute;
  const conversations = useAtomValue(conversationDirectoryAtomFamily(orgId));
  const directoryLoadState = useAtomValue(conversationDirectoryLoadStateAtomFamily(orgId));
  const participantsByConversationId = useAtomValue(
    conversationParticipantsByIdAtomFamily(orgId),
  );
  const membershipsByConversationId = useAtomValue(
    conversationMembershipsByIdAtomFamily(orgId),
  );
  // Deliberately not the whole snapshot: it is replaced whenever any authorized
  // organization moves, including presence heartbeats and this window's own
  // mark-read receipts. These three selectors keep their identity when this
  // organization's slice did not change, so unrelated traffic no longer
  // rebuilds the sidebar model or re-renders the body.
  const unreadCounts = useAtomValue(
    orgUnreadCountsByConversationAtomFamily(orgId),
  );
  const presenceByMemberId = useAtomValue(orgPresenceAtomFamily(orgId));
  const inboxUnread = useAtomValue(orgInboxUnreadCountAtomFamily(orgId));
  const settings = useAtomValue(orgSettingsAtomFamily(orgId));
  const roster = useOrgRoster(orgId);
  const baseInboxProvider = useInboxProvider();
  const onboardingDirectoryRetriesRef = useRef(0);
  const projectLocalState = useOrgProjectLocalStates(orgId);
  const showOrgRail = shouldRenderOrgRail(organizations);
  const openWebConsole = useCallback(() => {
    window.electronAPI.openExternal(TEAM_CONSOLE_URL);
  }, []);
  const openProjectWorkspace = useCallback((workspacePath: string) => {
    void window.electronAPI.team.openProjectWorkspace(workspacePath).catch((reason) => {
      console.error('[TeamMode] Failed to open project workspace:', reason);
    });
  }, []);

  useEffect(() => {
    return initOrgWindowFreshnessListeners({
      getOrgId: () => orgId,
    });
  }, [orgId]);

  // A conversation id belongs to exactly one organization. Switching orgs with
  // a room selected would otherwise render "no longer available" against the
  // new org, so the window falls back to its landing view. The exception is the
  // invite-accept / wizard hand-off: when it has already pointed this window at
  // #general, this mount must not undo it and land the new member on Inbox.
  useEffect(() => {
    onRoute(routeAfterOrgChange(orgId, route));
    // Only on an org change: this deliberately does not react to `route`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const isOrgAdmin = isOrgAdminRole(roster.callerRole);
  const sidebar = useMemo(() => buildOrgSidebar({
    conversations,
    settings,
    isOrgAdmin,
    unreadCounts,
    dmParticipants: participantsByConversationId,
    memberNames: roster.memberNames,
    viewerUserId: roster.viewerUserId ?? undefined,
    presenceByMemberId,
  }), [
    conversations,
    isOrgAdmin,
    participantsByConversationId,
    presenceByMemberId,
    roster.memberNames,
    roster.viewerUserId,
    settings,
    unreadCounts,
  ]);
  const gating = sidebar.gating;

  // Turning rooms or DMs off while someone is reading one has to move them:
  // the disabled surface is gone from the sidebar and the server would reject
  // a post there anyway. An administration route left over from before
  // NIM-2322 lands here too — this window has no such surface any more.
  useEffect(() => {
    const gated = gateOrgWindowRoute(route, gating, conversations);
    if (gated !== route) onRoute(gated);
  }, [conversations, gating, onRoute, route]);

  const inboxProvider = useMemo(
    () => withOrgWindowRouting(baseInboxProvider, orgId, onRoute),
    [baseInboxProvider, onRoute, orgId],
  );

  const routedConversation = useRoutedConversation(
    orgId,
    route.view === 'conversation' ? route.conversationId : undefined,
    conversations,
    directoryLoadState.status === 'ready'
      || directoryLoadState.status === 'error',
  );
  const activeConversation = routedConversation.entry;
  const activeConversationId = activeConversation?.id;
  const activeConversationProjectWorkspace = activeConversation
    ? resolveConversationProjectWorkspace(projectLocalState.projects, activeConversation)
    : null;
  const pendingDestination = isOrgWindowPendingHandoffRoute(orgId, route);

  useAcknowledgeOrgWindowPendingRoute(
    orgId,
    route.view === 'conversation' ? route.conversationId : undefined,
    directoryLoadState.status === 'ready'
      && activeConversationId === route.conversationId,
  );

  // A freshly accepted membership can become visible before the TeamRoom's
  // conversation directory has finished materializing #general. Keep the
  // durable hand-off and retry the existing directory read a few times; focus
  // and the sidebar Retry action remain available after the bounded attempts.
  useEffect(() => {
    if (!pendingDestination || activeConversationId === route.conversationId) {
      onboardingDirectoryRetriesRef.current = 0;
      return;
    }
    if (
      directoryLoadState.status === 'idle'
      || directoryLoadState.status === 'loading'
      || onboardingDirectoryRetriesRef.current >= 3
    ) {
      return;
    }
    const attempt = onboardingDirectoryRetriesRef.current++;
    const timeout = window.setTimeout(() => {
      void refreshConversationDirectory(orgId).catch(() => {
        // The load-state error and the sidebar retry affordance remain visible.
      });
    }, 300 * (2 ** attempt));
    return () => window.clearTimeout(timeout);
  }, [
    activeConversationId,
    directoryLoadState.status,
    orgId,
    pendingDestination,
    route.conversationId,
  ]);

  const activeMemberships = activeConversationId
    ? membershipsByConversationId[activeConversationId]
    : undefined;

  // The Inbox is built once and then kept, so hopping between it and a room is
  // a visibility change rather than a rebuild. It is not mounted before it has
  // been visited: a window that opens straight into a room should not pay for a
  // surface nobody asked for.
  const [inboxMounted, setInboxMounted] = useState(route.view === 'inbox');
  useEffect(() => {
    if (route.view === 'inbox') setInboxMounted(true);
  }, [route.view]);

  useEffect(() => {
    window.electronAPI?.send?.('team-window:route-state', {
      orgId,
      view: route.view,
      ...(route.view === 'conversation' && activeConversationId
        ? { conversationId: activeConversationId }
        : {}),
    });
  }, [activeConversationId, orgId, route.view]);

  useEffect(() => {
    let cancelled = false;
    trackerStore.set(replaceAllTrackerItemsAtom, []);
    void window.electronAPI.invoke(
      'team-window:tracker-items-list',
      { orgId },
    ).then((items: TrackerItem[]) => {
      if (cancelled) return;
      trackerStore.set(
        replaceAllTrackerItemsAtom,
        (items ?? []).map(trackerItemToRecord),
      );
    }).catch((error) => {
      if (cancelled) return;
      console.error('[TeamMode] Failed to load tracker metadata:', error);
    });
    return () => { cancelled = true; };
  }, [orgId, trackerStore]);

  // Keyed on the id, not the entry object: every directory refresh produces a
  // fresh descriptor object for the same room, which would otherwise refetch
  // the membership list on each one.
  useEffect(() => {
    if (!activeConversationId) return;
    void refreshConversationMembers({
      orgId,
      conversationId: activeConversationId,
    }).catch(() => undefined);
  }, [activeConversationId, orgId]);

  // Room management dialogs are held here rather than in the global dialog
  // registry: each one reads org-scoped live state (roster, directory) and
  // hands a conversation id back to this component to route to, which the
  // registry's open-with-fixed-data shape does not carry.
  const [dialog, setDialog] = useState<OrgWindowDialog>(null);
  const settingsConversation = dialog?.kind === 'roomSettings'
    ? conversations.find((entry) => entry.id === dialog.conversationId) ?? null
    : null;

  // Route only once the directory holds the new conversation: routing first
  // would render "that conversation is no longer available" against a listing
  // that has not caught up with the create yet.
  const openConversation = useCallback(async (conversationId: string) => {
    await refreshConversationDirectory(orgId).catch(() => undefined);
    setDialog(null);
    onRoute(conversationRoute(conversationId));
  }, [onRoute, orgId]);

  const openCompose = useCallback(() => setDialog({ kind: 'compose' }), []);
  const openPreferences = useCallback(() => setDialog({ kind: 'preferences' }), []);
  const openCreateRoom = useCallback(() => setDialog({ kind: 'createRoom' }), []);
  const openNewDm = useCallback(() => setDialog({ kind: 'newDm' }), []);
  const openDirectory = useCallback(() => onRoute(DIRECTORY_ROUTE), [onRoute]);
  const retryDirectory = useCallback(() => {
    void refreshConversationDirectory(orgId).catch(() => {
      // The load state already carries the failure; the sidebar keeps showing
      // the error line rather than reverting to empty.
    });
  }, [orgId]);

  // The sidebar is memoized, so the two slots it renders have to hold their
  // identity across a navigation or the memo never bites.
  const projectsContent = useMemo(() => (
    <OrgProjectsSidebarSection
      orgId={orgId}
      projects={projectLocalState.projects}
      loading={projectLocalState.loading}
      error={projectLocalState.error}
      onReload={projectLocalState.reload}
    />
  ), [
    orgId,
    projectLocalState.error,
    projectLocalState.loading,
    projectLocalState.projects,
    projectLocalState.reload,
  ]);
  // Always the sidebar footer, rail visible or not: identity is per-organization
  // (a different Stytch member id per org) and the sidebar is the per-org pane,
  // so the indicator must not move around with the rail.
  const sidebarBottomContent = useMemo(() => (
    <OrgUserIndicator
      selectedOrgId={orgId}
      selectedTeamMemberId={roster.viewerUserId}
      selectedEmail={boundEmail}
      onOpenWebConsole={openWebConsole}
      onOpenPreferences={openPreferences}
      placement="top-start"
    />
  ), [
    boundEmail,
    openPreferences,
    openWebConsole,
    orgId,
    roster.viewerUserId,
  ]);

  return (
    <section className="team-mode flex h-full flex-col overflow-hidden" data-testid="team-mode" data-component="TeamMode">
      {/* Renders nothing: the Messages menu and Cmd+K land here. */}
      <OrgWindowCommandBridge
        orgId={orgId}
        route={route}
        sidebar={sidebar}
        inboxProvider={inboxProvider}
        onRoute={onRoute}
        onCompose={gating.roomsVisible || gating.dmsVisible ? openCompose : undefined}
      />
      <OrgWindowMarkReadOnOpen
        orgId={orgId}
        conversationId={route.view === 'conversation' ? route.conversationId : undefined}
        inboxProvider={inboxProvider}
      />
      <OrgWindowTitleBar
        name={team.name}
        onOpenPreferences={openPreferences}
      />
      <div className="team-mode-body flex min-h-0 flex-1">
        {showOrgRail && (
          <OrgRail
            organizations={organizations}
            selectedOrgId={orgId}
            onSelectOrganization={onSelectOrganization}
          />
        )}
        <OrgSidebar
          model={sidebar}
          inboxUnread={inboxUnread}
          directoryLoading={directoryLoadState.status === 'loading'}
          directoryError={directoryLoadState.status === 'error'
            ? directoryLoadState.error ?? 'Directory unavailable'
            : undefined}
          onRetryDirectory={retryDirectory}
          onNavigate={onRoute}
          onCreateRoom={gating.canCreateRoom ? openCreateRoom : undefined}
          onCreateDirectMessage={gating.canCreateDirectMessage ? openNewDm : undefined}
          projectsContent={projectsContent}
          bottomContent={sidebarBottomContent}
        />

        {/* Every surface in this window is a full-bleed messaging one (list plus
            pane, message list plus composer); the administration panels that
            wanted the narrow form column moved to the dialog. */}
        <main className="team-mode-content team-mode-content-full min-w-0 flex-1 overflow-hidden">
          <>
              {/* Kept mounted once visited, hidden rather than unmounted, the
                  way the project window's modes are. Every Inbox <-> room hop
                  used to rebuild the whole surface, re-read the stored
                  preferences over IPC and restart the relative-label timer,
                  and it dropped the search and selection on the way. */}
              {inboxMounted && (
                <div
                  className={`team-mode-inbox-slot h-full ${route.view === 'inbox' ? '' : 'hidden'}`}
                  data-testid="team-mode-inbox-slot"
                >
                  <InboxProviderContext.Provider value={inboxProvider}>
                    <InboxSection
                      onBrowseRooms={gating.roomsVisible ? openDirectory : undefined}
                      onNewMessage={gating.roomsVisible || gating.dmsVisible
                        ? openCompose
                        : undefined}
                      composeUnavailableLabel="Rooms and direct messages are turned off for this organization"
                    />
                  </InboxProviderContext.Provider>
                </div>
              )}
              {route.view === 'directory' && gating.roomsVisible && (
                <RoomsDirectory
                  orgId={orgId}
                  viewerUserId={roster.viewerUserId}
                  onOpenConversation={(conversationId) => onRoute(conversationRoute(conversationId))}
                  onCreateRoom={gating.canCreateRoom ? openCreateRoom : undefined}
                />
              )}
              {route.view === 'conversation' && (
                activeConversation
                  ? (
                    <RoomView
                      // Deliberately not keyed by conversation: the thread
                      // inside is, which is what actually has to be reset. A
                      // key here tore the header, its menus and every memo in
                      // the view down as well on each room click.
                      orgId={orgId}
                      entry={activeConversation}
                      viewerUserId={roster.viewerUserId}
                      members={roster.members}
                      // Invited-member onboarding lives where the member is
                      // being sent, under the room header, rather than in a
                      // window-wide band above every surface.
                      notice={isGeneralRoomId(activeConversation.id)
                        ? <OrgWelcomeBanner orgId={orgId} />
                        : undefined}
                      dmParticipants={
                        participantsByConversationId[activeConversation.id]
                      }
                      memberCount={
                        activeConversation.visibility === 'public'
                          ? roster.members.length
                          : activeMemberships?.filter(
                            (membership) => membership.removedAt === undefined,
                          ).length
                      }
                      onOpenRoomSettings={activeConversation.kind === 'orgRoom'
                        ? () => setDialog({
                          kind: 'roomSettings',
                          conversationId: activeConversation.id,
                          section: 'details',
                        })
                        : undefined}
                      onInviteMembers={activeConversation.kind === 'orgRoom'
                        ? () => setDialog({
                          kind: 'roomSettings',
                          conversationId: activeConversation.id,
                          section: 'members',
                        })
                        : undefined}
                      projectWorkspacePath={activeConversationProjectWorkspace}
                      onOpenProject={openProjectWorkspace}
                    />
                  )
                  : (
                    <div
                      className="org-conversation-missing flex h-full items-center justify-center text-sm text-[var(--nim-text-muted)]"
                      data-testid="org-conversation-missing"
                    >
                      {routedConversation.resolving
                        ? 'Loading conversation…'
                        : 'That conversation is no longer available.'}
                    </div>
                  )
              )}
          </>
        </main>
      </div>

      {/* Outside the body flex row and shrink-0, so the disclosure reserves its
          own height rather than overlaying either the sidebar or the room. */}
      <OrgWindowStatusBar />

      {/* The gating guards below matter because settings can change while a
          dialog is open: another admin turning rooms off must close the
          create-room sheet, not leave it submitting into a rejection. */}
      {dialog?.kind === 'createRoom' && gating.canCreateRoom && (
        <CreateRoomDialog
          orgId={orgId}
          members={roster.members}
          viewerUserId={roster.viewerUserId}
          existingConversations={conversations}
          onClose={() => setDialog(null)}
          onCreated={(conversationId) => { void openConversation(conversationId); }}
        />
      )}
      {dialog?.kind === 'newDm' && gating.canCreateDirectMessage && (
        <NewDirectMessageDialog
          orgId={orgId}
          members={roster.members}
          viewerUserId={roster.viewerUserId}
          conversations={conversations}
          participantsByConversationId={participantsByConversationId}
          onClose={() => setDialog(null)}
          onOpened={(conversationId) => { void openConversation(conversationId); }}
        />
      )}
      {dialog?.kind === 'compose'
        && (gating.roomsVisible || gating.dmsVisible) && (
        <ComposeDestinationDialog
          orgId={orgId}
          conversations={conversations}
          members={roster.members}
          viewerUserId={roster.viewerUserId}
          participantsByConversationId={participantsByConversationId}
          allowRooms={gating.roomsVisible}
          allowDirectMessages={gating.dmsVisible}
          onClose={() => setDialog(null)}
          onOpenConversation={(conversationId) => { void openConversation(conversationId); }}
        />
      )}
      {dialog?.kind === 'preferences' && (
        <OrgPreferencesDialog onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'roomSettings' && settingsConversation && (
        <RoomSettingsDialog
          orgId={orgId}
          entry={settingsConversation}
          members={roster.members}
          viewerUserId={roster.viewerUserId}
          memberships={
            membershipsByConversationId[settingsConversation.id] ?? null
          }
          onMembershipsChange={(memberships) => {
            setConversationMemberships(
              {
                orgId,
                conversationId: settingsConversation.id,
              },
              memberships,
            );
          }}
          initialSection={dialog.section}
          onClose={() => setDialog(null)}
          onArchived={() => {
            // The archived room drops out of the sidebar, so the window cannot
            // stay pointed at it.
            setDialog(null);
            onRoute({ view: 'inbox' });
            void refreshConversationDirectory(orgId).catch(() => undefined);
          }}
        />
      )}
    </section>
  );
}

/**
 * The window's title bar: one full-width strip above the rail, the sidebar and
 * the main pane.
 *
 * The org rail used to reserve a 52px spacer for the macOS traffic lights and
 * the sidebar header padded itself when the rail was hidden, which put the
 * lights inside a 64px column and left most of the chrome undraggable. A single
 * strip gives them a row of their own on both layouts and is the window's
 * primary drag handle — every control inside it opts out with
 * `.org-window-no-drag`.
 *
 * It keeps the `org-sidebar-header` marker: the organization name is still the
 * window's identity, it just names the window rather than the sidebar now.
 */
const OrgWindowTitleBar = React.memo(function OrgWindowTitleBar({
  name,
  onOpenPreferences,
}: {
  name?: string;
  onOpenPreferences?: () => void;
}) {
  return (
    <header
      className="org-window-titlebar org-sidebar-header org-window-drag-region flex shrink-0 items-center gap-2 border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] pr-3"
      data-testid={name ? 'org-sidebar-header' : 'org-window-titlebar'}
      data-component="OrgWindowTitleBar"
      data-window-drag-region="true"
    >
      {/* Unnamed on the arms that have no organization yet: they carry their
          own heading, and the strip is there for the traffic lights. */}
      {name && (
        <>
          <span className="org-sidebar-header-name min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--nim-text)]">
            {name}
          </span>
          <AlphaBadge size="xs" tooltip={TEAM_ALPHA_TOOLTIP} className="org-window-no-drag shrink-0" />
          {onOpenPreferences && (
            // Inside the drag strip, so it has to opt out by hand or the OS
            // eats the click as a window drag.
            <button
              type="button"
              className="org-window-preferences org-window-no-drag flex size-6 shrink-0 items-center justify-center rounded text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              data-testid="org-window-preferences"
              aria-label="Preferences"
              title="Preferences"
              onClick={onOpenPreferences}
            >
              <MaterialSymbol icon="settings" size={15} />
            </button>
          )}
        </>
      )}
    </header>
  );
});

/**
 * Marks the open conversation's inbox deliveries read. Renders nothing.
 *
 * Reading a room is what marks its deliveries read. Only activating an inbox
 * row did that before, so opening #general from the sidebar left its unread
 * pill up forever, and messages arriving while it was on screen kept adding to
 * it. Each delivery is marked once — the set guards against the snapshot churn
 * a mark-read round trip itself produces.
 *
 * It is its own component because it is the window's only consumer of the whole
 * inbox snapshot: subscribing to it from the body meant every delivery, receipt
 * and presence heartbeat re-rendered the entire window, and the mark-read this
 * effect performs fed straight back into that cascade.
 */
function OrgWindowMarkReadOnOpen({
  orgId,
  conversationId,
  inboxProvider,
}: {
  orgId: string;
  conversationId?: string;
  inboxProvider: InboxProvider;
}) {
  const inboxSnapshot = useAtomValue(teamInboxSnapshotAtom);
  const markedReadRef = useRef<Set<string>>(new Set());
  useEffect(() => { markedReadRef.current = new Set(); }, [orgId]);
  useEffect(() => {
    if (!conversationId) return;
    const pending = unreadDeliveryIdsForConversation(inboxSnapshot, {
      orgId,
      conversationId,
    }).filter((deliveryId) => !markedReadRef.current.has(deliveryId));
    if (pending.length === 0) return;
    for (const deliveryId of pending) markedReadRef.current.add(deliveryId);
    void inboxProvider.markRead(pending).catch(() => {
      // Left unmarked so a later snapshot retries rather than silently
      // dropping the read.
      for (const deliveryId of pending) markedReadRef.current.delete(deliveryId);
    });
  }, [conversationId, inboxProvider, inboxSnapshot, orgId]);
  return null;
}

type OrgWindowDialog =
  | { kind: 'createRoom' }
  | { kind: 'newDm' }
  | { kind: 'compose' }
  | { kind: 'preferences' }
  | {
    kind: 'roomSettings';
    conversationId: string;
    section: RoomSettingsSection;
  }
  | null;
