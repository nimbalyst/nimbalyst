// @vitest-environment jsdom
import React from 'react';
import type { FeedbackRequestReadModel, RichCommentBody } from '@nimbalyst/collab-protocol';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import { FeedbackRequestService } from '../../../../../main/services/FeedbackRequestService';
import {
  feedbackRequestActiveViewerAtomFamily,
  feedbackRequestAtomKey,
  feedbackRequestStateAtomFamily,
  feedbackRequestTargetKey,
} from '../../../../store/atoms/feedbackRequests';
import { initConversationListeners } from '../../../../store/listeners/conversationListeners';
import { type as typeIntoComposer } from '../../../Comments/composerTestDriver';
import { InboxSection } from '../InboxSection';
import { createFixtureInboxProvider } from '../inboxFixtureProvider';
import { createInboxFixtures } from '../inboxFixtures';
import type { HydratedInboxDelivery } from '../inboxTypes';

vi.mock('@nimbalyst/runtime', async (importOriginal) => {
  const runtime = await importOriginal<typeof import('@nimbalyst/runtime')>();
  return {
    ...runtime,
    MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
  };
});

describe('Inbox conversation posting', () => {
  afterEach(() => {
    cleanup();
  });

  it('mounts the real adapter in the context pane and renders the posted arrival', async () => {
    let sequence = 0;
    const invoke = vi.fn(async (channel: string, request: any) => {
      if (channel === 'conversation:list') {
        return { events: [] };
      }
      if (channel === 'conversation:append') {
        sequence += 1;
        return {
          id: `server-message-${sequence}`,
          conversationId: request.conversationId,
          sequence,
          clientMutationId: request.input.clientMutationId,
          actor: request.input.actor,
          operation: request.input.operation,
          targetMessageId: request.input.targetMessageId,
          payload: request.input.payload,
          createdAt: Date.now(),
          serverReceivedAt: Date.now(),
        };
      }
      return undefined;
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { invoke },
    });
    const provider = createFixtureInboxProvider();
    provider.conversationTransport = true;

    render(<InboxSection provider={provider} />);
    fireEvent.click(screen.getByTestId('inbox-row-delivery-mention-room'));
    await screen.findByTestId('comment-composer-input');
    typeIntoComposer('posted from the inbox');
    fireEvent.click(screen.getByTestId('comment-composer-send'));

    await waitFor(() =>
      expect(screen.getByTestId('comment-row-server-message-1').textContent)
        .toContain('posted from the inbox'),
    );
    expect(invoke).toHaveBeenCalledWith(
      'conversation:append',
      expect.objectContaining({
        input: expect.objectContaining({ operation: 'messageCreated' }),
      }),
    );
  });

  it('renders a remote realtime arrival through the IPC listener and mounted thread', async () => {
    let syncListener: ((payload: unknown) => void) | null = null;
    const unsubscribe = vi.fn();
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'conversation:list') {
        return { events: [] };
      }
      return undefined;
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke,
        on: vi.fn((
          channel: string,
          listener: (payload: unknown) => void,
        ) => {
          expect(channel).toBe('conversation:sync-event');
          syncListener = listener;
          return unsubscribe;
        }),
      },
    });
    const jotaiStore = createStore();
    const cleanupListener = initConversationListeners(jotaiStore);
    const provider = createFixtureInboxProvider();
    provider.conversationTransport = true;

    render(
      <Provider store={jotaiStore}>
        <InboxSection provider={provider} />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('inbox-row-delivery-mention-room'));
    await screen.findByTestId('comment-thread-empty');

    expect(syncListener).not.toBeNull();
    act(() => {
      const receive = syncListener as unknown as (payload: unknown) => void;
      receive({
        orgId: 'org-acme',
        conversationId: 'room-general',
        event: {
          type: 'event',
          event: {
            id: 'remote-message-1',
            conversationId: 'room-general',
            sequence: 1,
            clientMutationId: 'remote-client-mutation-1',
            actor: {
              kind: 'user',
              userId: 'u-priya',
              onBehalfOfUserId: 'u-priya',
            },
            operation: 'messageCreated',
            payload: {
              body: {
                version: 1,
                format: 'plainText',
                text: 'arrived from another teammate',
              },
            },
            createdAt: Date.now(),
            serverReceivedAt: Date.now(),
          },
        },
      });
    });

    expect(
      (await screen.findByTestId('comment-row-remote-message-1')).textContent,
    ).toContain('arrived from another teammate');
    expect(
      invoke.mock.calls.some(([channel]) => channel === 'conversation:append'),
    ).toBe(false);
    cleanupListener();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('posts feedback discussion comments through sync and keeps a failed send retryable', async () => {
    const target = {
      workspacePath: '/workspace/acme',
      orgId: 'org-acme',
      requestId: 'feedback-alpha',
    };
    const viewerUserId = 'me';
    const request = {
      id: target.requestId,
      orgId: target.orgId,
      asks: [],
      assignments: [],
      responses: [],
      discussion: [],
      lifecycle: { status: 'open', changedAt: 1 },
      visibility: 'open',
    } as unknown as FeedbackRequestReadModel;
    const feedbackState = {
      ...target,
      teamMemberId: asTeamMemberId(viewerUserId),
      status: 'connected' as const,
      request,
      progress: {
        answeredAskCount: 0,
        totalAssignedAskCount: 1,
        answeredRecipientCount: 0,
        totalRecipientCount: 1,
        quorumReached: false,
      },
    };
    const fixture = createInboxFixtures({ now: Date.now() })[0];
    const delivery: HydratedInboxDelivery = {
      ...fixture,
      id: 'delivery-feedback',
      teamMemberId: asTeamMemberId(viewerUserId),
      orgId: target.orgId,
      source: {
        orgId: target.orgId,
        sourceKind: 'feedbackRequest',
        sourceId: target.requestId,
        commentId: 'delivery-event',
      },
      reason: 'assignment',
      capabilities: { comment: true },
    };
    let attempts = 0;
    const syncComment = vi.fn(async (
      clientMutationId: string,
      body: RichCommentBody,
      replyToCommentId?: string,
    ) => {
      attempts += 1;
      if (attempts === 1) throw new Error('forced feedback comment failure');
      return {
        id: 'feedback-comment-1',
        actor: {
          kind: 'user' as const,
          userId: viewerUserId,
          onBehalfOfUserId: viewerUserId,
        },
        body: {
          version: 1 as const,
          format: 'plainText' as const,
          text: body.text,
        },
        replyToCommentId,
        createdAt: Date.now(),
      };
    });
    const sync = {
      connect: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn(() => ({
        request: feedbackState.request,
        progress: feedbackState.progress,
      })),
      comment: syncComment,
      subscribe: vi.fn(() => () => undefined),
      destroy: vi.fn(),
    };
    const service = new FeedbackRequestService({
      getTeamJwt: vi.fn(async () => asTeamJwt('team-jwt')),
      getTeamMemberId: vi.fn(() => asTeamMemberId(viewerUserId)),
      getServerUrl: vi.fn(() => 'https://sync.example.test'),
      persistence: {
        load: vi.fn().mockResolvedValue(undefined),
        save: vi.fn().mockResolvedValue(undefined),
      } as never,
      createSync: vi.fn(() => sync as never),
    });
    const invoke = vi.fn(async (channel: string, request: any) => {
      if (channel === 'app-settings:get' || channel === 'app-settings:set') {
        return undefined;
      }
      expect(channel).toBe('feedback-request:comment');
      return service.comment(
        request.target,
        request.clientMutationId,
        request.body,
        request.replyToCommentId,
      );
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke,
        feedbackRequest: {
          start: vi.fn().mockResolvedValue(feedbackState),
        },
      },
    });
    const jotaiStore = createStore();
    jotaiStore.set(
      feedbackRequestActiveViewerAtomFamily(feedbackRequestTargetKey(target)),
      asTeamMemberId(viewerUserId),
    );
    jotaiStore.set(
      feedbackRequestStateAtomFamily(feedbackRequestAtomKey({
        ...target,
        teamMemberId: asTeamMemberId(viewerUserId),
      })),
      feedbackState,
    );

    render(
      <Provider store={jotaiStore}>
        <InboxSection
          provider={createFixtureInboxProvider({ deliveries: [delivery] })}
          workspacePath={target.workspacePath}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('inbox-row-delivery-feedback'));
    fireEvent.click(await screen.findByTestId('feedback-respond-add-comment'));
    await screen.findByTestId('comment-composer-input');
    typeIntoComposer('The choices need clarification.');
    fireEvent.click(screen.getByTestId('comment-composer-send'));

    const failed = await screen.findByTestId('comment-row-failed');
    expect(failed.textContent).toContain('Not sent');
    fireEvent.click(screen.getByTestId('comment-row-retry'));
    await screen.findByTestId('comment-row-feedback-comment-1');

    expect(syncComment).toHaveBeenCalledTimes(2);
    expect(syncComment.mock.calls[0][0]).toBeTruthy();
    expect(syncComment.mock.calls[0][1]).toMatchObject({
      version: 1,
      format: 'nimbalystMarkdown',
      text: 'The choices need clarification.',
    });
    expect(syncComment.mock.calls[0][2]).toBeUndefined();
    expect(syncComment.mock.calls[1]).toEqual(syncComment.mock.calls[0]);
    service.destroy();
  });
});
