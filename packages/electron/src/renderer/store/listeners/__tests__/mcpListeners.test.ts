// @vitest-environment jsdom
/**
 * Central MCP listeners (NIM-2272 / GH #1089).
 *
 * The session-status channel fires between turns, not just during them, so it
 * has to be a startup subscription rather than anything tied to a component's
 * lifecycle — and it must land in the atom family keyed by the *event's*
 * session, since one window can host several sessions at once.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeSet = vi.fn();

vi.mock('@nimbalyst/runtime/store', () => ({
  store: { set: (...args: unknown[]) => storeSet(...args) },
}));

import { mcpSessionStatusAtomFamily, mcpTestProgressAtom } from '../../atoms/mcpStatus';
import { initMcpListeners } from '../mcpListeners';

type Handler = (data: any) => void;

function installFakeIpc() {
  const handlers = new Map<string, Handler>();
  const unsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
  (window as any).electronAPI = {
    on: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
      const unsubscribe = vi.fn();
      unsubscribes.set(channel, unsubscribe);
      return unsubscribe;
    },
  };
  return { handlers, unsubscribes };
}

describe('initMcpListeners', () => {
  beforeEach(() => {
    storeSet.mockReset();
  });

  it('routes a session status event into that session\'s atom', () => {
    const { handlers } = installFakeIpc();
    const dispose = initMcpListeners();

    const snapshot = {
      sessionId: 'session-b',
      supported: true,
      active: true,
      servers: [{ name: 'trackers', state: 'connected' as const }],
      lastCheckedAt: 1_700_000_000_000,
    };
    handlers.get('ai:mcp-status:changed')!(snapshot);

    expect(storeSet).toHaveBeenCalledWith(mcpSessionStatusAtomFamily('session-b'), snapshot);
    dispose();
  });

  it('ignores a malformed event rather than writing to an unkeyed atom', () => {
    const { handlers } = installFakeIpc();
    const dispose = initMcpListeners();

    handlers.get('ai:mcp-status:changed')!({ servers: [] });

    expect(storeSet).not.toHaveBeenCalled();
    dispose();
  });

  it('still wires the config test-progress channel', () => {
    const { handlers } = installFakeIpc();
    const dispose = initMcpListeners();

    handlers.get('mcp-config:test-progress')!({ status: 'ok', message: 'connected' });

    expect(storeSet).toHaveBeenCalledWith(
      mcpTestProgressAtom,
      expect.objectContaining({ status: 'ok', message: 'connected' }),
    );
    dispose();
  });

  it('unsubscribes both channels on dispose', () => {
    const { unsubscribes } = installFakeIpc();

    initMcpListeners()();

    expect(unsubscribes.get('mcp-config:test-progress')).toHaveBeenCalled();
    expect(unsubscribes.get('ai:mcp-status:changed')).toHaveBeenCalled();
  });
});
