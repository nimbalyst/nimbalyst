import type {
  OrgSettings,
  OrgSettingsChangedEvent,
  OrgSettingsGetRequest,
  OrgSettingsUpdateRequest,
} from '../../shared/orgSettings';

export function getOrgSettings(
  request: OrgSettingsGetRequest,
): Promise<OrgSettings> {
  return window.electronAPI.invoke('org:settings:get', request);
}

export function updateOrgSettings(
  request: OrgSettingsUpdateRequest,
): Promise<OrgSettings> {
  return window.electronAPI.invoke('org:settings:set', request);
}

export async function renameOrganization(
  orgId: string,
  name: string,
): Promise<{ orgId: string; name: string }> {
  const result = await window.electronAPI.organization.rename(orgId, name);
  if (!result?.success || !result.organization) {
    throw new Error(result?.error || 'Could not rename organization');
  }
  return result.organization;
}

/**
 * Forward a team-sync `orgSettingsUpdated` broadcast to main so every window
 * (the organization window included, which holds no team-sync socket of its
 * own) sees the change.
 */
export function applyOrgSettingsBroadcast(
  event: OrgSettingsChangedEvent,
): Promise<{ success: boolean }> {
  return window.electronAPI.invoke('org:settings:apply', event);
}
