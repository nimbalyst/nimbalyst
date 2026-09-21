import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAtomValue, useStore } from 'jotai';

import { organizationDirectoryStateAtom, personalAccountsAtom } from '../../store/atoms/settingsDomains';
import { refreshOrganizationDirectory } from '../../store/listeners/stytchAuthListeners';
import { OrgModeBody } from './OrgModeBody';
import { OrgModeUnboundArm } from './OrgModeUnboundArm';
import { OrgWindowTitleBar } from './OrgWindowTitleBar';
import {
  createAtomInboxProvider,
  InboxProviderContext,
  useInboxProvider,
} from './Inbox/inboxProvider';
import { isActiveMembership, persistLastSelectedOrgId } from './defaultOrg';
import type { OrgModeHostProps, OrgModeHostRef, TeamSummary } from './orgModeTypes';
import { normalizeTeamAnalyticsCallerRole } from '../../../shared/analytics/teamAnalytics';
import { trackTeamAnalyticsEvent } from '../../utils/teamAnalytics';

export type { OrgModeChrome, OrgModeHostProps, OrgModeHostRef, TeamSummary } from './orgModeTypes';

export const OrgModeHost = forwardRef<OrgModeHostRef, OrgModeHostProps>(
  function OrgModeHost(props, ref) {
    const jotaiStore = useStore();
    const atomInboxProvider = useMemo(
      () => createAtomInboxProvider(jotaiStore),
      [jotaiStore],
    );
    const inboxProvider = useInboxProvider(atomInboxProvider);
    // Re-clicking the active gutter icon collapses the left pane, the way every
    // other content mode behaves. The window has no gutter, so it never toggles.
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    useImperativeHandle(ref, () => ({
      toggleSidebarCollapsed: () => setSidebarCollapsed((collapsed) => !collapsed),
    }), []);
    return (
      <InboxProviderContext.Provider value={inboxProvider}>
        <OrgModeHostContent {...props} sidebarCollapsed={sidebarCollapsed} />
      </InboxProviderContext.Provider>
    );
  },
);

function OrgModeHostContent({
  orgId,
  workspacePath,
  surfaceId,
  chrome = 'mode',
  isActive = true,
  onOrgIdChange,
  sidebarCollapsed,
}: OrgModeHostProps & { sidebarCollapsed: boolean }) {
  const directory = useAtomValue(organizationDirectoryStateAtom);
  const accounts = useAtomValue(personalAccountsAtom);
  const organizations = directory.entries;
  const [workspaceTarget, setWorkspaceTarget] = useState<{ path: string; orgId: string | null } | null>(null);
  const workspaceOrgId = workspaceTarget && workspaceTarget.path === workspacePath ? workspaceTarget.orgId : null;
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const team = organizations.find((organization) =>
    organization.orgId === (orgId ?? workspaceOrgId) && isActiveMembership(organization.membershipType)) ?? null;
  const personalOrgId = team?.boundPersonalOrgId ?? team?.owningPersonalOrgId;
  const boundEmail = accounts.find((account) => account.personalOrgId === personalOrgId)?.email ?? team?.sourceEmail ?? null;
  const organizationLoadError = directory.status === 'error' ? directory.error ?? 'Organizations could not be loaded.' : localError;
  const surfaceOpenRecordedRef = useRef(false);

  const selectOrganization = useCallback((orgId: string) => {
    const selectedOrganization = organizations.find((organization) => organization.orgId === orgId);
    trackTeamAnalyticsEvent('team_organization_switched', {
      surface: 'desktop',
      entryPoint: 'org_switcher',
      callerRole: normalizeTeamAnalyticsCallerRole(selectedOrganization?.role),
    });
    onOrgIdChange?.(orgId);
    void persistLastSelectedOrgId(orgId);
  }, [onOrgIdChange, organizations]);

  const reloadOrganizations = useCallback(() => {
    setLocalError(null);
    refreshOrganizationDirectory();
  }, []);

  useEffect(() => {
    if (!isActive || orgId || !workspacePath || !directory.complete) {
      setWorkspaceLoading(false);
      return;
    }
    let cancelled = false;
    setWorkspaceLoading(true);
    void window.electronAPI.team.findForWorkspace(workspacePath).then((result: { success?: boolean; complete?: boolean; team?: TeamSummary | null; orgId?: string; error?: string } | null) => {
      if (cancelled) return;
      if (result?.success === false || result?.complete === false) {
        throw new Error(result?.error || 'Workspace organization could not be loaded.');
      }
      setWorkspaceTarget({ path: workspacePath, orgId: (result?.team ?? result)?.orgId ?? null });
      setLocalError(null);
    }).catch((error: unknown) => {
      if (!cancelled) setLocalError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (!cancelled) setWorkspaceLoading(false); });
    return () => { cancelled = true; };
  }, [directory, isActive, orgId, workspacePath]);

  useEffect(() => {
    if (!isActive || !directory.complete || workspaceLoading || (!orgId && workspacePath && workspaceTarget?.path !== workspacePath) || surfaceOpenRecordedRef.current) return;
    surfaceOpenRecordedRef.current = true;
    trackTeamAnalyticsEvent('team_surface_opened', {
      surface: 'desktop', entryPoint: 'account_org_list', hasActiveOrganization: !!team,
      callerRole: normalizeTeamAnalyticsCallerRole(team?.role),
    });
  }, [directory.complete, isActive, orgId, team, workspaceLoading, workspacePath, workspaceTarget]);

  // Every arm carries the title-bar strip: the traffic lights are drawn over
  // the window whatever it is showing, and they must never land on content.
  if (!team && (directory.status === 'loading' || workspaceLoading)) {
    return (
      <section className="org-mode-host team-mode team-mode-loading-arm flex h-full flex-col overflow-hidden bg-[var(--nim-bg)] text-[var(--nim-text)]" data-component="OrgModeHost">
        {chrome === 'window' && <OrgWindowTitleBar />}
        <div className="team-mode-loading flex flex-1 items-center justify-center text-sm text-nim-muted">Loading organization…</div>
      </section>
    );
  }

  if (!team) {
    return (
      <OrgModeUnboundArm
        chrome={chrome}
        targetedOrgId={orgId}
        organizations={organizations}
        loadError={organizationLoadError}
        onSelectOrganization={selectOrganization}
        onReload={reloadOrganizations}
        onLoadError={setLocalError}
      />
    );
  }

  return (
    <div className="org-mode-directory-host flex h-full min-h-0 flex-col">
      {!directory.complete && (
        <div className="org-mode-directory-status px-4 py-2 text-sm text-nim-muted" role="status">
          {directory.status === 'error' ? organizationLoadError : 'Refreshing organizations…'}
          {directory.status === 'error' && <button type="button" onClick={reloadOrganizations}>Retry</button>}
        </div>
      )}
      <OrgModeBody
        team={team}
        organizations={organizations}
        boundEmail={boundEmail}
        workspacePath={workspacePath}
        surfaceId={surfaceId}
        chrome={chrome}
        sidebarCollapsed={sidebarCollapsed}
        onSelectOrganization={selectOrganization}
      />
    </div>
  );
}
