// @vitest-environment node
import type { ConversationEvent } from '@nimbalyst/collab-protocol';
import { describe, expect, it, vi } from 'vitest';

import { asTeamJwt } from '../../auth/jwtScopes';
import { ConversationSync, ConversationSyncError } from '../ConversationSync';

class FakeWebSocket {
  static readonly OPEN = 1;

  readonly sent: string[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  addEventListener(type: string, listener: (event: any) => void): void {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 3;
    this.dispatch('close', {});
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch('open', {});
  }

  receive(message: unknown): void {
    this.dispatch('message', { data: JSON.stringify(message) });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function event(
  id: string,
  sequence: number,
  text: string,
): ConversationEvent {
  return {
    id,
    conversationId: 'conversation-a',
    sequence,
    clientMutationId: `mutation-${id}`,
    actor: {
      kind: 'user',
      userId: 'member-a',
      onBehalfOfUserId: 'member-a',
    },
    operation: 'messageCreated',
    payload: {
      body: { version: 1, format: 'plainText', text },
    },
    createdAt: sequence,
    serverReceivedAt: sequence,
  };
}

function createSync() {
  const sockets: FakeWebSocket[] = [];
  const getTeamJwt = vi.fn(async () => asTeamJwt('team-jwt'));
  const sync = new ConversationSync({
    serverUrl: 'https://sync.example.test',
    target: { orgId: 'org-a', conversationId: 'conversation-a' },
    getTeamJwt,
    createWebSocket: (url) => {
      expect(url).toContain(
        '/sync/org:org-a:conversation:conversation-a?token=team-jwt',
      );
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { getTeamJwt, sockets, sync };
}

describe('ConversationSync', () => {
  it('uses only the branded team JWT and forwards realtime events', async () => {
    const { getTeamJwt, sockets, sync } = createSync();
    const received: ConversationEvent[] = [];
    sync.subscribe((item) => {
      if (item.type === 'event') received.push(item.event);
    });

    await sync.connect();
    sockets[0].open();
    sockets[0].receive({
      type: 'conversationEvent',
      event: event('message-1', 1, 'arrived'),
    });

    expect(getTeamJwt).toHaveBeenCalledTimes(1);
    expect(received.map((item) => item.payload?.body?.text)).toEqual([
      'arrived',
    ]);
    sync.destroy();
  });

  it('sends the server sequence cursor across a pagination boundary', async () => {
    const { sockets, sync } = createSync();
    await sync.connect();
    sockets[0].open();

    const firstPage = sync.list(undefined, 2);
    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      type: 'conversationHistory',
      pageSize: 2,
    });
    sockets[0].receive({
      type: 'conversationHistoryResponse',
      events: [event('message-3', 3, 'three'), event('message-4', 4, 'four')],
      nextCursor: 3,
    });
    await expect(firstPage).resolves.toMatchObject({ nextCursor: '3' });

    const secondPage = sync.list('3', 2);
    expect(JSON.parse(sockets[0].sent[1])).toEqual({
      type: 'conversationHistory',
      beforeSequence: 3,
      pageSize: 2,
    });
    sockets[0].receive({
      type: 'conversationHistoryResponse',
      events: [event('message-1', 1, 'one'), event('message-2', 2, 'two')],
    });
    await expect(secondPage).resolves.toMatchObject({
      events: [
        expect.objectContaining({ id: 'message-1' }),
        expect.objectContaining({ id: 'message-2' }),
      ],
    });
    sync.destroy();
  });

  it('rejects the active append with the server error', async () => {
    const { sockets, sync } = createSync();
    await sync.connect();
    sockets[0].open();

    const pending = sync.append({
      clientMutationId: 'retry-me',
      actor: {
        kind: 'user',
        userId: 'member-a',
        onBehalfOfUserId: 'member-a',
      },
      operation: 'messageCreated',
      payload: {
        body: { version: 1, format: 'plainText', text: 'retry me' },
      },
    });
    sockets[0].receive({
      type: 'conversationError',
      code: 'forcedFailure',
      message: 'forced send failure',
    });

    await expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<ConversationSyncError>>({
        code: 'forcedFailure',
        message: 'forced send failure',
      }),
    );
    sync.destroy();
  });
});
