import type { SessionSyncConfig, WorkspaceState } from '../utils/store';

export function getWorkspaceSettingsOverview(
  workspacePath: string,
  workspace: WorkspaceState,
  sync: SessionSyncConfig | undefined,
) {
  const agentPermissionMode = workspace.agentPermissions?.permissionMode ?? null;
  // #1517: bypass-all stores both Agent-verified and Allow everything. Report
  // the flag even when inactive so agents can see what a trust toggle preserves.
  const allowAllUsesClassifier = workspace.agentPermissions?.allowAllUsesClassifier === true;
  const agentTrustLabel = agentPermissionMode === null
    ? 'Untrusted'
    : agentPermissionMode === 'bypass-all'
      ? (allowAllUsesClassifier ? 'Agent-verified' : 'Allow everything')
      : agentPermissionMode === 'allow-all' ? 'Allow edits only' : 'Ask every time';

  return {
    path: workspacePath,
    accountId: workspace.accountId ?? null,
    trackerSharingMigration: workspace.trackerSharingMigration ?? null,
    issueKeyPrefix: workspace.issueKeyPrefix ?? null,
    sessionSyncEnabled: (sync?.enabledProjects ?? []).includes(workspacePath),
    docSyncEnabled: (sync?.docSyncEnabledProjects ?? []).includes(workspacePath),
    agentPermissionMode,
    allowAllUsesClassifier,
    agentTrustLabel,
  };
}
