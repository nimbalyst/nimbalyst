// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import { CreateRoomDialog } from '../CreateRoomDialog';

const createDirectoryConversation = vi.fn();
vi.mock('../../../services/conversationDirectoryClient', () => ({
  createDirectoryConversation: (...args: unknown[]) =>
    createDirectoryConversation(...args),
}));

const members = [
  { memberId: 'member-a', email: 'greg@example.com', name: 'Greg', role: 'owner' },
  { memberId: 'member-b', email: 'karl@example.com', name: 'Karl', role: 'member' },
];

const existing: ConversationDirectoryEntry[] = [{
  id: 'general',
  orgId: 'org-a',
  kind: 'orgRoom',
  visibility: 'public',
  title: 'General',
  agentPostingEnabled: false,
  createdByUserId: 'member-a',
  createdAt: 1,
  capabilities: ['read', 'comment'],
}];

function renderDialog(onCreated = vi.fn()) {
  const onClose = vi.fn();
  render(
    <CreateRoomDialog
      orgId="org-a"
      members={members}
      viewerUserId="member-a"
      existingConversations={existing}
      onClose={onClose}
      onCreated={onCreated}
    />,
  );
  return { onClose, onCreated };
}

describe('CreateRoomDialog', () => {
  beforeEach(() => {
    createDirectoryConversation.mockReset();
    createDirectoryConversation.mockResolvedValue({
      descriptor: { id: 'design-reviews' },
      memberships: [],
    });
  });
  afterEach(() => cleanup());

  it('derives the id from the name until the id is edited by hand', () => {
    renderDialog();

    fireEvent.change(screen.getByTestId('create-room-name'), {
      target: { value: 'Design Reviews' },
    });
    const id = screen.getByTestId('create-room-id') as HTMLInputElement;
    expect(id.value).toBe('design-reviews');

    fireEvent.change(id, { target: { value: 'reviews' } });
    fireEvent.change(screen.getByTestId('create-room-name'), {
      target: { value: 'Design Reviews Weekly' },
    });
    expect((screen.getByTestId('create-room-id') as HTMLInputElement).value).toBe('reviews');
  });

  it('blocks a colliding id before the request is sent', () => {
    renderDialog();

    fireEvent.change(screen.getByTestId('create-room-name'), {
      target: { value: 'General' },
    });
    expect((screen.getByTestId('create-room-submit') as HTMLButtonElement).disabled).toBe(true);
    screen.getByText(/already exists/);
    expect(createDirectoryConversation).not.toHaveBeenCalled();
  });

  it('offers initial members only for a private room and creates it', async () => {
    const { onCreated } = renderDialog();

    fireEvent.change(screen.getByTestId('create-room-name'), {
      target: { value: 'Design Reviews' },
    });
    fireEvent.change(screen.getByTestId('create-room-topic'), {
      target: { value: 'Weekly critique' },
    });
    expect(screen.queryByTestId('create-room-members')).toBeNull();

    fireEvent.click(
      screen.getByTestId('create-room-visibility-private').querySelector('input')!,
    );
    // The viewer is implied, so only the other member is offered.
    expect(screen.queryByTestId('create-room-members-option-member-a')).toBeNull();
    fireEvent.click(
      screen.getByTestId('create-room-members-option-member-b').querySelector('input')!,
    );
    fireEvent.click(screen.getByTestId('create-room-agent-posting'));

    fireEvent.click(screen.getByTestId('create-room-submit'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('design-reviews'));
    expect(createDirectoryConversation).toHaveBeenCalledWith({
      orgId: 'org-a',
      input: {
        id: 'design-reviews',
        kind: 'orgRoom',
        visibility: 'private',
        title: 'Design Reviews',
        topic: 'Weekly critique',
        memberships: [{ userId: 'member-b', role: 'member' }],
        agentPostingEnabled: true,
      },
    });
  });

  it('surfaces a rejected create instead of closing', async () => {
    createDirectoryConversation.mockRejectedValue(new Error('Not authorized'));
    const { onCreated } = renderDialog();

    fireEvent.change(screen.getByTestId('create-room-name'), {
      target: { value: 'Design' },
    });
    fireEvent.click(screen.getByTestId('create-room-submit'));

    await screen.findByTestId('create-room-dialog-error');
    expect(screen.getByTestId('create-room-dialog-error').textContent).toContain('Not authorized');
    expect(onCreated).not.toHaveBeenCalled();
  });
});
