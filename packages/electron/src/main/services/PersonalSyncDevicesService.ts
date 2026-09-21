import {
  getCollabSyncHttpUrl,
  getCollabSyncWsUrl,
} from "../utils/collabSyncUrl";
import { getSessionSyncConfig } from "../utils/store";
import {
  getPersonalSessionJwt,
  refreshPersonalSessionDetailed,
  getPersonalUserId,
} from "./StytchAuthService";
import type { PersonalJwt } from "@nimbalyst/runtime/auth/jwtScopes";

export interface PersonalSyncDevice {
  deviceId: string;
  name: string;
  type?: "desktop" | "mobile" | "tablet" | "headless" | "unknown";
  inventoryHidden?: boolean;
  platform?: string;
  appVersion?: string;
  connectedAt?: number;
  lastActiveAt?: number;
  isOnline?: boolean;
  lastSeenAt?: number;
}

export type PersonalSyncDevicesResult =
  | {
      success: true;
      devices: PersonalSyncDevice[];
      sessionCount: number;
      projectCount: number;
      accountId: string | null;
      inventoryVersion?: number;
    }
  | { success: false; devices: []; error: string };

function fetchPersonalSyncDevices(
  httpUrl: string,
  jwt: PersonalJwt,
  update?: DeviceInventoryUpdate
): Promise<Response> {
  return fetch(`${httpUrl}/api/${update ? "devices" : "sessions"}`, {
    method: update ? "POST" : "GET",
    body: update ? JSON.stringify(update) : undefined,
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
  refresh: { ok: boolean; reason?: string; detail?: string } | null
): string {
  if (refresh && !refresh.ok && refresh.reason === "network") {
    const detail = refresh.detail ? ` (${refresh.detail})` : "";
    return `Sync server ${serverUrl} is unreachable${detail}`;
  }
  return "Not authenticated";
}

export interface DeviceInventoryUpdate {
  accountId: string;
  deviceIds: string[];
  hidden?: boolean;
  label?: string;
}

export async function updatePersonalSyncDevices(
  update: DeviceInventoryUpdate
): Promise<PersonalSyncDevicesResult> {
  if (!update || !update.accountId || update.accountId !== getPersonalUserId())
    return {
      success: false,
      devices: [],
      error: "Personal sync account changed",
    };
  if (
    !Array.isArray(update.deviceIds) ||
    !update.deviceIds.length ||
    update.deviceIds.length > 64 ||
    update.deviceIds.some(
      (id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)
    ) ||
    (update.hidden !== undefined && typeof update.hidden !== "boolean") ||
    (update.label !== undefined &&
      (typeof update.label !== "string" ||
        update.label.length > 80 ||
        update.deviceIds.length !== 1)) ||
    (update.hidden === undefined && update.label === undefined)
  ) {
    return { success: false, devices: [], error: "Invalid device update" };
  }
  return requestPersonalSyncDevices(update);
}

export function listPersonalSyncDevices(): Promise<PersonalSyncDevicesResult> {
  return requestPersonalSyncDevices();
}

async function requestPersonalSyncDevices(
  update?: DeviceInventoryUpdate
): Promise<PersonalSyncDevicesResult> {
  const config = getSessionSyncConfig();
  if (!config?.enabled) {
    return { success: false, devices: [], error: "Sync not configured" };
  }

  const account = getPersonalUserId();
  try {
    const wsUrl = getCollabSyncWsUrl();
    const httpUrl = getCollabSyncHttpUrl();
    let jwt = getPersonalSessionJwt();
    let refresh: Awaited<
      ReturnType<typeof refreshPersonalSessionDetailed>
    > | null = null;
    if (!jwt) {
      refresh = await refreshPersonalSessionDetailed(wsUrl);
      jwt = getPersonalSessionJwt();
    }
    if (!jwt) {
      // "Not authenticated" was shown here even when the refresh failed because
      // the sync server was unreachable -- a transport failure reported to the
      // user as an auth failure, which is exactly what the classifier exists to
      // prevent.
      return {
        success: false,
        devices: [],
        error: describeMissingJwt(wsUrl, refresh),
      };
    }

    if (account !== getPersonalUserId())
      return {
        success: false,
        devices: [],
        error: "Personal sync account changed",
      };
    let response = await fetchPersonalSyncDevices(httpUrl, jwt, update);
    if (response.status === 401) {
      refresh = await refreshPersonalSessionDetailed(wsUrl);
      jwt = getPersonalSessionJwt();
      if (!jwt) {
        return {
          success: false,
          devices: [],
          error: describeMissingJwt(wsUrl, refresh),
        };
      }
      if (account !== getPersonalUserId())
        return {
          success: false,
          devices: [],
          error: "Personal sync account changed",
        };
      response = await fetchPersonalSyncDevices(httpUrl, jwt, update);
    }

    if (account !== getPersonalUserId())
      return {
        success: false,
        devices: [],
        error: "Personal sync account changed",
      };
    if (!response.ok) {
      return {
        success: false,
        devices: [],
        error:
          update && response.status === 404
            ? "This sync server does not support inventory changes yet, or the device is no longer known. Refresh and try again."
            : update && response.status === 409
            ? "The computer reconnected. Only offline computers can be hidden."
            : `Server returned ${response.status}`,
      };
    }

    if (update) return requestPersonalSyncDevices();
    const data = (await response.json()) as {
      inventoryVersion?: number;
      devices?: PersonalSyncDevice[];
      session_count?: number;
      project_count?: number;
    };
    if (account !== getPersonalUserId())
      return {
        success: false,
        devices: [],
        error: "Personal sync account changed",
      };
    return {
      success: true,
      accountId: account,
      ...(typeof data.inventoryVersion === "number"
        ? { inventoryVersion: data.inventoryVersion }
        : {}),
      devices: data.devices ?? [],
      sessionCount: data.session_count ?? 0,
      projectCount: data.project_count ?? 0,
    };
  } catch (error) {
    return {
      success: false,
      devices: [],
      error: error instanceof Error ? error.message : "Failed to get devices",
    };
  }
}
