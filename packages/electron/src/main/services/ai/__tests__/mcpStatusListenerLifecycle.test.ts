/**
 * Turn-boundary survival for the MCP status push listener (NIM-2272).
 *
 * The provider's MCP health poll runs *between* turns as well as during them —
 * `mcpQuery` outlives `leadQuery` specifically so it can. So the listener that
 * forwards `mcpServerStatus:changed` to the renderer has to stay wired after a
 * turn ends and must not accumulate a duplicate on the next turn.
 *
 * This exercises the same `installScopedProviderListener` contract
 * MessageStreamingHandler.handle() uses, on a real EventEmitter, so a change to
 * either side (a switch back to `removeAllListeners`, or a per-turn listener
 * that unsubscribes on turn end) fails here.
 */

import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import { installScopedProviderListener, type ProviderListenerRegistry } from '../providerListenerRegistry';

const EVENT = 'mcpServerStatus:changed';

class FakeProvider extends EventEmitter {}

describe('MCP status listener lifecycle', () => {
  it('keeps delivering status changes after a turn ends', () => {
    const registry: ProviderListenerRegistry<FakeProvider> = new WeakMap();
    const provider = new FakeProvider();
    const received: unknown[] = [];

    // Turn 1 installs the forwarder.
    installScopedProviderListener(registry, provider, EVENT, (payload) => received.push(payload));

    // Turn ends. leadQuery is nulled, but mcpQuery lives on and the 30s poll
    // fires between turns.
    provider.emit(EVENT, { sessionId: 's1', servers: [], changes: [] });

    expect(received).toHaveLength(1);
  });

  it('replaces rather than stacks the forwarder across turns', () => {
    const registry: ProviderListenerRegistry<FakeProvider> = new WeakMap();
    const provider = new FakeProvider();
    const forward = vi.fn();

    // Three turns against the same cached per-session provider.
    installScopedProviderListener(registry, provider, EVENT, forward);
    installScopedProviderListener(registry, provider, EVENT, forward);
    installScopedProviderListener(registry, provider, EVENT, forward);

    provider.emit(EVENT, { sessionId: 's1' });

    expect(forward).toHaveBeenCalledTimes(1);
    expect(provider.listenerCount(EVENT)).toBe(1);
  });

  it('leaves other modules\' subscriptions on the same provider wired', () => {
    const registry: ProviderListenerRegistry<FakeProvider> = new WeakMap();
    const provider = new FakeProvider();
    const otherModule = vi.fn();
    provider.on(EVENT, otherModule);

    installScopedProviderListener(registry, provider, EVENT, vi.fn());
    installScopedProviderListener(registry, provider, EVENT, vi.fn());

    provider.emit(EVENT, { sessionId: 's1' });

    expect(otherModule).toHaveBeenCalledTimes(1);
  });
});
