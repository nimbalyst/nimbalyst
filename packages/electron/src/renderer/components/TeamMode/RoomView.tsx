import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { useAtom, useAtomValue, useStore } from 'jotai';

import { CommentThread } from '../Comments/CommentThread';
import { createConversationCommentAdapter } from '../Comments/ConversationCommentAdapter';
import type { AttachmentComposerHost } from '../Comments/commentTypes';
import { uploadConversationAttachment } from '../../services/conversationAttachments';
import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';
import { setConversationNotificationLevel } from '../../services/conversationClient';
import { conversationNotificationLevelAtomFamily } from '../../store/atoms/conversations';
import { settingAtom } from '../../store/atoms/settingAtomFamily';
import { markConversationNotificationLevelChanged } from '../../store/listeners/conversationDirectoryListeners';
import type { OrgRosterMember } from './useOrgRoster';
import { HelpTooltip } from '../../help';
import {
  ROOM_NOTIFICATION_LEVELS,
  buildRoomHeader,
  roomEmptyLabel,
  toCommentCapabilities,
  toMentionDirectory,
  type RoomNotificationLevel,
} from './roomViewModel';

/**
 * A room or direct message as the window's main content.
 *
 * The message list, composer, mentions, reactions and resource pills are the
 * shared comments stack — the same components document discussions and tracker
 * comments mount. Only the adapter differs, so a fix in one surface is a fix in
 * all of them. Backward paging is the thread's own `nextCursor` control.
 */
