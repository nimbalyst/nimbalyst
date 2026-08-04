import React, { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';

import type { OrgSettings, OrgSettingsPatch } from '../../../../shared/orgSettings';
import { applyOrgSettingsPatch } from '../../../../shared/orgSettings';
import {
  renameOrganization,
  updateOrgSettings,
} from '../../../services/orgSettingsClient';
import {
  orgSettingsAtomFamily,
  orgSettingsLoadStateAtomFamily,
} from '../../../store/atoms/orgSettings';
import { refreshOrgSettings } from '../../../store/listeners/orgSettingsListeners';
import { HelpTooltip } from '../../../help';
import { SettingsToggle } from '../../GlobalSettings/SettingsToggle';
import { OrganizationSecurityPanel } from './OrganizationSecurityPanel';

/**
 * Organization-level configuration: messaging toggles plus the custody and
 * encryption status that had no home before this panel existed.
 *
 * Writes are organization-admin only and the server enforces that too — a
 * member sees the same values, read-only, rather than a panel that 403s on
 * click. Turning rooms or DMs off hides them everywhere in the org window; the
 * conversations themselves are retained server-side and come back if the
 * setting is turned on again.
 */
export function OrganizationSettingsPanel({
  orgId,
  orgName,
  ownerEmail,
  callerRole,
  onRenamed,
}: {
  orgId?: string;
  orgName?: string | null;
  /**
   * The account the organization is billed to / owned by. Shown here since the
   * org window's header band was folded into the sidebar (2026-07-28 layout
   * decision) and this is the only place left that states it.
   */
  ownerEmail?: string | null;
  /** The viewer's role in this organization; only owners/admins may write. */
  /** Null while the roster has not resolved a role for this organization. */
  callerRole?: string | null;
  onRenamed?: (name: string) => void;
}) {
  const canAdminister = callerRole === 'owner' || callerRole === 'admin';

  if (!orgId) {
    return (
      <section
        className="organization-settings-panel"
        data-testid="organization-settings-panel"
        data-component="OrganizationSettingsPanel"
      >
        <PanelHeader />
        <p className="m-0 text-sm text-[var(--nim-text-muted)]">Choose an organization.</p>
      </section>
    );
  }

  return (
    <section
      className="organization-settings-panel"
      data-testid="organization-settings-panel"
      data-component="OrganizationSettingsPanel"
    >
      <PanelHeader />
      <OrganizationIdentitySection
        orgId={orgId}
        orgName={orgName}
        ownerEmail={ownerEmail}
        canAdminister={canAdminister}
        onRenamed={onRenamed}
      />
      <MessagingSettingsSection orgId={orgId} canAdminister={canAdminister} />
      <div className="organization-settings-security mt-8 border-t border-[var(--nim-border)] pt-6">
        <OrganizationSecurityPanel orgId={orgId} />
      </div>
    </section>
  );
}

function PanelHeader() {
  return (
    <header className="mb-5 border-b border-[var(--nim-border)] pb-4">
      <h2 className="m-0 text-xl font-semibold">Settings</h2>
      <p className="m-0 mt-1 text-sm text-[var(--nim-text-muted)]">
        Organization-wide configuration and security status.
      </p>
    </header>
  );
}

function OrganizationIdentitySection({
  orgId,
  orgName,
  ownerEmail,
  canAdminister,
  onRenamed,
}: {
  orgId: string;
  orgName?: string | null;
  ownerEmail?: string | null;
  canAdminister: boolean;
  onRenamed?: (name: string) => void;
}) {
  const [name, setName] = useState(orgName?.trim() || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedName = name.trim();
  const unchanged = normalizedName === (orgName?.trim() || '');

  useEffect(() => {
    setName(orgName?.trim() || '');
    setError(null);
  }, [orgId, orgName]);

  const save = async () => {
    if (!normalizedName || unchanged || saving) return;
    setSaving(true);
    setError(null);
    try {
      const organization = await renameOrganization(orgId, normalizedName);
      onRenamed?.(organization.name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="organization-settings-identity mb-6" data-testid="organization-settings-identity">
      <h3 className="m-0 mb-1 text-sm font-semibold text-[var(--nim-text)]">Organization</h3>
      {canAdminister ? (
        <div className="flex max-w-[520px] gap-2">
          <input
            type="text"
            className="min-w-0 flex-1 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-2 py-1.5 text-[13px] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]"
            data-testid="organization-settings-name"
            value={name}
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="button"
            className="rounded-md bg-[var(--nim-primary)] px-3 py-1.5 text-[12px] text-[var(--nim-on-primary)] disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="organization-settings-name-save"
            disabled={!normalizedName || unchanged || saving}
            onClick={() => { void save(); }}
          >
            {saving ? 'Saving…' : 'Rename'}
          </button>
        </div>
      ) : (
        <p className="m-0 select-text text-sm text-[var(--nim-text)]" data-testid="organization-settings-name">
          {orgName?.trim() || 'Unnamed organization'}
        </p>
      )}
      {error && (
        <p className="m-0 mt-1 text-xs text-[var(--nim-error)]" data-testid="organization-settings-name-error">
          {error}
        </p>
      )}
      {ownerEmail && (
        <p
          className="organization-settings-owner m-0 mt-1.5 select-text text-xs text-[var(--nim-text-muted)]"
          data-testid="organization-settings-owner"
        >
          Owned by {ownerEmail}
        </p>
      )}
    </section>
  );
}

function MessagingSettingsSection({
  orgId,
  canAdminister,
}: {
  orgId: string;
  canAdminister: boolean;
}) {
  const settings = useAtomValue(orgSettingsAtomFamily(orgId));
  const loadState = useAtomValue(orgSettingsLoadStateAtomFamily(orgId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The panel is reachable without ever having opened a room, so it hydrates
  // its own org rather than assuming the sidebar already did.
  useEffect(() => {
    void refreshOrgSettings(orgId).catch(() => undefined);
  }, [orgId]);

  const save = async (patch: OrgSettingsPatch) => {
    if (!canAdminister || saving) return;
    // The server's PUT replaces the whole object, so the current settings are
    // sent with the one changed field folded in.
    const next: OrgSettings = applyOrgSettingsPatch(settings, patch);
    setSaving(true);
    setError(null);
    try {
      // The broadcast from main writes the atom; nothing is set optimistically
      // so a rejected save never leaves the UI claiming a setting it lost.
      await updateOrgSettings({ orgId, settings: next });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const disabled = !canAdminister || saving;

  return (
    <section className="organization-settings-messaging" data-testid="organization-settings-messaging">
      <h3 className="m-0 text-sm font-semibold text-[var(--nim-text)]">Messaging</h3>
      <p className="m-0 mt-1 text-xs text-[var(--nim-text-muted)]">
        Rooms and direct messages can be turned off for organizations that chat elsewhere.
        The Inbox, document comments and tracker comments are unaffected.
      </p>
      {!canAdminister && (
        <p
          className="organization-settings-readonly m-0 mt-2 text-xs text-[var(--nim-text-faint)]"
          data-testid="organization-settings-readonly"
        >
          Only organization owners and admins can change these settings.
        </p>
      )}
      {loadState.status === 'error' && (
        <p className="m-0 mt-2 text-xs text-[var(--nim-error)]" data-testid="organization-settings-load-error">
          Could not load settings: {loadState.error}
        </p>
      )}
      {error && (
        <p className="m-0 mt-2 text-xs text-[var(--nim-error)]" data-testid="organization-settings-save-error">
          {error}
        </p>
      )}

      {/* The toggles are wrapped rather than tooltipped directly: `HelpTooltip`
          clones its child to attach hover handlers, which only reaches a DOM
          element, and `SettingsToggle` forwards neither ref nor handlers. */}
      <div className="organization-settings-toggles mt-2 divide-y divide-[var(--nim-border)]">
        <HelpTooltip testId="organization-settings-rooms-toggle">
          <div>
            <SettingsToggle
              name="Rooms"
              description="Organization rooms, including #general, and the rooms directory."
              checked={settings.messaging.roomsEnabled}
              disabled={disabled}
              testId="organization-settings-rooms-toggle"
              onChange={(checked) => { void save({ messaging: { roomsEnabled: checked } }); }}
            />
          </div>
        </HelpTooltip>
        <HelpTooltip testId="organization-settings-dms-toggle">
          <div>
            <SettingsToggle
              name="Direct messages"
              description="One-to-one and small-group messages between members."
              checked={settings.messaging.dmsEnabled}
              disabled={disabled}
              testId="organization-settings-dms-toggle"
              onChange={(checked) => { void save({ messaging: { dmsEnabled: checked } }); }}
            />
          </div>
        </HelpTooltip>
      </div>

      <div className="organization-settings-room-creation mt-4">
        <label
          className="mb-1 block text-sm font-medium text-[var(--nim-text)]"
          htmlFor="organization-settings-room-creation"
        >
          Who can create rooms
        </label>
        <HelpTooltip testId="organization-settings-room-creation">
          <select
            id="organization-settings-room-creation"
            className="w-full max-w-[280px] rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-2 py-1.5 text-[13px] text-[var(--nim-text)] disabled:opacity-60"
            data-testid="organization-settings-room-creation"
            value={settings.messaging.roomCreation}
            disabled={disabled || !settings.messaging.roomsEnabled}
            onChange={(event) => {
              const roomCreation = event.target.value === 'admins' ? 'admins' : 'members';
              void save({ messaging: { roomCreation } });
            }}
          >
            <option value="members">Any member</option>
            <option value="admins">Organization admins only</option>
          </select>
        </HelpTooltip>
      </div>
    </section>
  );
}
