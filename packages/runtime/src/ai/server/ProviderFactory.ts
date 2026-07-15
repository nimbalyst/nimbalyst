/**
 * Factory for creating AI provider instances
 */

import { AIProvider } from './AIProvider';
import { ClaudeProvider } from './providers/ClaudeProvider';
import { ClaudeCodeProvider } from './providers/ClaudeCodeProvider';
import { ClaudeCodeCliProvider } from './providers/ClaudeCodeCliProvider';
import { OpenAIProvider } from './providers/OpenAIProvider';
import { MiniMaxProvider } from './providers/MiniMaxProvider';
import { OpenAICodexProvider } from './providers/OpenAICodexProvider';
import { OpenAICodexACPProvider } from './providers/OpenAICodexACPProvider';
import { LMStudioProvider } from './providers/LMStudioProvider';
import { OpenCodeProvider } from './providers/OpenCodeProvider';
import { CopilotCLIProvider } from './providers/CopilotCLIProvider';
import { ExtensionAgentProvider } from './providers/ExtensionAgentProvider';
import { ProviderConfig, AIProviderType, assertExhaustiveProvider } from './types';

export class ProviderFactory {
  private static providers: Map<string, AIProvider> = new Map();

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
      case 'minimax':
        provider = new MiniMaxProvider();
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
    // console.log(`[ProviderFactory] Created ${type} provider in ${Date.now() - startTime}ms`);

    return provider;
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
      const provider = this.providers.get(key);
      if (provider) {
        provider.destroy();
        this.providers.delete(key);
      }
    } else {
      // Destroy all providers for this session
      for (const [key, provider] of this.providers.entries()) {
        if (key.endsWith(`-${sessionId}`)) {
          provider.destroy();
          this.providers.delete(key);
        }
      }
    }
  }

  /**
   * Clean up all provider instances
   */
  static destroyAll(): void {
    // console.log(`[ProviderFactory] Destroying ${this.providers.size} providers`);

    // Try to destroy each provider individually with error handling
    for (const [key, provider] of this.providers.entries()) {
      try {
        // console.log(`[ProviderFactory] Destroying provider: ${key}`);
        provider.destroy();
      } catch (error) {
        console.error(`[ProviderFactory] Error destroying provider ${key}:`, error);
        // Continue destroying other providers
      }
    }
    
    // Clear the map even if some providers failed to destroy
    try {
      this.providers.clear();
    } catch (error) {
      console.error('[ProviderFactory] Error clearing providers map:', error);
    }
  }
}
