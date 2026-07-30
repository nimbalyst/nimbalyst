// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import { ComposeDestinationDialog } from '../ComposeDestinationDialog';
import { NewDirectMessageDialog } from '../NewDirectMessageDialog';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const createDirectoryConversation = vi.fn();
vi.mock('../../../services/conversationDirectoryClient', () => ({
  createDirectoryConversation: (...args: unknown[]) =>
    createDirectoryConversation(...args),
}));

const members = [
  { memberId: 'member-a', email: 'greg@example.com', name: 'Greg', role: 'owner' },
  { memberId: 'member-b', email: 'karl@example.com', name: 'Karl', role: 'member' },
];

const conversations: ConversationDirectoryEntry[] = [{
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

describe('ComposeDestinationDialog', () => {
  beforeEach(() => {
    createDirectoryConversation.mockReset();
    createDirectoryConversation.mockResolvedValue({
      descriptor: { id: 'dm-new' },
      memberships: [],
    });
  });
  afterEach(() => cleanup());

  function renderCompose() {
    const onOpenConversation = vi.fn();
    render(
      <ComposeDestinationDialog
        orgId="org-a"
        conversations={conversations}
        members={members}
        viewerUserId="member-a"
        onClose={vi.fn()}
        onOpenConversation={onOpenConversation}
      />,
    );
    return { onOpenConversation };
  }

  it('opens a picked room without creating anything', () => {
    const { onOpenConversation } = renderCompose();

    fireEvent.click(screen.getByTestId('compose-destination-room-general'));

    expect(onOpenConversation).toHaveBeenCalledWith('general');
    expect(createDirectoryConversation).not.toHaveBeenCalled();
  });

  it('creates the direct message for a picked person, with the viewer included', async () => {
    const { onOpenConversation } = renderCompose();

    fireEvent.click(screen.getByTestId('compose-destination-member-member-b'));

    await waitFor(() => expect(onOpenConversation).toHaveBeenCalledWith('dm-new'));
    expect(createDirectoryConversation).toHaveBeenCalledWith({
      orgId: 'org-a',
      input: {
        kind: 'dm',
        visibility: 'private',
        memberships: [
          { userId: 'member-a', role: 'member' },
          { userId: 'member-b', role: 'member' },
        ],
      },
    });
  });

  it('reuses a known direct message instead of creating a second one', async () => {
    const onOpenConversation = vi.fn();
    render(
      <ComposeDestinationDialog
        orgId="org-a"
        conversations={[
          ...conversations,
          { ...conversations[0], id: 'dm-1', kind: 'dm', visibility: 'private', title: undefined },
        ]}
        members={members}
        viewerUserId="member-a"
        participantsByConversationId={{ 'dm-1': ['member-b', 'member-a'] }}
        onClose={vi.fn()}
        onOpenConversation={onOpenConversation}
      />,
    );

    fireEvent.click(screen.getByTestId('compose-destination-member-member-b'));

    await waitFor(() => expect(onOpenConversation).toHaveBeenCalledWith('dm-1'));
    expect(createDirectoryConversation).not.toHaveBeenCalled();
  });

  it('filters the list down to matches', () => {
    renderCompose();

    fireEvent.change(screen.getByTestId('compose-destination-search'), {
      target: { value: 'karl' },
    });

    expect(screen.queryByTestId('compose-destination-room-general')).toBeNull();
    expect(screen.getByTestId('compose-destination-member-member-b')).toBeTruthy();
  });

  it('highlights the first destination and opens it on Enter', () => {
    const { onOpenConversation } = renderCompose();
    const search = screen.getByTestId('compose-destination-search');

    expect(screen.getByTestId('compose-destination-room-general').getAttribute('data-active')).toBe('true');

    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onOpenConversation).toHaveBeenCalledWith('general');
  });

  it('moves the highlight with the arrow keys, wrapping at both ends', async () => {
    const { onOpenConversation } = renderCompose();
    const search = screen.getByTestId('compose-destination-search');

    // general, Karl — the viewer (Greg) is never a destination.
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getByTestId('compose-destination-member-member-b').getAttribute('data-active')).toBe('true');

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getByTestId('compose-destination-room-general').getAttribute('data-active')).toBe('true');

    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.keyDown(search, { key: 'Enter' });

    await waitFor(() => expect(onOpenConversation).toHaveBeenCalledWith('dm-new'));
  });

  it('re-highlights the top match as the query narrows the list', () => {
    const { onOpenConversation } = renderCompose();
    const search = screen.getByTestId('compose-destination-search');

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.change(search, { target: { value: 'gene' } });

    // Without the reset the highlight would still be at index 1, which the
    // narrowed list no longer has.
    expect(screen.getByTestId('compose-destination-room-general').getAttribute('data-active')).toBe('true');
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onOpenConversation).toHaveBeenCalledWith('general');
  });

  it('does nothing on Enter when nothing matches', () => {
    const { onOpenConversation } = renderCompose();
    const search = screen.getByTestId('compose-destination-search');

    fireEvent.change(search, { target: { value: 'nobody-by-that-name' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(screen.getByTestId('compose-destination-empty')).toBeTruthy();
    expect(onOpenConversation).not.toHaveBeenCalled();
  });
});

describe('NewDirectMessageDialog', () => {
  beforeEach(() => {
    createDirectoryConversation.mockReset();
    createDirectoryConversation.mockResolvedValue({
      descriptor: { id: 'dm-new' },
      memberships: [],
    });
  });
  afterEach(() => cleanup());

  it('requires at least one other participant before it will start', async () => {
    const onOpened = vi.fn();
    render(
      <NewDirectMessageDialog
        orgId="org-a"
        members={members}
        viewerUserId="member-a"
        conversations={conversations}
        onClose={vi.fn()}
        onOpened={onOpened}
      />,
    );

    expect((screen.getByTestId('new-dm-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('new-dm-summary').textContent).toMatch(/at least one/);

    fireEvent.click(
      screen.getByTestId('new-dm-members-option-member-b').querySelector('input')!,
    );
    expect(screen.getByTestId('new-dm-summary').textContent).toContain('2 participants');

    fireEvent.click(screen.getByTestId('new-dm-submit'));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith('dm-new'));
  });
});
