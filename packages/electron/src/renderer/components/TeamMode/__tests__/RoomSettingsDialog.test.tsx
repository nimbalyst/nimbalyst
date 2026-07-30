// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import { RoomSettingsDialog } from '../RoomSettingsDialog';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const archiveDirectoryConversation = vi.fn();
const setDirectoryAgentPosting = vi.fn();
const setDirectoryConversationMembership = vi.fn();
const updateDirectoryConversation = vi.fn();

vi.mock('../../../services/conversationDirectoryClient', () => ({
  archiveDirectoryConversation: (...args: unknown[]) => archiveDirectoryConversation(...args),
  setDirectoryAgentPosting: (...args: unknown[]) => setDirectoryAgentPosting(...args),
  setDirectoryConversationMembership: (...args: unknown[]) =>
    setDirectoryConversationMembership(...args),
  updateDirectoryConversation: (...args: unknown[]) => updateDirectoryConversation(...args),
}));

const members = [
  { memberId: 'member-a', email: 'greg@example.com', name: 'Greg', role: 'owner' },
  { memberId: 'member-b', email: 'karl@example.com', name: 'Karl', role: 'member' },
];

const entry: ConversationDirectoryEntry = {
  id: 'design',
  orgId: 'org-a',
  kind: 'orgRoom',
  visibility: 'private',
  title: 'Design',
  topic: 'Design reviews',
  agentPostingEnabled: false,
  createdByUserId: 'member-a',
  createdAt: 1,
  capabilities: ['read', 'comment', 'manageRoom'],
};

function renderDialog(overrides: Partial<React.ComponentProps<typeof RoomSettingsDialog>> = {}) {
  const onClose = vi.fn();
  const onArchived = vi.fn();
  render(
    <RoomSettingsDialog
      orgId="org-a"
      entry={entry}
      members={members}
      viewerUserId="member-a"
      onClose={onClose}
      onArchived={onArchived}
      {...overrides}
    />,
  );
  return { onClose, onArchived };
}

/** The same dialog, kept mounted while the host hands down new memberships. */
function renderRerenderableDialog() {
  const props = {
    orgId: 'org-a',
    entry,
    members,
    viewerUserId: 'member-a',
    onClose: vi.fn(),
    onArchived: vi.fn(),
  };
  const view = render(<RoomSettingsDialog {...props} memberships={null} />);
  return {
    rerender: (memberships: React.ComponentProps<typeof RoomSettingsDialog>['memberships']) =>
      view.rerender(<RoomSettingsDialog {...props} memberships={memberships} />),
  };
}

describe('RoomSettingsDialog', () => {
  beforeEach(() => {
    for (const mock of [
      archiveDirectoryConversation,
      setDirectoryAgentPosting,
      setDirectoryConversationMembership,
      updateDirectoryConversation,
    ]) mock.mockReset();
    updateDirectoryConversation.mockResolvedValue({ descriptor: entry });
    archiveDirectoryConversation.mockResolvedValue({ descriptor: entry });
    setDirectoryAgentPosting.mockResolvedValue({ descriptor: entry });
    setDirectoryConversationMembership.mockResolvedValue({
      memberships: [{
        conversationId: 'design',
        userId: 'member-b',
        role: 'roomAdmin',
        addedByUserId: 'member-a',
        createdAt: 2,
      }],
    });
  });
  afterEach(() => cleanup());

  it('keeps save disabled until something changes, then sends only that field', async () => {
    renderDialog();

    expect((screen.getByTestId('room-settings-save') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('room-settings-name'), {
      target: { value: 'Design HQ' },
    });
    fireEvent.click(screen.getByTestId('room-settings-save'));

    await waitFor(() => expect(updateDirectoryConversation).toHaveBeenCalledWith({
      orgId: 'org-a',
      conversationId: 'design',
      input: { title: 'Design HQ' },
    }));
  });

  it('clears the topic with an explicit null rather than omitting it', async () => {
    renderDialog();

    fireEvent.change(screen.getByTestId('room-settings-topic'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByTestId('room-settings-save'));

    await waitFor(() => expect(updateDirectoryConversation).toHaveBeenCalledWith({
      orgId: 'org-a',
      conversationId: 'design',
      input: { topic: null },
    }));
  });

  it('learns the room roles from the membership mutation that returns them', async () => {
    renderDialog({ initialSection: 'members' });

    expect(screen.getByTestId('room-settings-members-unknown')).toBeTruthy();
    expect(
      screen.getByTestId('room-settings-member-member-b').getAttribute('data-room-role'),
    ).toBe('none');

    fireEvent.click(screen.getByTestId('room-settings-member-actions-member-b'));
    fireEvent.click(screen.getByTestId('room-settings-member-promote-member-b'));

    await waitFor(() => expect(setDirectoryConversationMembership).toHaveBeenCalledWith({
      orgId: 'org-a',
      conversationId: 'design',
      userId: 'member-b',
      active: true,
      role: 'roomAdmin',
    }));
    await waitFor(() => expect(
      screen.getByTestId('room-settings-member-member-b').getAttribute('data-room-role'),
    ).toBe('roomAdmin'));
    expect(screen.queryByTestId('room-settings-members-unknown')).toBeNull();
  });

  it('shows the fetched room roles immediately when the dialog opens', () => {
    renderDialog({
      initialSection: 'members',
      memberships: [{
        conversationId: 'design',
        userId: 'member-b',
        role: 'roomAdmin',
        addedByUserId: 'member-a',
        createdAt: 2,
      }],
    });

    expect(screen.queryByTestId('room-settings-members-unknown')).toBeNull();
    expect(
      screen.getByTestId('room-settings-member-member-b').getAttribute('data-room-role'),
    ).toBe('roomAdmin');
  });

  it('archives only after the confirmation step', async () => {
    const { onArchived } = renderDialog();

    fireEvent.click(screen.getByTestId('room-settings-archive'));
    expect(archiveDirectoryConversation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('room-settings-archive-confirm'));
    await waitFor(() => expect(archiveDirectoryConversation).toHaveBeenCalledWith({
      orgId: 'org-a',
      conversationId: 'design',
    }));
    expect(onArchived).toHaveBeenCalled();
  });

  it('keeps an unsaved rename when the membership list changes underneath it', () => {
    const { rerender } = renderRerenderableDialog();

    fireEvent.change(screen.getByTestId('room-settings-name'), {
      target: { value: 'Design HQ' },
    });

    // A membership mutation (or the window's own refresh) hands down a new
    // memberships array while the rename is still in the box.
    rerender([{
      conversationId: 'design',
      userId: 'member-b',
      role: 'roomAdmin' as const,
      addedByUserId: 'member-a',
      createdAt: 2,
    }]);

    expect((screen.getByTestId('room-settings-name') as HTMLInputElement).value)
      .toBe('Design HQ');
  });

  it('does not offer to archive the general room', () => {
    renderDialog({ entry: { ...entry, id: 'general', title: 'General', visibility: 'public' } });

    expect(screen.queryByTestId('room-settings-archive')).toBeNull();
    expect(screen.getByTestId('room-settings-archive-blocked')).toBeTruthy();
  });

  it('toggles agent posting from the descriptor state', async () => {
    renderDialog();

    fireEvent.click(screen.getByTestId('room-settings-agent-posting'));
    await waitFor(() => expect(setDirectoryAgentPosting).toHaveBeenCalledWith({
      orgId: 'org-a',
      conversationId: 'design',
      enabled: true,
    }));
  });
});
