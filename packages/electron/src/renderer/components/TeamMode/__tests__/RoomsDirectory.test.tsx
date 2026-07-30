// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import { RoomsDirectory } from '../RoomsDirectory';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));

const listConversationDirectory = vi.hoisted(() => vi.fn());
vi.mock('../../../services/conversationDirectoryClient', () => ({
  listConversationDirectory,
  setDirectoryConversationMembership: vi.fn(),
}));

const room: ConversationDirectoryEntry = {
  id: 'general',
  orgId: 'org-a',
  kind: 'orgRoom',
  visibility: 'public',
  title: 'General',
  agentPostingEnabled: false,
  createdByUserId: 'member-a',
  createdAt: 1,
  capabilities: ['read', 'comment'],
};

describe('RoomsDirectory', () => {
  beforeEach(() => listConversationDirectory.mockReset());
  afterEach(() => cleanup());

  it('lists the rooms it can see', async () => {
    listConversationDirectory.mockResolvedValue([room]);
    render(
      <RoomsDirectory orgId="org-a" viewerUserId="member-a" onOpenConversation={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('org-rooms-directory-row-general')).toBeTruthy());
    expect(screen.queryByTestId('org-rooms-directory-empty')).toBeNull();
  });

  it('offers the way out of an empty directory instead of stating emptiness', async () => {
    listConversationDirectory.mockResolvedValue([]);
    const onCreateRoom = vi.fn();
    render(
      <RoomsDirectory
        orgId="org-a"
        viewerUserId="member-a"
        onOpenConversation={vi.fn()}
        onCreateRoom={onCreateRoom}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('org-rooms-directory-empty')).toBeTruthy());
    fireEvent.click(screen.getByTestId('org-rooms-directory-empty-create'));
    expect(onCreateRoom).toHaveBeenCalledTimes(1);
  });

  it('omits the create action from the empty state for a member who may not create rooms', async () => {
    listConversationDirectory.mockResolvedValue([]);
    render(
      <RoomsDirectory orgId="org-a" viewerUserId="member-a" onOpenConversation={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('org-rooms-directory-empty')).toBeTruthy());
    expect(screen.queryByTestId('org-rooms-directory-empty-create')).toBeNull();
    expect((screen.getByTestId('org-rooms-create') as HTMLButtonElement).title)
      .toBe('Only organization admins can create rooms');
  });

  it('says the archived rooms were included when the filter is on', async () => {
    listConversationDirectory.mockResolvedValue([]);
    render(
      <RoomsDirectory orgId="org-a" viewerUserId="member-a" onOpenConversation={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId('org-rooms-directory-empty')).toBeTruthy());
    fireEvent.click(screen.getByTestId('org-rooms-archived-filter'));

    await waitFor(() => expect(screen.getByTestId('org-rooms-directory-empty').textContent)
      .toContain('archived ones included'));
  });
});
