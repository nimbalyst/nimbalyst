/**
 * Factory for creating AI provider instances
 */

import { AIProvider } from './AIProvider';
import { ClaudeProvider } from './providers/ClaudeProvider';
import { ClaudeCodeProvider } from './providers/ClaudeCodeProvider';
import { ClaudeCodeCliProvider } from './providers/ClaudeCodeCliProvider';
import { OpenAIProvider } from './providers/OpenAIProvider';
import { OpenAICodexProvider } from './providers/OpenAICodexProvider';
import { OpenAICodexACPProvider } from './providers/OpenAICodexACPProvider';
import { LMStudioProvider } from './providers/LMStudioProvider';
import { OpenCodeProvider } from './providers/OpenCodeProvider';
import { CopilotCLIProvider } from './providers/CopilotCLIProvider';
import { ExtensionAgentProvider } from './providers/ExtensionAgentProvider';
import { ProviderConfig, AIProviderType, assertExhaustiveProvider } from './types';

export class ProviderFactory {
  private static providers: Map<string, AIProvider> = new Map();
  private static providerOwners: Map<string, string> = new Map();
  // In-flight creation guards. When concurrent dispatch calls race on the same
  // session, the second caller must await the first caller's creation instead of
  // independently calling createProvider() and producing a duplicate subprocess.
  // See NIM-590 / _pending/nimbalyst_duplicate_resume_spawn_investigation.md.
  private static inFlightCreations: Map<string, Promise<AIProvider>> = new Map();

  /**
   * Get an existing AI provider instance
   * Returns null if provider doesn't exist
   */
  static getProvider(
    type: AIProviderType,
    sessionId: string
  ): AIProvider | null {
    const key = `${type}-${sessionId}`;
    const provider = this.providers.get(key) || null;
    // console.log(`[ProviderFactory] getProvider(${key}): ${provider ? 'found' : 'not found'}, map size: ${this.providers.size}`);
    // if (provider && type === 'claude-code') {
    //   const instanceId = (provider as any)._instanceId;
    //   const hasAbortController = !!(provider as any).abortController;
    //   console.log(`[ProviderFactory] claude-code provider state: instanceId=${instanceId}, hasAbortController=${hasAbortController}`);
    // }
    return provider;
  }
  
  /**
   * Create a new AI provider instance
   * Always creates a new provider, doesn't check cache
   */
  static createProvider(
    type: AIProviderType,
    sessionId: string
  ): AIProvider {
    const startTime = Date.now();
    const key = `${type}-${sessionId}`;
    // console.log(`[ProviderFactory] Creating new ${type} provider for session ${sessionId}`);

    // Create new provider based on type
    let provider: AIProvider;
    switch (type) {
      case 'claude':
        provider = new ClaudeProvider();
        break;
      case 'claude-code':
        // Use SDK version with dynamic loading
        provider = new ClaudeCodeProvider();
        break;
      case 'claude-code-cli':
        // Genuine `claude` CLI on the user's subscription (no API metering).
        provider = new ClaudeCodeCliProvider();
        break;
      case 'openai':
        provider = new OpenAIProvider();
        break;
      case 'openai-codex':
        provider = new OpenAICodexProvider();
        break;
      case 'openai-codex-acp':
        provider = new OpenAICodexACPProvider();
        break;
      case 'opencode':
        provider = new OpenCodeProvider();
        break;
      case 'lmstudio':
        provider = new LMStudioProvider();
        break;
      case 'copilot-cli':
        provider = new CopilotCLIProvider();
        break;
      default:
        assertExhaustiveProvider(type);
    }
    
    // Cache the provider
    this.providers.set(key, provider);
    this.providerOwners.set(key, sessionId);
    // console.log(`[ProviderFactory] Created ${type} provider in ${Date.now() - startTime}ms`);

    return provider;
  }

  /**
   * Create a provider instance with an in-flight-creation guard.
   *
   * If another caller is already creating a provider for this (type, sessionId)
   * pair, this method awaits that creation instead of producing a second,
   * independent instance. This closes the check-then-act race between
   * getProvider() and createProvider() that otherwise results in duplicate
   * claude.exe subprocesses for a single session.
   *
   * Callers that have already checked getProvider() and found null should call
   * this instead of the synchronous createProvider(). If the provider was cached
   * between the caller's getProvider() check and now (another caller finished
   * creating it), the cached instance is returned directly.
   */
  static async createProviderAsync(
    type: AIProviderType,
    sessionId: string
  ): Promise<AIProvider> {
    const key = `${type}-${sessionId}`;

    // If creation is already in flight for this key, await that promise.
    // This is the fix: instead of each caller independently calling
    // createProvider() and getting its own instance, concurrent callers
    // share one creation and receive the same provider.
    const inFlight = this.inFlightCreations.get(key);
    if (inFlight) return inFlight;

    // If the provider was cached between our caller's getProvider() check
    // and now (another caller finished creating it), return the cached
    // instance without creating a new one.
    const existing = this.providers.get(key);
    if (existing) return existing;

    // Wrap the synchronous createProvider in Promise.resolve() so we can
    // attach a .finally() cleanup that runs asynchronously (as a microtask).
    // This ordering is load-bearing: the in-flight entry MUST be stored
    // BEFORE the .finally() callback runs, otherwise the entry is deleted
    // before concurrent callers can find it. .finally() callbacks are always
    // scheduled as microtasks, even on already-resolved promises, so the
    // entry is safely stored on the next line before cleanup runs.
    //
    // If createProvider throws synchronously (e.g. unknown provider type),
    // the throw propagates before Promise.resolve() is reached — no stale
    // entry is left in the map.
    //
    // The .finally() cleanup below is identity-checked (only clears OUR OWN
    // entry): if destroyProvider() cleared this key and a new
    // createProviderAsync() call already stored a fresh in-flight promise for
    // the same key before this .finally() ran, deleting unconditionally would
    // remove that NEWER entry out from under it. Unreachable today because
    // createProvider() is synchronous (this promise is already resolved by
    // the time it's stored, so there's no live window), but this is a
    // zero-cost, zero-behavior-change guard against that ever becoming
    // reachable (e.g. if createProvider() is ever made async). Added during
    // NIM-590 pressure-test review (independently found by DeepSeek-Flash).
    const creationPromise = Promise.resolve(this.createProvider(type, sessionId))
      .finally(() => {
        if (this.inFlightCreations.get(key) === creationPromise) {
          this.inFlightCreations.delete(key);
        }
      });

    this.inFlightCreations.set(key, creationPromise);
    return creationPromise;
  }

