import { getCollabSyncHttpUrl, getCollabSyncWsUrl } from '../utils/collabSyncUrl';
import { getSessionSyncConfig } from '../utils/store';
import { getPersonalSessionJwt, refreshPersonalSessionDetailed } from './StytchAuthService';
import type { PersonalJwt } from '@nimbalyst/runtime/auth/jwtScopes';

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

function fetchPersonalSyncDevices(httpUrl: string, jwt: PersonalJwt): Promise<Response> {
  return fetch(`${httpUrl}/api/sessions`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
    signal: AbortSignal.timeout(5000),
  });
}

/**
 * Turn "we still have no personal JWT" into a message that names the real
 * cause. A refresh that could not reach the sync server must not be reported as
 * a sign-in problem: the stored session is fine and the fix is to retry, not to
 * re-authenticate.
 */
function describeMissingJwt(
  serverUrl: string,
  refresh: { ok: boolean; reason?: string; detail?: string } | null,
): string {
  if (refresh && !refresh.ok && refresh.reason === 'network') {
    const detail = refresh.detail ? ` (${refresh.detail})` : '';
    return `Sync server ${serverUrl} is unreachable${detail}`;
  }
  return 'Not authenticated';
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
    let refresh: Awaited<ReturnType<typeof refreshPersonalSessionDetailed>> | null = null;
    if (!jwt) {
      refresh = await refreshPersonalSessionDetailed(wsUrl);
      jwt = getPersonalSessionJwt();
    }
    if (!jwt) {
      // "Not authenticated" was shown here even when the refresh failed because
      // the sync server was unreachable -- a transport failure reported to the
      // user as an auth failure, which is exactly what the classifier exists to
      // prevent.
      return { success: false, devices: [], error: describeMissingJwt(wsUrl, refresh) };
    }

    let response = await fetchPersonalSyncDevices(httpUrl, jwt);
    if (response.status === 401) {
      refresh = await refreshPersonalSessionDetailed(wsUrl);
      jwt = getPersonalSessionJwt();
      if (!jwt) {
        return { success: false, devices: [], error: describeMissingJwt(wsUrl, refresh) };
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
