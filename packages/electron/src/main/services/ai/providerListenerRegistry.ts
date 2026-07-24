type ProviderEventListener = (...args: any[]) => void;

type ScopedProvider = {
  on(event: string, listener: ProviderEventListener): unknown;
  off(event: string, listener: ProviderEventListener): unknown;
};

export type ProviderListenerRegistry<TProvider extends ScopedProvider> = WeakMap<
  TProvider,
  Map<string, ProviderEventListener>
>;

export function installScopedProviderListener<TProvider extends ScopedProvider>(
  registry: ProviderListenerRegistry<TProvider>,
  provider: TProvider,
  event: string,
  listener: ProviderEventListener,
): void {
  let listeners = registry.get(provider);
  if (!listeners) {
    listeners = new Map<string, ProviderEventListener>();
    registry.set(provider, listeners);
  }

  const previous = listeners.get(event);
  if (previous) {
    provider.off(event, previous);
  }

  listeners.set(event, listener);
  provider.on(event, listener);
}
