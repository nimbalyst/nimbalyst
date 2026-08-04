import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
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
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import type { ConversationMembership } from '@nimbalyst/collab-protocol';

import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';
import {
  archiveDirectoryConversation,
  setDirectoryAgentPosting,
  setDirectoryConversationMembership,
  updateDirectoryConversation,
} from '../../services/conversationDirectoryClient';
import {
  OrgDialog,
  OrgDialogField,
  OrgDialogPrimaryButton,
  OrgDialogSecondaryButton,
  ORG_DIALOG_INPUT_CLASS,
} from './OrgDialog';
import { GENERAL_CONVERSATION_ID } from './orgSidebarViewModel';
import {
  buildRoomMemberRows,
  buildRoomSettingsUpdate,
  type RoomMemberRow,
} from './roomManagementViewModel';
import type { OrgRosterMember } from './useOrgRoster';

export type RoomSettingsSection = 'details' | 'members';

/**
 * Room settings: rename and topic, membership, agent posting, archive.
 *
 * The active room's member endpoint hydrates the membership section on open;
 * mutation responses replace that list immediately so role changes do not wait
 * for another round trip.
 */
export function RoomSettingsDialog({
  orgId,
  entry,
  members,
  viewerUserId,
  memberships: fetchedMemberships = null,
  onMembershipsChange,
  initialSection = 'details',
  onClose,
  onArchived,
}: {
  orgId: string;
  entry: ConversationDirectoryEntry;
  members: readonly OrgRosterMember[];
  viewerUserId: string | null;
  memberships?: readonly ConversationMembership[] | null;
  onMembershipsChange?: (
    memberships: readonly ConversationMembership[],
  ) => void;
  initialSection?: RoomSettingsSection;
  onClose: () => void;
  onArchived: () => void;
}) {
  const [section, setSection] = useState<RoomSettingsSection>(initialSection);
  const [name, setName] = useState(entry.title ?? '');
  const [topic, setTopic] = useState(entry.topic ?? '');
  const [memberships, setMemberships] = useState<ConversationMembership[] | null>(
    fetchedMemberships ? [...fetchedMemberships] : null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  // A different room in the same open dialog (the window keeps one mounted per
  // selection) must not inherit the previous room's draft. Keyed on the id
  // alone: a membership change or a directory refresh re-renders this dialog
  // with a fresh descriptor, and re-seeding on those threw away an unsaved
  // rename mid-edit.
  useEffect(() => {
    setName(entry.title ?? '');
    setTopic(entry.topic ?? '');
    setConfirmArchive(false);
    // Intentionally only the id: reacting to title/topic is the draft loss.
  }, [entry.id]);

  useEffect(() => {
    setMemberships(fetchedMemberships ? [...fetchedMemberships] : null);
  }, [entry.id, fetchedMemberships]);

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }, []);

  const update = buildRoomSettingsUpdate({ name, topic }, entry);
  const rows = useMemo(
    () => buildRoomMemberRows(members, memberships, viewerUserId),
    [members, memberships, viewerUserId],
  );

  const saveDetails = () => run('details', async () => {
    if (update.error || !update.input) return;
    await updateDirectoryConversation({
      orgId,
      conversationId: entry.id,
      input: update.input,
    });
    setNotice('Room details saved.');
  });

  const setMembership = (
    userId: string,
    active: boolean,
    role?: ConversationMembership['role'],
  ) => run(`member-${userId}`, async () => {
    const result = await setDirectoryConversationMembership({
      orgId,
      conversationId: entry.id,
      userId,
      active,
      role,
    });
    setMemberships(result.memberships);
    onMembershipsChange?.(result.memberships);
  });

  const toggleAgentPosting = () => run('agent-posting', async () => {
    await setDirectoryAgentPosting({
      orgId,
      conversationId: entry.id,
      enabled: !entry.agentPostingEnabled,
    });
  });

  const archive = () => run('archive', async () => {
    await archiveDirectoryConversation({ orgId, conversationId: entry.id });
    onArchived();
  });

  return (
    <OrgDialog
      title="Room settings"
      description={`#${entry.title?.trim() || entry.id}`}
      testId="room-settings-dialog"
      width="w-[520px]"
      error={error}
      onClose={onClose}
      footer={(
        <>
          <OrgDialogSecondaryButton testId="room-settings-close" onClick={onClose}>
            Done
          </OrgDialogSecondaryButton>
          {section === 'details' && (
            <OrgDialogPrimaryButton
              testId="room-settings-save"
              disabled={!update.input || busy === 'details'}
              onClick={saveDetails}
            >
              {busy === 'details' ? 'Saving…' : 'Save changes'}
            </OrgDialogPrimaryButton>
          )}
        </>
      )}
    >
      <div className="room-settings-tabs mb-4 flex gap-1 border-b border-[var(--nim-border)]">
        {(['details', 'members'] as const).map((id) => (
          <button
            key={id}
            type="button"
            className={`room-settings-tab -mb-px border-b-2 px-3 py-1.5 text-[12px] ${
              section === id
                ? 'border-[var(--nim-primary)] font-medium text-[var(--nim-text)]'
                : 'border-transparent text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]'
            }`}
            data-testid={`room-settings-tab-${id}`}
            onClick={() => setSection(id)}
          >
            {id === 'details' ? 'Details' : 'Members'}
          </button>
        ))}
      </div>

      {notice && (
        <p
          className="room-settings-notice m-0 mb-3 text-[11px] text-[var(--nim-success)]"
          data-testid="room-settings-notice"
          role="status"
        >
          {notice}
        </p>
      )}

      {section === 'details' && (
        <>
          <OrgDialogField label="Name" error={update.error}>
            <input
              type="text"
              className={ORG_DIALOG_INPUT_CLASS}
              data-testid="room-settings-name"
              value={name}
              onChange={(event) => { setName(event.target.value); setNotice(null); }}
            />
          </OrgDialogField>

          <OrgDialogField
            label="Topic"
            hint="Shown under the room name. Clearing it removes the topic."
          >
            <input
              type="text"
              className={ORG_DIALOG_INPUT_CLASS}
              data-testid="room-settings-topic"
              value={topic}
              onChange={(event) => { setTopic(event.target.value); setNotice(null); }}
            />
          </OrgDialogField>

          <label className="room-settings-agent-posting mb-4 flex cursor-pointer items-start gap-2.5 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3">
            <input
              type="checkbox"
              className="mt-0.5"
              data-testid="room-settings-agent-posting"
              checked={entry.agentPostingEnabled}
              disabled={busy === 'agent-posting'}
              onChange={toggleAgentPosting}
            />
            <span className="min-w-0">
              <span className="block text-[12px] font-medium text-[var(--nim-text)]">
                Allow agents to post
              </span>
              <span className="block text-[11px] text-[var(--nim-text-faint)]">
                Mentioned agents can reply in this room.
              </span>
            </span>
          </label>

          <div className="room-settings-archive rounded-md border border-[var(--nim-border)] p-3">
            <p className="m-0 text-[12px] font-medium text-[var(--nim-text)]">Archive room</p>
            <p className="m-0 mt-0.5 text-[11px] text-[var(--nim-text-faint)]">
              The room leaves everyone&apos;s sidebar and stops accepting messages. Its history stays
              readable from the rooms directory.
            </p>
            {/* Every member is auto-joined to the general room and the server
                rejects archiving it; offering the button only to answer with a
                409 is a dead end, so the reason is stated instead. */}
            {entry.id === GENERAL_CONVERSATION_ID
              ? (
                <p
                  className="m-0 mt-2 text-[11px] text-[var(--nim-text-muted)]"
                  data-testid="room-settings-archive-blocked"
                >
                  The general room is the organization&apos;s default room and cannot be archived.
                </p>
              )
              : entry.archivedAt !== undefined
              ? (
                <p
                  className="m-0 mt-2 text-[11px] text-[var(--nim-text-muted)]"
                  data-testid="room-settings-already-archived"
                >
                  This room is already archived.
                </p>
              )
              : confirmArchive
                ? (
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      className="room-settings-archive-confirm rounded-md bg-[var(--nim-error)] px-2.5 py-1 text-[12px] text-white disabled:opacity-60"
                      data-testid="room-settings-archive-confirm"
                      disabled={busy === 'archive'}
                      onClick={archive}
                    >
                      {busy === 'archive' ? 'Archiving…' : 'Archive room'}
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-[var(--nim-border)] px-2.5 py-1 text-[12px] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)]"
                      onClick={() => setConfirmArchive(false)}
                    >
                      Cancel
                    </button>
                  </div>
                )
                : (
                  <button
                    type="button"
                    className="room-settings-archive-start mt-2 rounded-md border border-[var(--nim-border)] px-2.5 py-1 text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                    data-testid="room-settings-archive"
                    onClick={() => setConfirmArchive(true)}
                  >
                    Archive room
                  </button>
                )}
          </div>
        </>
      )}

      {section === 'members' && (
        <div className="room-settings-members" data-testid="room-settings-members">
          {memberships === null && (
            <p
              className="m-0 mb-2 text-[11px] text-[var(--nim-text-muted)]"
              data-testid="room-settings-members-unknown"
            >
              Loading current room roles…
            </p>
          )}
          {entry.visibility === 'public' && (
            <p className="m-0 mb-2 text-[11px] text-[var(--nim-text-faint)]">
              Everyone in the organization can read this public room. Membership here only changes
              who follows it and who can manage it.
            </p>
          )}
          <div className="room-settings-member-list rounded-md border border-[var(--nim-border)]">
            {rows.length === 0 && (
              <p className="m-0 px-3 py-2 text-[12px] text-[var(--nim-text-muted)]">
                No members in this organization yet.
              </p>
            )}
            {rows.map((row) => (
              <MemberRow
                key={row.memberId}
                row={row}
                membershipsKnown={memberships !== null}
                busy={busy === `member-${row.memberId}`}
                onSetMembership={setMembership}
              />
            ))}
          </div>
        </div>
      )}
    </OrgDialog>
  );
}

