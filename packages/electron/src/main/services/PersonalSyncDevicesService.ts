import { getCollabSyncHttpUrl, getCollabSyncWsUrl } from '../utils/collabSyncUrl';
import { getSessionSyncConfig } from '../utils/store';
import { getPersonalSessionJwt, refreshPersonalSession } from './StytchAuthService';

export interface PersonalSyncDevice {
  deviceId: string;
  name: string;
  type?: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  platform?: string;
  appVersion?: string;
  connectedAt?: number;
  lastActiveAt?: number;
  isOnline?: boolean;
  lastSeenAt?: number;
}

export type PersonalSyncDevicesResult =
  | { success: true; devices: PersonalSyncDevice[]; sessionCount: number; projectCount: number }
  | { success: false; devices: []; error: string };

function fetchPersonalSyncDevices(httpUrl: string, jwt: string): Promise<Response> {
  return fetch(`${httpUrl}/api/sessions`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
    signal: AbortSignal.timeout(5000),
  });
}

export async function listPersonalSyncDevices(): Promise<PersonalSyncDevicesResult> {
  const config = getSessionSyncConfig();
  if (!config?.enabled) {
    return { success: false, devices: [], error: 'Sync not configured' };
  }

  try {
    const wsUrl = getCollabSyncWsUrl();
    const httpUrl = getCollabSyncHttpUrl();
    let jwt = getPersonalSessionJwt();
    if (!jwt) {
      await refreshPersonalSession(wsUrl);
      jwt = getPersonalSessionJwt();
    }
    if (!jwt) {
      return { success: false, devices: [], error: 'Not authenticated' };
    }

    let response = await fetchPersonalSyncDevices(httpUrl, jwt);
    if (response.status === 401) {
      await refreshPersonalSession(wsUrl);
      jwt = getPersonalSessionJwt();
      if (!jwt) {
        return { success: false, devices: [], error: 'Not authenticated' };
      }
      response = await fetchPersonalSyncDevices(httpUrl, jwt);
    }

    if (!response.ok) {
      return { success: false, devices: [], error: `Server returned ${response.status}` };
    }

    const data = await response.json() as {
      devices?: PersonalSyncDevice[];
      session_count?: number;
      project_count?: number;
    };
    return {
      success: true,
      devices: data.devices ?? [],
      sessionCount: data.session_count ?? 0,
      projectCount: data.project_count ?? 0,
    };
  } catch (error) {
    return {
      success: false,
      devices: [],
      error: error instanceof Error ? error.message : 'Failed to get devices',
    };
  }
}
