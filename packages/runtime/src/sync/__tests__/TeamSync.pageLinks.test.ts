// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '../../auth/jwtScopes';
import { TeamSyncProvider } from '../TeamSync';
import { onTeamPageLinksChanged } from '../teamPageLinks';
import type { PageLinkEntry } from '@nimbalyst/collab-protocol';

it('matches each links query to its response, answers null offline, and tells Links sections to ask again', async () => {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const sent: any[] = [];
  const socket = {
    readyState: WebSocket.OPEN as number,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => undefined,
    addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  };
  const deliver = (message: unknown) => listeners.get('message')?.forEach((fn) => fn({ data: JSON.stringify(message) }));
  const provider = new TeamSyncProvider({
    serverUrl: 'ws://example.test',
    getJwt: async () => asTeamJwt('token'),
    orgId: 'org-1',
    teamMemberId: asTeamMemberId('user-1'),
    createWebSocket: () => socket as unknown as WebSocket,
  });
  await provider.connect();
  const changed = vi.fn();
  const unsubscribe = onTeamPageLinksChanged(changed);

  const link: PageLinkEntry = {
    source: { kind: 'item', itemId: 'item-sync' }, projectId: 'p', title: null,
    target: { kind: 'item', ref: 'NIM-1' }, rel: 'built-on', sentence: 'Sync is built on NIM-1.', count: 1,
  };
  const pending = provider.queryPageLinks({ projectId: 'p', to: [{ kind: 'item', ref: 'NIM-1' }] });
  const query = sent.find((message) => message.type === 'pageLinksQuery');
  expect(query).toMatchObject({ projectId: 'p', to: [{ kind: 'item', ref: 'NIM-1' }], requestId: expect.any(String) });
  deliver({ type: 'pageLinksResponse', requestId: 'someone-else', outgoing: [], incoming: [], status: 'ready' });
  deliver({ type: 'pageLinksResponse', requestId: query.requestId, outgoing: [], incoming: [link], status: 'partial' });
  await expect(pending).resolves.toEqual({ outgoing: [], incoming: [link], status: 'partial' });

  deliver({ type: 'pageLinksChanged' });
  expect(changed).toHaveBeenCalledTimes(1);

  socket.readyState = WebSocket.CLOSED;
  await expect(provider.queryPageLinks({ projectId: 'p' })).resolves.toBeNull();
  unsubscribe();
  provider.destroy();
});