function MemberRow({
  row,
  membershipsKnown,
  busy,
  onSetMembership,
}: {
  row: RoomMemberRow;
  membershipsKnown: boolean;
  busy: boolean;
  onSetMembership: (
    userId: string,
    active: boolean,
    role?: ConversationMembership['role'],
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useDismiss(context),
    useRole(context, { role: 'menu' }),
  ]);

  const items: Array<{ id: string; label: string; icon: string; run: () => void }> = [];
  if (!membershipsKnown || row.roomRole === null) {
    items.push({
      id: 'add',
      label: 'Add to room',
      icon: 'person_add',
      run: () => onSetMembership(row.memberId, true, 'member'),
    });
  }
  if (row.roomRole !== 'roomAdmin') {
    items.push({
      id: 'promote',
      label: 'Make room admin',
      icon: 'shield_person',
      run: () => onSetMembership(row.memberId, true, 'roomAdmin'),
    });
  }
  if (row.roomRole === 'roomAdmin') {
    items.push({
      id: 'demote',
      label: 'Remove room admin',
      icon: 'person',
      run: () => onSetMembership(row.memberId, true, 'member'),
    });
  }
  if (!membershipsKnown || row.roomRole !== null) {
    items.push({
      id: 'remove',
      label: 'Remove from room',
      icon: 'person_remove',
      run: () => onSetMembership(row.memberId, false),
    });
  }

  const roleLabel = !membershipsKnown
    ? ''
    : row.roomRole === 'roomAdmin'
      ? 'Room admin'
      : row.roomRole === 'member'
        ? 'Member'
        : 'Not in room';

  return (
    <div
      className="room-settings-member-row flex items-center gap-2.5 px-3 py-1.5"
      data-testid={`room-settings-member-${row.memberId}`}
      data-room-role={row.roomRole ?? 'none'}
    >
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--nim-text)]">
        {row.label}
        {row.isViewer && <span className="ml-1 text-[var(--nim-text-faint)]">(you)</span>}
      </span>
      {roleLabel && (
        <span className="shrink-0 text-[11px] text-[var(--nim-text-faint)]">{roleLabel}</span>
      )}
      <button
        ref={refs.setReference}
        type="button"
        className="room-settings-member-actions flex size-6 shrink-0 items-center justify-center rounded text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] disabled:cursor-not-allowed"
        data-testid={`room-settings-member-actions-${row.memberId}`}
        aria-label={`Room membership for ${row.label}`}
        disabled={busy}
        {...getReferenceProps({ onClick: () => setOpen((value) => !value) })}
      >
        <MaterialSymbol icon={busy ? 'hourglass_empty' : 'more_horiz'} size={15} />
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="room-settings-member-menu z-[10001] w-[190px] rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-1 shadow-lg"
            data-testid={`room-settings-member-menu-${row.memberId}`}
            {...getFloatingProps()}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                data-testid={`room-settings-member-${item.id}-${row.memberId}`}
                onClick={() => { item.run(); setOpen(false); }}
              >
                <MaterialSymbol icon={item.icon} size={14} />
                {item.label}
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