export function RoomView({
  orgId,
  entry,
  viewerUserId,
  members,
  memberCount,
  dmParticipants,
  notificationLevel,
  notice,
  onSetNotificationLevel,
  onOpenRoomSettings,
  onInviteMembers,
  projectWorkspacePath,
  onOpenProject,
}: {
  orgId: string;
  entry: ConversationDirectoryEntry;
  viewerUserId: string | null;
  members: readonly OrgRosterMember[];
  /** Rendered only when the membership of this conversation is knowable. */
  memberCount?: number;
  dmParticipants?: readonly string[];
  notificationLevel?: RoomNotificationLevel;
  /**
   * Rendered between the room header and the thread — the invited-member
   * welcome card in `#general`. Room-width, and it scrolls away with nothing:
   * the thread keeps the remaining height.
   */
  notice?: React.ReactNode;
  /**
   * Optional host override. Without one, the view persists through the typed
   * conversation client and keeps the returned level in its atom family.
   */
  onSetNotificationLevel?: (level: RoomNotificationLevel) => void;
  /** Absent for a direct message: there is nothing there to manage. */
  onOpenRoomSettings?: () => void;
  onInviteMembers?: () => void;
  projectWorkspacePath?: string | null;
  onOpenProject?: (workspacePath: string) => void;
}) {
  const targetStore = useStore();
  // The org window's message-display preference. Read here rather than inside
  // the thread so document comments, which mount the same thread, keep the
  // comfortable layout regardless of what this window is set to.
  const density = useAtomValue(settingAtom('team.messages.density'));
  const [storedNotificationLevel, setStoredNotificationLevel] = useAtom(
    conversationNotificationLevelAtomFamily({
      orgId,
      conversationId: entry.id,
    }),
  );
  const [notificationSaving, setNotificationSaving] = useState(false);
  // The view is no longer keyed by conversation, so an in-flight save from the
  // room being left must not arrive as a disabled control in the room entered.
  useEffect(() => { setNotificationSaving(false); }, [entry.id]);
  const effectiveNotificationLevel =
    notificationLevel ?? storedNotificationLevel;
  const setNotificationLevel = useCallback(
    (level: RoomNotificationLevel) => {
      if (onSetNotificationLevel) {
        onSetNotificationLevel(level);
        return;
      }
      if (notificationSaving) return;
      // Stamped before the round trip: a directory response already in flight
      // carries the pre-change level and must not undo the user's pick.
      markConversationNotificationLevelChanged({
        orgId,
        conversationId: entry.id,
      });
      setNotificationSaving(true);
      void setConversationNotificationLevel({
        orgId,
        conversationId: entry.id,
        notificationLevel: level,
      }).then((subscription) => {
        setStoredNotificationLevel(subscription.notificationLevel);
      }).catch((error) => {
        console.error(
          `[Conversation] Failed to update notifications for ${entry.id}:`,
          error,
        );
      }).finally(() => {
        setNotificationSaving(false);
      });
    },
    [
      entry.id,
      notificationSaving,
      onSetNotificationLevel,
      orgId,
      setStoredNotificationLevel,
    ],
  );
  const capabilities = useMemo(
    () => toCommentCapabilities(entry.capabilities),
    [entry.capabilities],
  );
  const header = useMemo(
    () => buildRoomHeader(entry, {
      dmParticipants,
      memberNames: Object.fromEntries(
        members.map((member) => [
          member.memberId,
          member.name?.trim() || member.email || member.memberId,
        ]),
      ),
      viewerUserId: viewerUserId ?? undefined,
    }),
    [dmParticipants, entry, members, viewerUserId],
  );
  const directory = useMemo(
    () => toMentionDirectory(members, viewerUserId ?? undefined),
    [members, viewerUserId],
  );
  const viewerActor = useMemo(() => ({
    kind: 'user' as const,
    userId: viewerUserId ?? '',
    onBehalfOfUserId: viewerUserId ?? '',
  }), [viewerUserId]);
  const adapter = useMemo(
    () => createConversationCommentAdapter({
      orgId,
      conversationId: entry.id,
      sourceKind: entry.kind === 'dm' ? 'dmMessage' : 'roomMessage',
      viewerActor,
      capabilities,
      store: targetStore,
    }),
    [capabilities, entry.id, entry.kind, orgId, targetStore, viewerActor],
  );

  /**
   * Authorize this window for the conversation's encrypted attachments while
   * it is open: uploads and every `collab-asset://` read are gated on it.
   * Registration is refcounted in main and released on unmount, so switching
   * rooms does not accumulate authorizations.
   */
  useEffect(() => {
    const api = window.electronAPI?.conversation;
    if (!api?.registerAssets) return;
    const conversationId = entry.id;
    void api.registerAssets({ orgId, conversationId }).catch((error: unknown) => {
      console.error(
        `[Conversation] Failed to authorize attachments for ${conversationId}:`,
        error,
      );
    });
    return () => {
      void api.unregisterAssets?.({ conversationId }).catch(() => undefined);
    };
  }, [entry.id, orgId]);

  const attachmentHost = useMemo<AttachmentComposerHost>(() => ({
    upload: (file) =>
      uploadConversationAttachment({ orgId, conversationId: entry.id }, file),
  }), [entry.id, orgId]);

  // Posting attributes to a team member id. Without one resolved the thread
  // would create messages attributed to an empty actor, so the surface waits.
  if (!viewerUserId) {
    return (
      <section
        className="org-room-view org-room-view-resolving flex h-full items-center justify-center text-sm text-[var(--nim-text-muted)]"
        data-testid="org-room-view"
        data-component="RoomView"
      >
        Loading conversation…
      </section>
    );
  }

  return (
    <section
      className="org-room-view flex h-full min-h-0 flex-col"
      data-testid="org-room-view"
      data-component="RoomView"
      data-conversation-id={entry.id}
    >
      <header
        className="org-room-header org-window-drag-region flex shrink-0 items-start gap-3 border-b border-[var(--nim-border)] px-5 py-3"
        data-window-drag-region="true"
      >
        <div className="org-window-no-drag min-w-0 flex-1 select-text">
          <h2 className="org-room-title m-0 flex items-center gap-1.5 truncate text-[15px] font-semibold text-[var(--nim-text)]">
            {header.prefix && (
              <span className="text-[var(--nim-text-faint)]">{header.prefix}</span>
            )}
            {header.title}
            {header.isPrivate && header.prefix && (
              <MaterialSymbol icon="lock" size={13} className="text-[var(--nim-text-faint)]" />
            )}
            {header.archived && (
              <span className="org-room-archived rounded bg-[var(--nim-bg-tertiary)] px-1.5 text-[10px] uppercase tracking-wide text-[var(--nim-text-faint)]">
                Archived
              </span>
            )}
          </h2>
          {header.topic && (
            <p className="org-room-topic m-0 mt-0.5 truncate text-[12px] text-[var(--nim-text-muted)]">
              {header.topic}
            </p>
          )}
        </div>

        {memberCount !== undefined && (
          <span
            className="org-room-member-count flex shrink-0 items-center gap-1 text-[12px] text-[var(--nim-text-muted)]"
            data-testid="org-room-member-count"
          >
            <MaterialSymbol icon="group" size={14} />
            {memberCount} {memberCount === 1 ? 'member' : 'members'}
          </span>
        )}

        {projectWorkspacePath && onOpenProject && (
          <button
            type="button"
            className="org-room-open-project org-window-no-drag flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--nim-border)] px-2 py-1 text-[12px] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
            data-testid="org-room-open-project"
            onClick={() => onOpenProject(projectWorkspacePath)}
          >
            <MaterialSymbol icon="folder_open" size={14} />
            Open project
          </button>
        )}

        <NotificationLevelMenu
          level={effectiveNotificationLevel}
          onSelect={notificationSaving ? undefined : setNotificationLevel}
        />
        <RoomActionsMenu
          canManage={capabilities.manageRoom}
          onOpenRoomSettings={onOpenRoomSettings}
          onInviteMembers={onInviteMembers}
        />
      </header>

      {notice && (
        <div className="org-room-notice shrink-0" data-testid="org-room-notice">
          {notice}
        </div>
      )}

      <div className="org-room-thread min-h-0 flex-1" data-testid="org-room-thread">
        <CommentThread
          // The thread merges every page it loads into the state it already
          // holds and never clears it, so switching rooms in a surviving
          // instance would interleave both rooms' messages and carry the
          // composer draft, reply target and in-flight sends across. Keying it
          // by conversation makes a room switch a remount.
          key={entry.id}
          adapter={adapter}
          attachmentHost={attachmentHost}
          capabilities={capabilities}
          context={{
            conversationId: entry.id,
            conversationTitle: header.title,
            agentPostingEnabled: entry.agentPostingEnabled,
            attachedAgentSessionIds: [],
            archived: header.archived,
            surfaceLabel: `${header.prefix}${header.title}`,
          }}
          directory={directory}
          orgId={orgId}
          viewerUserId={viewerUserId}
          viewerActor={viewerActor}
          emptyLabel={roomEmptyLabel(header, capabilities.comment)}
          // Opening a conversation means you are about to write in it. This is
          // also what closes the Cmd+K loop: pick a destination, start typing,
          // press Enter — no pointer anywhere in the flow. The thread is keyed
          // by conversation, so every room switch is a fresh mount and a fresh
          // focus.
          autoFocusComposer
          density={density}
        />
      </div>
    </section>
  );
}

