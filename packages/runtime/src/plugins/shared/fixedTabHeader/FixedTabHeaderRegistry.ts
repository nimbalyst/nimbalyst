import type { FixedTabHeaderProvider, TabContext } from './types';

type ChangeListener = () => void;

export class FixedTabHeaderRegistry {
  private static instance: FixedTabHeaderRegistry;
  private providers: Map<string, FixedTabHeaderProvider> = new Map();
  private listeners: Set<ChangeListener> = new Set();

  private constructor() {}

  static getInstance(): FixedTabHeaderRegistry {
    if (!FixedTabHeaderRegistry.instance) {
      FixedTabHeaderRegistry.instance = new FixedTabHeaderRegistry();
    }
    return FixedTabHeaderRegistry.instance;
  }

  register(provider: FixedTabHeaderProvider): void {
    this.providers.set(provider.id, provider);
    this.notifyChange();
  }

  unregister(id: string): void {
    this.providers.delete(id);
    this.notifyChange();
  }

  getProviders(context: TabContext): FixedTabHeaderProvider[] {
    const activeProviders = Array.from(this.providers.values())
      .filter(provider => provider.shouldRender(context))
      .sort((a, b) => b.priority - a.priority);

    return activeProviders;
  }

  clear(): void {
    this.providers.clear();
    this.notifyChange();
  }

  // Notify that providers should be re-evaluated (e.g., when diffs appear/disappear)
  notifyChange(): void {
    this.listeners.forEach(listener => listener());
  }

  addChangeListener(listener: ChangeListener): void {
    this.listeners.add(listener);
  }

  removeChangeListener(listener: ChangeListener): void {
    this.listeners.delete(listener);
  }
}
