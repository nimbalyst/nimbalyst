// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommentThread } from '../CommentThread';
import { createConversationCommentAdapter } from '../ConversationCommentAdapter';
import { FULL_CAPABILITIES, createCommentFixtures } from '../commentFixtures';
import type { Actor, CommentAdapter } from '../commentTypes';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const NOW = Date.parse('2026-07-26T18:00:00.000Z');
const VIEWER: Actor = {
  kind: 'user',
  userId: 'user-rowan',
  onBehalfOfUserId: 'user-rowan',
};

const HISTORY = {
  events: [{
    id: 'message-warm',
    sequence: 1,
    actor: VIEWER,
    operation: 'messageCreated',
    payload: { body: { format: 'plainText', text: 'already loaded once' } },
    createdAt: NOW,
    serverReceivedAt: NOW,
  }],
  nextCursor: undefined,
};

function renderThread(adapter: CommentAdapter) {
  const fixtures = createCommentFixtures({ now: NOW });
  return render(
    <CommentThread
      adapter={adapter}
      capabilities={FULL_CAPABILITIES}
      context={fixtures.context}
      directory={fixtures.directory}
      orgId="org-acme"
      viewerUserId="user-rowan"
      viewerActor={VIEWER}
      now={NOW}
    />,
  );
}

/**
 * Switching rooms remounts the thread by design — it must not carry the
 * previous room's messages, draft or reply target across. What it must not also
 * do is go blank while an IPC round trip re-fetches history the client already
 * holds, which is what made every room click feel like a load.
 */
describe('CommentThread on a room switched back to', () => {
  afterEach(() => cleanup());

  it('paints cached history on the first frame and revalidates behind it', async () => {
    const store = createStore();
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'conversation:list') return HISTORY;
      throw new Error(`unexpected channel ${channel}`);
    });
    const config = {
      orgId: 'org-acme',
      conversationId: 'conv-general',
      sourceKind: 'roomMessage' as const,
      viewerActor: VIEWER,
      capabilities: FULL_CAPABILITIES,
      store,
      invoke,
    };

    // First visit: nothing cached, so the thread waits for the fetch.
    const first = renderThread(createConversationCommentAdapter(config));
    expect(screen.getByTestId('comment-thread-loading')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('comment-row-message-warm')).toBeTruthy());
    first.unmount();

    // Coming back. The fetch is left pending on purpose: everything asserted
    // below has to be true without it.
    let releaseList: (() => void) | undefined;
    const pendingInvoke = vi.fn(async (channel: string) => {
      if (channel !== 'conversation:list') {
        throw new Error(`unexpected channel ${channel}`);
      }
      await new Promise<void>((resolve) => { releaseList = resolve; });
      return HISTORY;
    });
    renderThread(createConversationCommentAdapter({
      ...config,
      invoke: pendingInvoke,
    }));

    expect(screen.queryByTestId('comment-thread-loading')).toBeNull();
    expect(screen.getByTestId('comment-row-message-warm').textContent)
      .toContain('already loaded once');
    // Stale-while-revalidate, not a replacement for the fetch: the read is in
    // flight behind the painted history.
    expect(pendingInvoke).toHaveBeenCalledWith(
      'conversation:list',
      expect.objectContaining({ conversationId: 'conv-general' }),
    );
    releaseList?.();
    await waitFor(() =>
      expect(screen.getByTestId('comment-row-message-warm')).toBeTruthy());
  });

  it('still shows the skeleton for a conversation with no cached history', async () => {
    const adapter = createConversationCommentAdapter({
      orgId: 'org-acme',
      conversationId: 'conv-cold',
      sourceKind: 'roomMessage',
      viewerActor: VIEWER,
      capabilities: FULL_CAPABILITIES,
      store: createStore(),
      invoke: vi.fn(async () => ({ events: [], nextCursor: undefined })),
    });

    renderThread(adapter);
    expect(screen.getByTestId('comment-thread-loading')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('comment-thread-empty')).toBeTruthy());
  });
});
