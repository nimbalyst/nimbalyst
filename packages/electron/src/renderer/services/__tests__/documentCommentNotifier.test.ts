// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const notifyDocumentComment = vi.fn();
const getTeamSyncProviderForScopeKey = vi.fn();

vi.mock('../../store/atoms/collabDocuments', () => ({
  getTeamSyncProviderForScopeKey: (scopeKey: string) =>
    getTeamSyncProviderForScopeKey(scopeKey),
}));

import { notifyDocumentCommentRecipients } from '../documentCommentNotifier';

describe('notifyDocumentCommentRecipients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTeamSyncProviderForScopeKey.mockReturnValue({ notifyDocumentComment });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('routes a mention with a bounded preview through the team connection', () => {
    notifyDocumentCommentRecipients({
      workspacePath: '/w',
      documentId: 'doc-1',
      reason: 'mention',
      recipientUserIds: ['member-2'],
      payload: {
        actorName: 'Ada',
        sourceTitle: 'Design notes',
        snippet: 'take a look',
        commentId: 'comment-1',
        threadId: 'thread-1',
        markId: 'thread-1',
        url: 'collab://org:o:doc:doc-1',
      },
    });

    expect(getTeamSyncProviderForScopeKey).toHaveBeenCalledWith('/w');
    expect(notifyDocumentComment).toHaveBeenCalledWith({
      documentId: 'doc-1',
      commentId: 'comment-1',
      threadId: 'thread-1',
      reason: 'mention',
      recipientUserIds: ['member-2'],
      preview: {
        actorLabel: 'Ada',
        sourceTitle: 'Design notes',
        snippet: 'take a look',
      },
    });
  });

  it('skips a payload with no comment id rather than risking a duplicate', () => {
    notifyDocumentCommentRecipients({
      workspacePath: '/w',
      documentId: 'doc-1',
      reason: 'reply',
      recipientUserIds: ['member-2'],
      payload: { snippet: 'orphan' },
    });

    expect(notifyDocumentComment).not.toHaveBeenCalled();
  });

  it('skips empty recipient sets and workspaces with no team connection', () => {
    notifyDocumentCommentRecipients({
      workspacePath: '/w',
      documentId: 'doc-1',
      reason: 'mention',
      recipientUserIds: [],
      payload: { commentId: 'comment-1' },
    });
    expect(getTeamSyncProviderForScopeKey).not.toHaveBeenCalled();

    getTeamSyncProviderForScopeKey.mockReturnValue(null);
    notifyDocumentCommentRecipients({
      workspacePath: '/w',
      documentId: 'doc-1',
      reason: 'mention',
      recipientUserIds: ['member-2'],
      payload: { commentId: 'comment-1' },
    });
    expect(notifyDocumentComment).not.toHaveBeenCalled();
  });
});
