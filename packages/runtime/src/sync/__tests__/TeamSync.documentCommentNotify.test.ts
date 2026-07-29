import { describe, expect, it, vi } from 'vitest';
import { TeamSyncProvider } from '../TeamSync';
import type { TeamClientMessage, TeamSyncConfig } from '../teamSyncTypes';

function createProvider(): TeamSyncProvider {
  const config: TeamSyncConfig = {
    serverUrl: 'ws://example.test',
    getJwt: async () => 'token',
    orgId: 'org-1',
    userId: 'user-1',
  };
  return new TeamSyncProvider(config);
}

/** Stand in for an open socket so `send` takes the online branch. */
function attachOpenSocket(provider: TeamSyncProvider): TeamClientMessage[] {
  const sent: TeamClientMessage[] = [];
  (provider as any).ws = {
    readyState: WebSocket.OPEN,
    send: (raw: string) => sent.push(JSON.parse(raw) as TeamClientMessage),
    close: () => {},
  };
  return sent;
}

describe('TeamSyncProvider document comment notifications', () => {
  it('sends a bounded mention notification over the team connection', () => {
    const provider = createProvider();
    const sent = attachOpenSocket(provider);

    provider.notifyDocumentComment({
      documentId: 'doc-1',
      commentId: 'comment-1',
      threadId: 'thread-1',
      reason: 'mention',
      recipientUserIds: ['member-2'],
      preview: { actorLabel: 'Ada', snippet: 'take a look' },
    });

    expect(sent).toEqual([{
      type: 'documentCommentNotify',
      documentId: 'doc-1',
      commentId: 'comment-1',
      threadId: 'thread-1',
      reason: 'mention',
      recipientUserIds: ['member-2'],
      preview: { actorLabel: 'Ada', snippet: 'take a look' },
    }]);
    provider.destroy();
  });

  it('does not send anything when there are no recipients', () => {
    const provider = createProvider();
    const sent = attachOpenSocket(provider);

    provider.notifyDocumentComment({
      documentId: 'doc-1',
      commentId: 'comment-1',
      reason: 'reply',
      recipientUserIds: [],
    });

    expect(sent).toEqual([]);
    provider.destroy();
  });

  it('queues a notification raised while offline and replays it on reconnect', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const provider = createProvider();

    provider.notifyDocumentComment({
      documentId: 'doc-1',
      commentId: 'comment-1',
      reason: 'mention',
      recipientUserIds: ['member-2'],
    });
    // A re-raise of the same comment collapses; a different comment does not.
    provider.notifyDocumentComment({
      documentId: 'doc-1',
      commentId: 'comment-1',
      reason: 'mention',
      recipientUserIds: ['member-2', 'member-3'],
    });
    provider.notifyDocumentComment({
      documentId: 'doc-1',
      commentId: 'comment-2',
      reason: 'reply',
      recipientUserIds: ['member-2'],
    });

    const sent = attachOpenSocket(provider);
    (provider as any).replayPendingOfflineMessages();

    expect(sent).toEqual([
      {
        type: 'documentCommentNotify',
        documentId: 'doc-1',
        commentId: 'comment-1',
        reason: 'mention',
        recipientUserIds: ['member-2', 'member-3'],
      },
      {
        type: 'documentCommentNotify',
        documentId: 'doc-1',
        commentId: 'comment-2',
        reason: 'reply',
        recipientUserIds: ['member-2'],
      },
    ]);
    provider.destroy();
    vi.restoreAllMocks();
  });

  it('still collapses duplicate offline doc-index mutations by entity', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const provider = createProvider();

    provider.trashDocument('doc-1', 1);
    provider.trashDocument('doc-1', 2);
    provider.trashDocument('doc-2', 3);

    const sent = attachOpenSocket(provider);
    (provider as any).replayPendingOfflineMessages();

    expect(sent).toEqual([
      { type: 'docTrash', documentId: 'doc-1', trashedAt: 2 },
      { type: 'docTrash', documentId: 'doc-2', trashedAt: 3 },
    ]);
    provider.destroy();
    vi.restoreAllMocks();
  });
});
