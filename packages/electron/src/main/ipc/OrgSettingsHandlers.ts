import { BrowserWindow } from "electron";
import type {
  OrgSettingsChangedEvent,
  OrgSettingsGetRequest,
  OrgSettingsUpdateRequest,
} from "../../shared/orgSettings";

import { normalizeOrgSettings } from "../../shared/orgSettings";
import { getOrgSettings, updateOrgSettings } from "../services/TeamService";
import { safeHandle } from "../utils/ipcRegistry";

/**
 * Organization settings IPC.
 *
 * Reads and writes go through the team API with a team JWT; every change is
 * broadcast to all windows because the organization window is a separate
 * renderer from the project window that owns the team-sync socket. A remote
 * member's change arrives on that socket and is forwarded here
 * (`org:settings:apply`) so the org window's atoms update live too.
 */
export function registerOrgSettingsHandlers(): void {
  safeHandle(
    "org:settings:get",
    async (_event, request: OrgSettingsGetRequest) => {
      assertOrgId(request);
      return getOrgSettings(request.orgId);
    },
  );

  safeHandle(
    "org:settings:set",
    async (_event, request: OrgSettingsUpdateRequest) => {
      assertOrgId(request);
      if (!request.settings) {
        throw new Error("org:settings:set requires settings");
      }
      const settings = await updateOrgSettings(request.orgId, request.settings);
      broadcastOrgSettingsChanged({ orgId: request.orgId, settings });
      return settings;
    },
  );

  // Write-through for the team-sync `orgSettingsUpdated` broadcast, matching
  // the `org:apply-*` member projection handlers: the renderer holding the
  // socket hands the payload to main, which fans it out to every window.
  safeHandle(
    "org:settings:apply",
    async (_event, request: OrgSettingsChangedEvent) => {
      assertOrgId(request);
      // A broadcast that carried no settings must stay empty: fabricating the
      // defaults here would look authoritative to the renderer and overwrite
      // the organization's real configuration with a permissive one. Without
      // them the listener re-reads instead.
      broadcastOrgSettingsChanged({
        orgId: request.orgId,
        ...(request.settings
          ? { settings: normalizeOrgSettings(request.settings) }
          : {}),
      });
      return { success: true };
    },
  );
}

function broadcastOrgSettingsChanged(payload: OrgSettingsChangedEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("org:settings-changed", payload);
    }
  }
}

function assertOrgId(
  value: { orgId?: string } | null | undefined,
): asserts value is { orgId: string } {
  if (!value?.orgId) {
    throw new Error("Organization id is required");
  }
}
