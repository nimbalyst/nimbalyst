/**
 * Voice Context Provider Registry (Core hook 2)
 *
 * A general registry where extensions register providers that contribute text to
 * the voice agent's session context at session start (e.g. top-N grounding
 * facts). It lives on the renderer side (extension code runs in the renderer);
 * the main-process VoiceModeService requests the concatenated, capped output over
 * IPC when a voice session begins and appends it to the voice agent's context.
 *
 * Providers are run with a per-provider character cap and an overall total cap so
 * a misbehaving provider can't blow out the (expensive) Realtime context window.
 */

import type { Disposable, VoiceContextProvider, VoiceContextProviderInput } from './types';

interface RegistryEntry {
  provider: VoiceContextProvider;
  extensionId?: string;
}

// Keyed by a composite of extensionId + provider.id so two extensions can use
// the same provider id without colliding.
const registry = new Map<string, RegistryEntry>();

const DEFAULT_PER_PROVIDER_CHARS = 2000;
const DEFAULT_TOTAL_CHARS = 6000;

function keyFor(extensionId: string | undefined, providerId: string): string {
  return `${extensionId ?? 'unknown'}::${providerId}`;
}

/**
 * Register a voice context provider. Returns a Disposable that unregisters it.
 * `extensionId` namespaces the provider so unload can remove all of an
 * extension's providers.
 */
export function registerVoiceContextProvider(
  provider: VoiceContextProvider,
  extensionId?: string
): Disposable {
  const key = keyFor(extensionId, provider.id);
  registry.set(key, { provider, extensionId });
  return {
    dispose: () => {
      registry.delete(key);
    },
  };
}

/** Remove all voice context providers registered by a given extension. */
export function unregisterVoiceContextProvidersForExtension(extensionId: string): void {
  for (const [key, entry] of registry) {
    if (entry.extensionId === extensionId) {
      registry.delete(key);
    }
  }
}

export interface CollectVoiceContextOptions {
  /** Max characters kept from each provider. Default 2000. */
  perProviderChars?: number;
  /** Max characters across all providers combined. Default 6000. */
  totalChars?: number;
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '… (truncated)';
}

/**
 * Run every registered provider (highest priority first), cap each output, and
 * join them into a single context block. Provider failures are isolated -- one
 * throwing provider does not drop the others.
 */
export async function collectVoiceSessionContext(
  input: VoiceContextProviderInput,
  options: CollectVoiceContextOptions = {}
): Promise<string> {
  const perProvider = options.perProviderChars ?? DEFAULT_PER_PROVIDER_CHARS;
  const total = options.totalChars ?? DEFAULT_TOTAL_CHARS;

  const entries = Array.from(registry.values()).sort(
    (a, b) => (b.provider.priority ?? 0) - (a.provider.priority ?? 0)
  );

  const parts: string[] = [];
  for (const { provider } of entries) {
    try {
      const out = await provider.provideContext(input);
      if (typeof out === 'string' && out.trim().length > 0) {
        parts.push(cap(out.trim(), perProvider));
      }
    } catch (error) {
      // Isolate provider failures -- never let one provider break voice startup.
      console.error(`[VoiceContextProviderRegistry] Provider "${provider.id}" failed:`, error);
    }
  }

  return cap(parts.join('\n\n'), total);
}

/** Test-only: clear all registered providers. */
export function _clearVoiceContextProvidersForTest(): void {
  registry.clear();
}
