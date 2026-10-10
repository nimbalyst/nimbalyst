// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '../../auth/jwtScopes';
import { TeamSyncProvider } from '../TeamSync';
import { onTeamPageMarksChanged } from '../teamPageMarks';
import type { PageMarkEntry } from '@nimbalyst/collab-protocol';

function fakeSocket(readyState: number) {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const sent: any[] = [];
  return {
    sent,
    socket: {
      readyState,
      send: (data: string) => sent.push(JSON.parse(data)),
      close: () => undefined,
      addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    },
    deliver: (message: unknown) => listeners.get('message')?.forEach((fn) => fn({ data: JSON.stringify(message) })),
    open: () => listeners.get('open')?.forEach((fn) => fn({})),
  };
}

async function connected(readyState: number = WebSocket.OPEN) {
  const fake = fakeSocket(readyState);
  const provider = new TeamSyncProvider({
    serverUrl: 'ws://example.test',
    getJwt: async () => asTeamJwt('token'),
    orgId: 'org-1',
    teamMemberId: asTeamMemberId('user-1'),
    createWebSocket: () => fake.socket as unknown as WebSocket,
  });
  await provider.connect();
  return { provider, ...fake };
}

const mark: PageMarkEntry = {
  documentId: 'page-1', projectId: 'p', title: 'Specs', kind: 'open', text: 'Why?', plainText: 'Why?',
  by: null, email: null, on: null, over: null, line: 1, offset: 0,
};

describe('TeamSyncProvider page marks', () => {
  it('answers each query with the response carrying its request id', async () => {
    const { provider, sent, deliver } = await connected();
    const pending = provider.queryPageMarks({ kind: 'open' });
    const query = sent.find((message) => message.type === 'pageMarksQuery');
    expect(query).toMatchObject({ type: 'pageMarksQuery', kind: 'open', requestId: expect.any(String) });

    deliver({ type: 'pageMarksResponse', requestId: 'someone-else', marks: [], status: 'ready' });
    deliver({ type: 'pageMarksResponse', requestId: query.requestId, marks: [mark], status: 'partial' });
    await expect(pending).resolves.toEqual({ marks: [mark], status: 'partial' });
    provider.destroy();
  });

  it('answers null at once while offline, and null when the server never replies', async () => {
    const offline = await connected(WebSocket.CONNECTING);
    await expect(offline.provider.queryPageMarks({})).resolves.toBeNull();
    expect(offline.sent.filter((message) => message.type === 'pageMarksQuery')).toEqual([]);
    offline.provider.destroy();

    const silent = await connected();
    await expect(silent.provider.queryPageMarks({}, 20)).resolves.toBeNull();
    silent.provider.destroy();
  });

  it('tells marks lists to ask again when the server says marks changed and when the socket (re)opens', async () => {
    const { provider, deliver, open } = await connected();
    const changed = vi.fn();
    const unsubscribe = onTeamPageMarksChanged(changed);
    deliver({ type: 'pageMarksChanged' });
    expect(changed).toHaveBeenCalledTimes(1);
    open();
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
    provider.destroy();
  });
});
