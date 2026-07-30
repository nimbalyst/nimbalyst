import React, { useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { useAtomValue } from 'jotai';

import { HelpTooltip } from '../../help';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import type { OrgSidebarItem, OrgSidebarModel } from './orgSidebarViewModel';
import { ORG_ADMIN_TABS } from './orgSidebarViewModel';
import type { OrgWindowRoute } from './orgWindowState';
import {
  DIRECTORY_ROUTE,
  INBOX_ROUTE,
  adminRoute,
  conversationRoute,
  orgWindowRouteKey,
  orgWindowRouteSelectedAtomFamily,
} from './orgWindowState';

/**
 * Every administration panel, in the order they appear inside the Admin group.
 * What one viewer actually sees is `model.adminTabs`, which drops the entries
 * their role may not open.
 */
export const ADMIN_TABS = ORG_ADMIN_TABS;

/**
 * The window's navigation column.
 *
 * Memoized, and deliberately not given the active route: a navigation must not
 * repaint the whole column. Each row subscribes to its own
 * `orgWindowRouteSelectedAtomFamily` entry instead, so moving between two
 * destinations re-renders exactly the two rows whose selection flipped. Keep
 * every prop here stable in the host, or the memo is decorative.
 */
export const OrgSidebar = React.memo(function OrgSidebar({
  model,
  inboxUnread,
  directoryLoading = false,
  directoryError,
  onRetryDirectory,
  onNavigate,
  onCreateRoom,
  onCreateDirectMessage,
  projectsContent,
  bottomContent,
}: {
  model: OrgSidebarModel;
  inboxUnread: number;
  directoryLoading?: boolean;
  /**
   * Set when the last directory read failed. An empty list then means "we do
   * not know", not "there is nothing here" — the empty-state copy would tell a
   * member to create a room the organization may already have.
   */
  directoryError?: string | null;
  onRetryDirectory?: () => void;
  onNavigate: (route: OrgWindowRoute) => void;
  /**
   * Absent when this viewer may not create the kind — the control renders
   * disabled with the reason rather than silently doing nothing when clicked.
   */
  onCreateRoom?: () => void;
  onCreateDirectMessage?: () => void;
  /**
   * The Projects section, scrolling with the rest of the sidebar between the
   * conversation sections and Admin. Passed in rather than built here because
   * it reads main-process project state this component knows nothing about.
   */
  projectsContent?: React.ReactNode;
  /** Pinned footer below the scrolling sections — the signed-in identity. */
  bottomContent?: React.ReactNode;
}) {
  const [adminOpen, setAdminOpen] = useState(true);
  // Presentation gating only: an organization that turned rooms or DMs off
  // loses the sections, and the server rejects the disabled kinds regardless.
  const { gating } = model;

  return (
    <nav
      className="org-sidebar org-window-drag-region flex w-[220px] shrink-0 flex-col overflow-hidden border-r border-[var(--nim-border)]"
      data-testid="org-sidebar"
      data-component="OrgSidebar"
      data-window-drag-region="true"
      aria-label="Organization"
    >
      {/* The scroll container covers the whole nav, and `-webkit-app-region`
          does not inherit, so it declares the drag itself rather than relying
          on the rectangle behind it. */}
      <div className="org-sidebar-scroll org-window-drag-region min-h-0 flex-1 overflow-y-auto p-3">
        <SidebarRow
          className="org-inbox-item"
          testId="team-tab-inbox"
          icon="inbox"
          label="Inbox"
          badge={inboxUnread}
          route={INBOX_ROUTE}
          onNavigate={onNavigate}
        />

      {gating.roomsVisible && (
        <>
          {/* The directory used to have its own row under the list. It is a
              rare, one-off action, so it lives in the section's + menu next to
              the create it belongs with rather than costing a permanent row. */}
          <SidebarSectionHeader
            title="Rooms"
            addLabel="Room actions"
            testId="org-rooms-section"
            menuItems={[
              {
                testId: 'org-create-room',
                label: 'New room',
                icon: 'add',
                onSelect: gating.canCreateRoom ? onCreateRoom : undefined,
                disabledLabel: 'Only organization admins can create rooms',
              },
              {
                testId: 'org-browse-rooms',
                label: 'Browse rooms',
                icon: 'search',
                // The menu only exists while it is open, so reading the route
                // here costs nothing between openings.
                routeKey: 'directory',
                onSelect: () => onNavigate(DIRECTORY_ROUTE),
              },
            ]}
          />
          {model.rooms.map((item) => (
            <ConversationRow
              key={item.conversationId}
              item={item}
              onNavigate={onNavigate}
            />
          ))}
          {directoryError
            ? (
              <DirectoryLoadError
                subject="rooms"
                testId="org-rooms-error"
                onRetry={onRetryDirectory}
              />
            )
            : model.rooms.length === 0 && (
              <p
                className="org-rooms-empty m-0 px-3 py-1 text-[11px] leading-relaxed text-[var(--nim-text-faint)]"
                data-testid="org-rooms-empty"
              >
                {directoryLoading
                  ? 'Loading rooms…'
                  : gating.canCreateRoom
                    ? 'No rooms yet. Create one with + or browse the directory.'
                    : 'No rooms yet. Use + to browse the directory for one to join.'}
              </p>
            )}
        </>
      )}

      {gating.dmsVisible && (
        <>
          <SidebarSectionHeader
            title="Direct messages"
            addLabel="New direct message"
            onAdd={onCreateDirectMessage}
            testId="org-dms-section"
          />
          {model.dms.map((item) => (
            <ConversationRow
              key={item.conversationId}
              item={item}
              onNavigate={onNavigate}
            />
          ))}
          {directoryError
            ? (
              <DirectoryLoadError
                subject="direct messages"
                testId="org-dms-error"
                onRetry={onRetryDirectory}
              />
            )
            : model.dms.length === 0 && (
              <p
                className="org-dms-empty m-0 px-3 py-1 text-[11px] leading-relaxed text-[var(--nim-text-faint)]"
                data-testid="org-dms-empty"
              >
                {gating.canCreateDirectMessage
                  ? 'No direct messages yet. Start one with +.'
                  : 'No direct messages yet.'}
              </p>
            )}
        </>
      )}

      {projectsContent}

      <HelpTooltip testId="org-admin-toggle">
        <button
          type="button"
          className="org-admin-toggle org-window-no-drag mt-2 flex items-center gap-1 rounded-md px-3 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)] hover:bg-[var(--nim-bg-hover)]"
          data-testid="org-admin-toggle"
          aria-expanded={adminOpen}
          onClick={() => setAdminOpen((open) => !open)}
        >
          <MaterialSymbol icon={adminOpen ? 'expand_more' : 'chevron_right'} size={14} />
          Admin
        </button>
      </HelpTooltip>
        {adminOpen && model.adminTabs.map((item) => (
          <SidebarRow
            key={item.id}
            className={`org-admin-item org-admin-item-${item.id}`}
            testId={`team-tab-${item.id}`}
            icon={item.icon}
            label={item.label}
            route={adminRoute(item.id)}
            onNavigate={onNavigate}
          />
        ))}
      </div>
      {bottomContent}
    </nav>
  );
});

/**
 * Shown in place of a section's empty state when the directory read failed —
 * a stale main process or a dropped connection must not read as "this
 * organization has no rooms". Retry runs the same refresh the freshness
 * listener does, so a recovered main process fills the sidebar in.
 */
function DirectoryLoadError({
  subject,
  testId,
  onRetry,
}: {
  subject: string;
  testId: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="org-directory-error m-0 flex items-center gap-1.5 px-3 py-1 text-[11px] leading-relaxed text-[var(--nim-text-muted)]"
      data-testid={testId}
      role="status"
    >
      <MaterialSymbol icon="error" size={12} className="shrink-0" />
      <span className="min-w-0 flex-1">Couldn&rsquo;t load {subject}.</span>
      {onRetry && (
        <button
          type="button"
          className="org-directory-retry org-window-no-drag shrink-0 rounded px-1 text-[11px] text-[var(--nim-link)] hover:bg-[var(--nim-bg-hover)]"
          data-testid={`${testId}-retry`}
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}

interface SectionMenuItem {
  testId: string;
  label: string;
  icon: string;
  /** Absent when the viewer may not run the action — the row renders disabled. */
  onSelect?: () => void;
  /** Why the item is disabled, shown in place of the label's tooltip. */
  disabledLabel?: string;
  /** Set when the item is a destination — it then shows its own selection. */
  routeKey?: string;
}

function SidebarSectionHeader({
  title,
  addLabel,
  onAdd,
  disabledLabel,
  testId,
  menuItems,
}: {
  title: string;
  addLabel: string;
  onAdd?: () => void;
  /** Why the add control is disabled, shown as its tooltip. */
  disabledLabel?: string;
  testId: string;
  /**
   * When present the [+] opens this menu instead of running a single action.
   * The trigger stays enabled even if every item is not: a member who may not
   * create rooms can still reach the directory through it.
   */
  menuItems?: SectionMenuItem[];
}) {
  const menu = useFloatingMenu({ placement: 'bottom-end' });
  const hasMenu = Boolean(menuItems && menuItems.length > 0);

  return (
    <div
      className="org-sidebar-section mt-2 flex items-center gap-1 px-3 py-1"
      data-testid={testId}
    >
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">
        {title}
      </span>
      <HelpTooltip testId={`${testId}-add`} disabled={!hasMenu && !onAdd}>
        <button
          type="button"
          ref={hasMenu ? menu.refs.setReference : undefined}
          {...(hasMenu ? menu.getReferenceProps() : {})}
          className="org-sidebar-section-add org-window-no-drag flex size-5 items-center justify-center rounded text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] disabled:cursor-not-allowed disabled:text-[var(--nim-text-disabled)]"
          data-testid={`${testId}-add`}
          title={hasMenu || onAdd ? addLabel : disabledLabel ?? addLabel}
          aria-label={addLabel}
          aria-haspopup={hasMenu ? 'menu' : undefined}
          aria-expanded={hasMenu ? menu.isOpen : undefined}
          disabled={!hasMenu && !onAdd}
          onClick={hasMenu ? () => menu.setIsOpen(!menu.isOpen) : onAdd}
        >
          <MaterialSymbol icon="add" size={14} />
        </button>
      </HelpTooltip>
      {hasMenu && menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            data-testid={`${testId}-menu`}
            className="org-sidebar-section-menu org-window-no-drag z-[10000] min-w-[180px] overflow-y-auto rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] p-1 shadow-[0_4px_12px_rgba(0,0,0,0.18)]"
          >
            {menuItems!.map((item) => (
              <SectionMenuItemButton
                key={item.testId}
                item={item}
                onClose={() => menu.setIsOpen(false)}
              />
            ))}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}

/** A destination inside a section's [+] menu, showing its own selection. */
function SectionMenuItemButton({
  item,
  onClose,
}: {
  item: SectionMenuItem;
  onClose: () => void;
}) {
  // No route key means the item is an action rather than a destination; the
  // empty key matches no route, so it is never marked selected.
  const selected = useAtomValue(
    orgWindowRouteSelectedAtomFamily(item.routeKey ?? ''),
  );
  return (
    <button
      type="button"
      data-testid={item.testId}
      className={`org-sidebar-section-menu-item flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] ${
        item.onSelect
          ? selected
            ? 'bg-[var(--nim-bg-active)] text-[var(--nim-text)]'
            : 'text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
          : 'cursor-not-allowed text-[var(--nim-text-disabled)]'
      }`}
      title={item.onSelect ? undefined : item.disabledLabel}
      aria-current={selected ? 'page' : undefined}
      disabled={!item.onSelect}
      onClick={() => {
        onClose();
        item.onSelect?.();
      }}
    >
      <MaterialSymbol icon={item.icon} size={16} />
      {item.label}
    </button>
  );
}

const ConversationRow = React.memo(function ConversationRow({
  item,
  onNavigate,
}: {
  item: OrgSidebarItem;
  onNavigate: (route: OrgWindowRoute) => void;
}) {
  const room = item.kind === 'orgRoom';
  return (
    <SidebarRow
      className={room ? 'org-room-item' : 'org-dm-item'}
      testId={`${room ? 'org-room-item' : 'org-dm-item'}-${item.conversationId}`}
      icon={room ? (item.isPrivate ? 'lock' : 'tag') : 'person'}
      label={item.label}
      badge={item.unreadCount}
      presenceStatus={!room ? item.presenceStatus : undefined}
      route={conversationRoute(item.conversationId)}
      onNavigate={onNavigate}
    />
  );
});

/**
 * One navigation row, which reads its own selection rather than being told.
 *
 * `orgWindowRouteSelectedAtomFamily` yields a boolean per destination, and a
 * derived boolean that stays false notifies nobody — so a route change wakes
 * only the row being left and the row being entered.
 */
const SidebarRow = React.memo(function SidebarRow({
  className,
  testId,
  icon,
  label,
  badge = 0,
  presenceStatus,
  route,
  onNavigate,
}: {
  className: string;
  testId: string;
  icon: string;
  label: string;
  badge?: number;
  presenceStatus?: 'online' | 'away' | 'offline';
  route: OrgWindowRoute;
  onNavigate: (route: OrgWindowRoute) => void;
}) {
  const selected = useAtomValue(
    orgWindowRouteSelectedAtomFamily(orgWindowRouteKey(route)),
  );
  const onSelect = () => onNavigate(route);
  return (
    <button
      type="button"
      className={`${className} org-window-no-drag flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm ${
        selected
          ? 'bg-[var(--nim-bg-active)] font-medium text-[var(--nim-text)]'
          : badge > 0
            ? 'bg-transparent font-medium text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
            : 'bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]'
      }`}
      data-testid={testId}
      data-unread={badge > 0 ? 'true' : 'false'}
      aria-current={selected ? 'page' : undefined}
      onClick={onSelect}
    >
      <span className="relative flex size-[18px] shrink-0 items-center justify-center">
        <MaterialSymbol icon={icon} size={18} fill={selected} />
        {presenceStatus && (
          <PresenceDot
            status={presenceStatus}
            className="absolute -bottom-0.5 -right-0.5 border-[var(--nim-bg-secondary)]"
          />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge > 0 && (
        <span
          className="org-unread-pill shrink-0 rounded-full bg-[var(--nim-primary)] px-1.5 text-[10px] font-semibold leading-4 text-[var(--nim-on-primary)]"
          aria-label={`${badge} unread`}
        >
          {badge}
        </span>
      )}
    </button>
  );
});

function PresenceDot({
  status,
  className = '',
}: {
  status: 'online' | 'away' | 'offline';
  className?: string;
}) {
  const color = status === 'online'
    ? 'bg-[var(--nim-success)]'
    : status === 'away'
      ? 'bg-[var(--nim-warning)]'
      : 'bg-[var(--nim-text-disabled)]';
  return (
    <span
      className={`org-presence-dot size-2 rounded-full border ${color} ${className}`}
      aria-label={status}
    />
  );
}
