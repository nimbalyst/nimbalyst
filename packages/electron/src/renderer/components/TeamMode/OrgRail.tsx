import React from 'react';
import { useAtomValue } from 'jotai';

import { teamInboxSnapshotAtom } from '../../store/atoms/teamInbox';
import type { OrgChoice } from './defaultOrg';
import { activeOrganizations } from './defaultOrg';
import { inboxUnreadCount } from './orgSidebarViewModel';
import { isOrgConnectionReady } from './orgWindowRailViewModel';

function orgInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'O';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part.slice(0, 1).toUpperCase()).join('');
}

/**
 * The organization switcher, and only that. The signed-in identity is not here:
 * it is pinned to the bottom of the OrgSidebar in every layout, because identity
 * is per-organization while this rail is the window-level switcher.
 *
 * Memoized and reading the inbox snapshot itself, so navigating inside one
 * organization leaves it alone entirely — it only repaints when unread counts or
 * connection state actually move.
 */
export const OrgRail = React.memo(function OrgRail({
  organizations,
  selectedOrgId,
  onSelectOrganization,
}: {
  organizations: OrgChoice[];
  selectedOrgId: string;
  onSelectOrganization: (orgId: string) => void;
}) {
  const inboxSnapshot = useAtomValue(teamInboxSnapshotAtom);
  const choices = activeOrganizations(organizations);
  if (choices.length < 2) return null;

  return (
    <aside
      className="org-rail org-window-drag-region flex w-16 shrink-0 flex-col items-center border-r border-[var(--nim-border)] bg-[var(--nim-bg-tertiary)]"
      data-testid="org-rail"
      data-component="OrgRail"
      data-window-drag-region="true"
      aria-label="Organizations"
    >
      {/* No traffic-light spacer here any more: the window title bar above the
          rail carries the lights, so the rail starts at its own top edge. */}
      <div className="org-rail-list flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto py-2" data-testid="org-rail-list">
        {choices.map((organization) => {
          const selected = organization.orgId === selectedOrgId;
          const ready = isOrgConnectionReady(inboxSnapshot, organization.orgId);
          const unread = inboxUnreadCount(inboxSnapshot, organization.orgId);
          return (
            <button
              key={organization.orgId}
              type="button"
              className={`org-rail-item org-window-no-drag relative flex h-11 w-full items-center justify-center ${
                selected ? 'org-rail-item-selected' : ''
              }`}
              data-testid="org-rail-item"
              data-org-id={organization.orgId}
              data-selected={selected ? 'true' : 'false'}
              data-ready={ready ? 'true' : 'false'}
              aria-label={organization.name}
              aria-current={selected ? 'page' : undefined}
              title={organization.name}
              onClick={() => {
                if (!selected) onSelectOrganization(organization.orgId);
              }}
            >
              {selected && (
                <span className="org-rail-selected-indicator absolute left-0 h-7 w-0.5 rounded-r bg-[var(--nim-text)]" />
              )}
              <span
                className={`org-rail-avatar flex size-9 items-center justify-center rounded-lg border text-xs font-semibold ${
                  selected
                    ? 'border-[color-mix(in_srgb,var(--nim-text)_54%,transparent)] bg-[var(--nim-primary)] text-[var(--nim-on-primary)]'
                    : 'border-transparent bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] hover:border-[var(--nim-border-focus)]'
                } ${ready ? '' : 'grayscale opacity-60'}`}
              >
                {orgInitials(organization.name)}
              </span>
              {unread > 0 && (
                <span
                  className="org-rail-unread absolute right-1 top-0 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-[var(--nim-bg-tertiary)] bg-[var(--nim-error)] px-1 text-[9px] font-semibold leading-none text-white"
                  aria-label={`${unread} unread`}
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
              {!ready && (
                <span
                  className="org-rail-connection-dot absolute bottom-1 right-2 size-2.5 rounded-full border-2 border-[var(--nim-bg-tertiary)] bg-[var(--nim-warning)]"
                  aria-label="Reconnecting"
                />
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
});
