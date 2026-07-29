import type { InboxDelivery } from '@nimbalyst/collab-protocol';
import { asTeamJwt, asTeamMemberId } from '../../auth/jwtScopes';
import { describe, expect, it, vi } from 'vitest';

import {
  TeamInboxFanIn,
  TeamInboxOrgClient,
  type TeamInboxOrgClientLike,
  type TeamInboxOrgDescriptor,
  type TeamInboxOrgEvent,
} from '../TeamInboxSync';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code: 1000, reason: '' });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  receive(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function delivery(
  orgId: string,
  id: string,
  createdAt: number,
  conversationId = `conversation-${orgId}`,
): InboxDelivery {
  return {
    id,
    recipientUserId: `member-${orgId}`,
    orgId,
    source: {
      orgId,
      sourceKind: 'roomMessage',
      sourceId: conversationId,
      commentId: `message-${id}`,
    },
    reason: 'mention',
    preview: {
      actorLabel: 'Teammate',
      sourceTitle: 'General',
      snippet: id,
    },
    createdAt,
  };
}

class FakeOrgClient implements TeamInboxOrgClientLike {
  readonly markRead = vi.fn(async (_deliveryIds: string[]) => {});
  readonly dismiss = vi.fn(async (_deliveryIds: string[]) => {});
  readonly connect = vi.fn(async () => {});
  readonly destroy = vi.fn();
  private listener: ((event: TeamInboxOrgEvent) => void) | null = null;

  constructor(readonly org: TeamInboxOrgDescriptor) {}

  subscribe(listener: (event: TeamInboxOrgEvent) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }

  emit(event: TeamInboxOrgEvent): void {
    this.listener?.(event);
  }
}

describe('TeamInboxOrgClient', () => {
  it('uses the team-org JWT and team member id for the organization inbox room', async () => {
    const socket = new FakeWebSocket();
    const getTeamJwt = vi.fn(async () => asTeamJwt('team-jwt'));
    const client = new TeamInboxOrgClient({
      serverUrl: 'https://sync.example.test',
      org: {
        orgId: 'org-a',
        orgName: 'Acme',
        teamMemberId: asTeamMemberId('member-a'),
      },
      getTeamJwt,
      createWebSocket: (url) => {
        expect(url).toContain('/sync/org:org-a:user:member-a:inbox');
        expect(url).toContain('token=team-jwt');
        return socket as unknown as WebSocket;
      },
    });

    await client.connect();
    socket.open();

    expect(getTeamJwt).toHaveBeenCalledOnce();
    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: 'inboxSyncRequest',
    });
    client.destroy();
  });
});

describe('TeamInboxFanIn', () => {
  const orgA: TeamInboxOrgDescriptor = {
    orgId: 'org-a',
    orgName: 'Acme',
    teamMemberId: asTeamMemberId('member-a'),
  };
  const orgB: TeamInboxOrgDescriptor = {
    orgId: 'org-b',
    orgName: 'Beta',
    teamMemberId: asTeamMemberId('member-b'),
  };

  function setup() {
    const clients = new Map<string, FakeOrgClient>();
    const fanIn = new TeamInboxFanIn({
      createClient(org) {
        const client = new FakeOrgClient(org);
        clients.set(org.orgId, client);
        return client;
      },
    });
    return { fanIn, clients };
  }

  it('merges organization deliveries in global order and routes mutations to the owner room', async () => {
    const { fanIn, clients } = setup();
    await fanIn.start([orgA, orgB]);

    clients.get('org-a')!.emit({
      type: 'sync',
      deliveries: [delivery('org-a', 'a-old', 100)],
      watermarks: [],
      subscriptions: [],
    });
    clients.get('org-b')!.emit({
      type: 'sync',
      deliveries: [delivery('org-b', 'b-new', 300)],
      watermarks: [],
      subscriptions: [],
    });
    clients.get('org-a')!.emit({
      type: 'delivery',
      delivery: delivery('org-a', 'a-middle', 200),
    });

    expect(fanIn.getSnapshot().deliveries.map((item) => item.id)).toEqual([
      'b-new',
      'a-middle',
      'a-old',
    ]);

    await fanIn.markRead(['b-new', 'a-old', 'a-middle']);
    expect(clients.get('org-a')!.markRead).toHaveBeenCalledWith(['a-old', 'a-middle']);
    expect(clients.get('org-b')!.markRead).toHaveBeenCalledWith(['b-new']);

    await fanIn.dismiss('b-new');
    expect(clients.get('org-b')!.dismiss).toHaveBeenCalledWith(['b-new']);
    expect(clients.get('org-a')!.dismiss).not.toHaveBeenCalled();
  });

  it('isolates a legacy-custody org while healthy organizations stay ready', async () => {
    const { fanIn, clients } = setup();
    await fanIn.start([orgA, orgB]);

    clients.get('org-a')!.emit({
      type: 'error',
      code: 'ORG_SERVER_MANAGED_DEK_REQUIRED',
      message: 'server-managed organization DEK required',
    });
    clients.get('org-b')!.emit({
      type: 'sync',
      deliveries: [delivery('org-b', 'healthy', 100)],
      watermarks: [],
      subscriptions: [],
    });

    expect(fanIn.getSnapshot()).toMatchObject({
      status: 'ready',
      deliveries: [{ id: 'healthy', orgId: 'org-b' }],
      organizations: [
        {
          orgId: 'org-a',
          status: 'messagingUnavailable',
          errorCode: 'ORG_SERVER_MANAGED_DEK_REQUIRED',
        },
        { orgId: 'org-b', status: 'ready' },
      ],
    });
  });

  it('uses conversation watermarks for Unread and reconciles remote mark-read broadcasts', async () => {
    const { fanIn, clients } = setup();
    await fanIn.start([orgA]);
    const followed = {
      ...delivery('org-a', 'followed', 100, 'general'),
      readAt: 50,
      reason: 'follow' as const,
    };

    clients.get('org-a')!.emit({
      type: 'sync',
      deliveries: [followed],
      watermarks: [{ conversationId: 'general', sequence: 4, updatedAt: 100 }],
      subscriptions: [{
        conversationId: 'general',
        userId: 'member-a',
        state: 'following',
        reason: 'explicit',
        notificationLevel: 'all',
      }],
    });

    expect(fanIn.getSnapshot().deliveries[0]).toMatchObject({
      id: 'followed',
      hasUnreadActivity: true,
      subscription: 'following',
    });

    clients.get('org-a')!.emit({
      type: 'markRead',
      deliveryIds: ['followed'],
      readAt: 200,
      unreadCount: 0,
    });

    expect(fanIn.getSnapshot().deliveries[0]).toMatchObject({
      id: 'followed',
      // Server mark-read is advance-only (`COALESCE`), so the first read
      // timestamp remains canonical while the watermark receipt advances.
      readAt: 50,
      hasUnreadActivity: false,
    });
  });
});
