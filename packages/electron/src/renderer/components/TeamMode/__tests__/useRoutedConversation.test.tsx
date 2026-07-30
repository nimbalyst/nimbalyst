// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import { useRoutedConversation } from '../useRoutedConversation';

const listConversationDirectory = vi.fn();
vi.mock('../../../services/conversationDirectoryClient', () => ({
  listConversationDirectory: (...args: unknown[]) => listConversationDirectory(...args),
}));

const general: ConversationDirectoryEntry = {
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
const archivedRoom: ConversationDirectoryEntry = {
  ...general,
  id: 'old-room',
  title: 'Old room',
  archivedAt: 99,
};

function Probe({
  conversationId,
  conversations,
  directoryReady = true,
}: {
  conversationId?: string;
  conversations: ConversationDirectoryEntry[];
  directoryReady?: boolean;
}) {
  const routed = useRoutedConversation(
    'org-a',
    conversationId,
    conversations,
    directoryReady,
  );
  return (
    <div
      data-testid="routed"
      data-entry={routed.entry?.id ?? 'none'}
      data-archived={String(routed.entry?.archivedAt !== undefined)}
      data-resolving={String(routed.resolving)}
    />
  );
}

describe('useRoutedConversation', () => {
  beforeEach(() => {
    listConversationDirectory.mockReset();
    listConversationDirectory.mockResolvedValue([general, archivedRoom]);
  });
  afterEach(() => cleanup());

  it('resolves a listed room without asking the server', () => {
    render(<Probe conversationId="general" conversations={[general]} />);

    expect(screen.getByTestId('routed').getAttribute('data-entry')).toBe('general');
    expect(listConversationDirectory).not.toHaveBeenCalled();
  });

  // The sidebar's directory holds only unarchived rooms, but the rooms
  // directory offers "Open" on archived ones. Without the miss-path read the
  // window answered "that conversation is no longer available" for history the
  // plan says stays readable.
  it('opens an archived room the directory atom does not carry', async () => {
    render(<Probe conversationId="old-room" conversations={[general]} />);

    expect(screen.getByTestId('routed').getAttribute('data-resolving')).toBe('true');
    await waitFor(() =>
      expect(screen.getByTestId('routed').getAttribute('data-entry')).toBe('old-room'));
    // Archived, so the comments stack renders it read-only.
    expect(screen.getByTestId('routed').getAttribute('data-archived')).toBe('true');
    expect(listConversationDirectory).toHaveBeenCalledWith({
      orgId: 'org-a',
      includeArchived: true,
    });
  });

  it('reports a genuinely missing conversation once the read comes back empty', async () => {
    listConversationDirectory.mockResolvedValue([general]);
    render(<Probe conversationId="deleted" conversations={[general]} />);

    await waitFor(() =>
      expect(screen.getByTestId('routed').getAttribute('data-resolving')).toBe('false'));
    expect(screen.getByTestId('routed').getAttribute('data-entry')).toBe('none');
  });

  it('waits for the directory rather than reading archived rooms mid-load', () => {
    render(
      <Probe conversationId="old-room" conversations={[]} directoryReady={false} />,
    );

    expect(screen.getByTestId('routed').getAttribute('data-resolving')).toBe('true');
    expect(listConversationDirectory).not.toHaveBeenCalled();
  });
});