  /**
   * Create a new extension-contributed agent provider.
   *
   * This is the 'extension-agent' branch of the factory: instead of a
   * built-in provider class, the implementation lives in a privileged
   * backend module spawned by `PrivilegedExtensionHost`. The returned
   * `ExtensionAgentProvider` is a thin wrapper that delegates every call
   * across the host-installed `ExtensionAgentBridge`.
   *
   * The wrapper does NOT eagerly start the backend module. The first
   * `initialize` call routes through the bridge, which looks up the
   * AgentProviderRegistry entry: if status is `registered`, the bridge
   * raises the first-use consent prompt and then calls
   * `PrivilegedExtensionHost.startModule(...)`; once `active`, the bridge
   * dispatches subsequent calls through the broker. This matches the
   * Phase 4 design's "lazy spawn on first use" requirement.
   *
   * Cache key is namespaced by `extension-agent:${extensionId}/${contributionId}-${sessionId}`
   * so it never collides with the built-in providers (whose keys start with
   * the AIProviderType string).
   */
  static createExtensionAgentProvider(args: {
    extensionId: string;
    contributionId: string;
    sessionId: string;
    model?: string;
  }): ExtensionAgentProvider {
    const key = `extension-agent:${args.extensionId}/${args.contributionId}-${args.sessionId}`;
    const provider = new ExtensionAgentProvider({
      extensionId: args.extensionId,
      contributionId: args.contributionId,
      sessionId: args.sessionId,
      model: args.model,
    });
    this.providers.set(key, provider);
    this.providerOwners.set(key, args.sessionId);
    return provider;
  }

  /**
   * Look up a previously created extension-agent provider. Mirrors
   * `getProvider` for the built-in branch so callers can resolve a turn
   * to its provider instance.
   */
  static getExtensionAgentProvider(args: {
    extensionId: string;
    contributionId: string;
    sessionId: string;
  }): ExtensionAgentProvider | null {
    const key = `extension-agent:${args.extensionId}/${args.contributionId}-${args.sessionId}`;
    const provider = this.providers.get(key);
    return (provider as ExtensionAgentProvider | undefined) ?? null;
  }

  /**
   * Clean up a provider instance
   */
  static destroyProvider(sessionId: string, type?: AIProviderType): void {
    if (type) {
      const key = `${type}-${sessionId}`;
      // Clean up any in-flight creation for this key so a subsequent
      // retry doesn't await a stale promise.
      this.inFlightCreations.delete(key);
      const provider = this.providers.get(key);
      if (provider) {
        this.destroyProviderEntry(key, provider);
      }
    } else {
      // Destroy all providers for this session
      for (const [key, provider] of [...this.providers.entries()]) {
        if (this.providerOwners.get(key) === sessionId) {
          this.inFlightCreations.delete(key);
          this.destroyProviderEntry(key, provider);
        }
      }
    }
  }

  private static destroyProviderEntry(key: string, provider: AIProvider): void {
    try {
      provider.destroy();
    } catch (error) {
      console.error(`[ProviderFactory] Error destroying provider ${key}:`, error);
    } finally {
      // Never retain a failed provider handle. Reusing a half-destroyed
      // instance is more dangerous than recreating it on the next turn.
      this.providers.delete(key);
      this.providerOwners.delete(key);
    }
  }

  /**
   * Clean up all provider instances
   */
  static destroyAll(): void {
    // Clean up in-flight creations — nothing should be awaiting these
    // after a full teardown.
    this.inFlightCreations.clear();

    // console.log(`[ProviderFactory] Destroying ${this.providers.size} providers`);

    // Try to destroy each provider individually with error handling
    for (const [key, provider] of [...this.providers.entries()]) {
      // console.log(`[ProviderFactory] Destroying provider: ${key}`);
      this.destroyProviderEntry(key, provider);
    }
    
    // Clear the map even if some providers failed to destroy
    try {
      this.providers.clear();
      this.providerOwners.clear();
    } catch (error) {
      console.error('[ProviderFactory] Error clearing providers map:', error);
    }
  }
}