function NotificationLevelMenu({
  level,
  onSelect,
}: {
  level: RoomNotificationLevel;
  onSelect?: (level: RoomNotificationLevel) => void;
}) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useDismiss(context),
    useRole(context, { role: 'menu' }),
  ]);
  const active = ROOM_NOTIFICATION_LEVELS.find((entry) => entry.id === level)
    ?? ROOM_NOTIFICATION_LEVELS[0];

  return (
    <>
      <HelpTooltip testId="org-room-notifications">
        <button
          ref={refs.setReference}
          type="button"
          className="org-room-notifications org-window-no-drag flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] disabled:cursor-not-allowed disabled:text-[var(--nim-text-disabled)]"
          data-testid="org-room-notifications"
          aria-label={`Notifications: ${active.label}`}
          title={onSelect
            ? `Notification level: ${active.label}`
            : 'Updating notification level'}
          disabled={!onSelect}
          {...getReferenceProps({ onClick: () => setOpen((value) => !value) })}
        >
          <MaterialSymbol icon={active.icon} size={16} />
        </button>
      </HelpTooltip>
      {open && onSelect && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="org-room-notifications-menu z-[1000] w-[240px] rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-1 shadow-lg"
            data-testid="org-room-notifications-menu"
            {...getFloatingProps()}
          >
            {ROOM_NOTIFICATION_LEVELS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-[var(--nim-bg-hover)] ${
                  entry.id === level ? 'text-[var(--nim-text)]' : 'text-[var(--nim-text-muted)]'
                }`}
                onClick={() => { onSelect(entry.id); setOpen(false); }}
              >
                <MaterialSymbol icon={entry.icon} size={14} className="mt-px shrink-0" />
                <span className="min-w-0">
                  <span className="block font-medium">{entry.label}</span>
                  <span className="block text-[11px] text-[var(--nim-text-faint)]">{entry.description}</span>
                </span>
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

function RoomActionsMenu({
  canManage,
  onOpenRoomSettings,
  onInviteMembers,
}: {
  canManage: boolean;
  onOpenRoomSettings?: () => void;
  onInviteMembers?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useDismiss(context),
    useRole(context, { role: 'menu' }),
  ]);

  // A direct message has no membership or settings to manage, so the menu is
  // built from the actions the host actually supplied rather than rendering
  // permanently-dead entries.
  const items = (canManage
    ? [
      {
        id: 'invite',
        label: 'Invite members',
        icon: 'person_add',
        action: onInviteMembers,
      },
      {
        id: 'settings',
        label: 'Room settings',
        icon: 'settings',
        action: onOpenRoomSettings,
      },
    ]
    : []
  ).filter((item): item is typeof item & { action: () => void } => !!item.action);
  const available = items.length > 0;

  return (
    <>
      <HelpTooltip testId="org-room-actions" disabled={!available}>
        <button
          ref={refs.setReference}
          type="button"
          className="org-room-actions org-window-no-drag flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] disabled:cursor-not-allowed disabled:text-[var(--nim-text-disabled)]"
          data-testid="org-room-actions"
          aria-label="Room actions"
          title={available ? 'Room actions' : 'You cannot manage this conversation'}
          disabled={!available}
          {...getReferenceProps({ onClick: () => setOpen((value) => !value) })}
        >
          <MaterialSymbol icon="more_horiz" size={16} />
        </button>
      </HelpTooltip>
      {open && available && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="org-room-actions-menu z-[1000] w-[200px] rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-1 shadow-lg"
            data-testid="org-room-actions-menu"
            {...getFloatingProps()}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                onClick={() => { item.action(); setOpen(false); }}
              >
                <MaterialSymbol icon={item.icon} size={14} />
                {item.label}
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
