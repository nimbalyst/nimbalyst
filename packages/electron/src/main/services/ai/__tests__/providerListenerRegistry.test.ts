import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import {
  installScopedProviderListener,
  type ProviderListenerRegistry,
} from '../providerListenerRegistry';

describe('installScopedProviderListener', () => {
  it('replaces only the tracked listener and preserves external subscribers', () => {
    const provider = new EventEmitter();
    const registry: ProviderListenerRegistry<EventEmitter> = new WeakMap();
    const externalListener = vi.fn();
    const firstHandlerListener = vi.fn();
    const secondHandlerListener = vi.fn();

    provider.on('exitPlanMode:resolved', externalListener);

    installScopedProviderListener(
      registry,
      provider,
      'exitPlanMode:resolved',
      firstHandlerListener,
    );
    installScopedProviderListener(
      registry,
      provider,
      'exitPlanMode:resolved',
      secondHandlerListener,
    );

    provider.emit('exitPlanMode:resolved', { requestId: 'req-1' });

    expect(firstHandlerListener).not.toHaveBeenCalled();
    expect(secondHandlerListener).toHaveBeenCalledTimes(1);
    expect(externalListener).toHaveBeenCalledTimes(1);
    expect(provider.listenerCount('exitPlanMode:resolved')).toBe(2);
  });
});
