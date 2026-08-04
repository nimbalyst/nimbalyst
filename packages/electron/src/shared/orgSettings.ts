import type { OrgSettings } from '@nimbalyst/collab-protocol';

export type { OrgSettings };

export type OrgRoomCreationPolicy = OrgSettings['messaging']['roomCreation'];

/**
 * What an organization gets before anyone has opened the settings panel.
 *
 * Deliberately the same values the server defaults to: an org that has never
 * had settings written returns an empty/absent object, and both sides have to
 * land on "everything on" rather than one of them hiding rooms.
 */
export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  version: 1,
  messaging: {
    roomsEnabled: true,
    dmsEnabled: true,
    roomCreation: 'members',
  },
};

/**
 * Coerce whatever the server (or a stale cache) hands back into settings the
 * UI can read every field off.
 *
 * Settings are persisted state: an org whose row was written before a field
 * existed returns it missing, and a pre-settings server omits the object
 * entirely. Every field therefore falls back to its default individually
 * rather than the whole object being replaced on the first surprise.
 */
export function normalizeOrgSettings(value: unknown): OrgSettings {
  const source = isRecord(value) ? value : {};
  const messaging = isRecord(source.messaging) ? source.messaging : {};
  return {
    version: 1,
    messaging: {
      roomsEnabled: typeof messaging.roomsEnabled === 'boolean'
        ? messaging.roomsEnabled
        : DEFAULT_ORG_SETTINGS.messaging.roomsEnabled,
      dmsEnabled: typeof messaging.dmsEnabled === 'boolean'
        ? messaging.dmsEnabled
        : DEFAULT_ORG_SETTINGS.messaging.dmsEnabled,
      roomCreation: messaging.roomCreation === 'admins'
        || messaging.roomCreation === 'members'
        ? messaging.roomCreation
        : DEFAULT_ORG_SETTINGS.messaging.roomCreation,
    },
  };
}

export interface OrgSettingsPatch {
  messaging?: Partial<OrgSettings['messaging']>;
}

/**
 * Fold one toggle into the current settings.
 *
 * The server's PUT replaces the stored object wholesale — a body carrying only
 * `dmsEnabled` resets rooms back to the default — so every save sends complete
 * settings and the panel patches the object it already holds.
 */
export function applyOrgSettingsPatch(
  current: OrgSettings,
  patch: OrgSettingsPatch,
): OrgSettings {
  return normalizeOrgSettings({
    version: 1,
    messaging: { ...current.messaging, ...patch.messaging },
  });
}

export interface OrgSettingsGetRequest {
  orgId: string;
}

export interface OrgSettingsUpdateRequest {
  orgId: string;
  settings: OrgSettings;
}

export interface OrgSettingsResult {
  settings: OrgSettings;
}

/**
 * Broadcast when an organization's settings change, from this client's own PUT
 * or from another member's over the team-sync channel. `settings` is carried
 * when the sender already has the authoritative object so listeners can apply
 * it without a round trip; otherwise the listener re-reads.
 */
export interface OrgSettingsChangedEvent {
  orgId: string;
  settings?: OrgSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
