import React, { useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';
import { createDirectoryConversation } from '../../services/conversationDirectoryClient';
import {
  OrgDialog,
  OrgDialogField,
  OrgDialogPrimaryButton,
  OrgDialogSecondaryButton,
  ORG_DIALOG_INPUT_CLASS,
} from './OrgDialog';
import { MemberPicker } from './MemberPicker';
import {
  buildCreateRoomRequest,
  deriveRoomId,
  EMPTY_CREATE_ROOM_FORM,
  type CreateRoomFormState,
} from './roomManagementViewModel';
import type { OrgRosterMember } from './useOrgRoster';

/**
 * Create an organization room.
 *
 * The id is derived from the name and stays derived until the user edits it —
 * rooms are addressed by that slug, and making people type it twice for the
 * common case would be noise. Initial members only apply to private rooms: the
 * server ignores explicit memberships on public ones because every active org
 * member can already read them.
 */
export function CreateRoomDialog({
  orgId,
  members,
  viewerUserId,
  existingConversations,
  onClose,
  onCreated,
}: {
  orgId: string;
  members: readonly OrgRosterMember[];
  viewerUserId: string | null;
  existingConversations: readonly ConversationDirectoryEntry[];
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}) {
  const [form, setForm] = useState<CreateRoomFormState>(EMPTY_CREATE_ROOM_FORM);
  const [idEdited, setIdEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existingIds = useMemo(
    () => existingConversations.map((entry) => entry.id),
    [existingConversations],
  );
  const result = useMemo(
    () => buildCreateRoomRequest(form, { existingIds, viewerUserId }),
    [existingIds, form, viewerUserId],
  );

  const patch = (changes: Partial<CreateRoomFormState>) => {
    setForm((current) => ({ ...current, ...changes }));
  };

  const submit = async () => {
    if (!result.request || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createDirectoryConversation({
        orgId,
        input: result.request,
      });
      onCreated(created.descriptor.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSubmitting(false);
    }
  };

  return (
    <OrgDialog
      title="Create a room"
      description="Rooms are organization-wide conversations. Public rooms are open to everyone; private rooms are limited to the people you add."
      testId="create-room-dialog"
      error={error}
      onClose={onClose}
      footer={(
        <>
          <OrgDialogSecondaryButton testId="create-room-cancel" onClick={onClose}>
            Cancel
          </OrgDialogSecondaryButton>
          <OrgDialogPrimaryButton
            testId="create-room-submit"
            disabled={!result.canSubmit || submitting}
            onClick={() => { void submit(); }}
          >
            {submitting ? 'Creating…' : 'Create room'}
          </OrgDialogPrimaryButton>
        </>
      )}
    >
      <OrgDialogField label="Name" error={result.nameError && form.name ? result.nameError : null}>
        <input
          type="text"
          className={ORG_DIALOG_INPUT_CLASS}
          data-testid="create-room-name"
          value={form.name}
          autoFocus
          placeholder="Design reviews"
          onChange={(event) => {
            const name = event.target.value;
            patch(idEdited ? { name } : { name, id: deriveRoomId(name) });
          }}
        />
      </OrgDialogField>

      <OrgDialogField
        label="Room id"
        hint="How the room is addressed. Letters, numbers, dots, dashes and underscores."
        error={result.idError}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] text-[var(--nim-text-faint)]">#</span>
          <input
            type="text"
            className={ORG_DIALOG_INPUT_CLASS}
            data-testid="create-room-id"
            value={result.resolvedId}
            onChange={(event) => {
              setIdEdited(true);
              patch({ id: event.target.value });
            }}
          />
        </div>
      </OrgDialogField>

      <OrgDialogField label="Topic (optional)" hint="A one-line description shown in the room header.">
        <input
          type="text"
          className={ORG_DIALOG_INPUT_CLASS}
          data-testid="create-room-topic"
          value={form.topic}
          placeholder="What this room is for"
          onChange={(event) => patch({ topic: event.target.value })}
        />
      </OrgDialogField>

      <OrgDialogField label="Visibility">
        <div className="create-room-visibility flex flex-col gap-2">
          <VisibilityOption
            id="public"
            icon="tag"
            label="Public"
            description="Everyone in the organization can find and join this room."
            selected={form.visibility === 'public'}
            onSelect={() => patch({ visibility: 'public' })}
          />
          <VisibilityOption
            id="private"
            icon="lock"
            label="Private"
            description="Only the people you add can see this room."
            selected={form.visibility === 'private'}
            onSelect={() => patch({ visibility: 'private' })}
          />
        </div>
      </OrgDialogField>

      {form.visibility === 'private' && (
        <OrgDialogField
          label="Members"
          hint="You are added as the room admin. Anyone else has to be added here or later."
        >
          <MemberPicker
            testId="create-room-members"
            members={members}
            selectedIds={form.memberIds}
            excludeIds={viewerUserId ? [viewerUserId] : []}
            onToggle={(memberId) => patch({
              memberIds: form.memberIds.includes(memberId)
                ? form.memberIds.filter((id) => id !== memberId)
                : [...form.memberIds, memberId],
            })}
          />
        </OrgDialogField>
      )}

      <label className="create-room-agent-posting flex cursor-pointer items-start gap-2.5 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3">
        <input
          type="checkbox"
          className="mt-0.5"
          data-testid="create-room-agent-posting"
          checked={form.agentPostingEnabled}
          onChange={(event) => patch({ agentPostingEnabled: event.target.checked })}
        />
        <span className="min-w-0">
          <span className="block text-[12px] font-medium text-[var(--nim-text)]">
            Allow agents to post
          </span>
          <span className="block text-[11px] text-[var(--nim-text-faint)]">
            Mentioned agents can reply in this room. You can change this later in room settings.
          </span>
        </span>
      </label>
    </OrgDialog>
  );
}

function VisibilityOption({
  id,
  icon,
  label,
  description,
  selected,
  onSelect,
}: {
  id: string;
  icon: string;
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`create-room-visibility-option flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 ${
        selected
          ? 'border-[var(--nim-primary)] bg-[color-mix(in_srgb,var(--nim-primary)_8%,transparent)]'
          : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]'
      }`}
      data-testid={`create-room-visibility-${id}`}
    >
      <input
        type="radio"
        name="create-room-visibility"
        className="mt-0.5"
        checked={selected}
        onChange={onSelect}
      />
      <MaterialSymbol icon={icon} size={16} className="mt-px shrink-0 text-[var(--nim-text-muted)]" />
      <span className="min-w-0">
        <span className="block text-[12px] font-medium text-[var(--nim-text)]">{label}</span>
        <span className="block text-[11px] text-[var(--nim-text-faint)]">{description}</span>
      </span>
    </label>
  );
}
