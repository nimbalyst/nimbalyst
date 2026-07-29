// @vitest-environment jsdom
import React from 'react';
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

import { initConversationListeners } from '../../../../store/listeners/conversationListeners';
import { InboxSection } from '../InboxSection';
import { createFixtureInboxProvider } from '../inboxFixtureProvider';

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
    const input = await screen.findByTestId('comment-composer-input');
    fireEvent.change(input, {
      target: {
        value: 'posted from the inbox',
        selectionStart: 21,
        selectionEnd: 21,
      },
    });
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
});
