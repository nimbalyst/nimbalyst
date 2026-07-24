/**
 * ExtensionAgentProvider
 *
 * Thin runtime-side wrapper for an extension-contributed agent provider.
 *
 * The actual `AgentProtocol` implementation lives in a privileged backend
 * module spawned by `PrivilegedExtensionHost` (electron main). Runtime
 * code cannot import from main, so this wrapper holds only the routing
 * metadata (`extensionId` + `contributionId`) and delegates every method
 * to a host bridge that the electron main process installs at startup
 * via `setExtensionAgentBridge`.
 *
 * Two-step lifecycle:
 *   1. `ProviderFactory.createExtensionAgentProvider({ extensionId,
 *      contributionId, sessionId })` constructs the wrapper and caches it.
 *   2. The first `initialize` / `sendMessage` call routes through the
 *      installed bridge, which:
 *        - looks up the AgentProviderRegistry entry,
 *        - if status is `registered`, raises consent + calls
 *          `PrivilegedExtensionHost.startModule(...)`,
 *        - if status is `active`, dispatches the call across the
 *          extensionBackendBootstrap broker.
 *
 * The bridge is the single point of contact with electron main. By
 * keeping the wrapper passive we avoid a circular dependency (runtime ->
 * main) and keep the broker's lifecycle owned by main.
 */

import { EventEmitter } from 'events';
import type { AIProvider } from '../AIProvider';
import type {
  ProviderConfig,
  ProviderCapabilities,
  DocumentContext,
  StreamChunk,
  ToolHandler,
  ChatAttachment,
  Message,
  AgentToolDefinition,
} from '../types';

/**
 * Host bridge contract. The electron main process installs an
 * implementation that knows how to:
 *   - look up the AgentProviderRegistry entry for an
 *     `${extensionId}/${contributionId}` key,
 *   - drive the consent + `startModule` flow if the entry is still
 *     `registered`,
 *   - route runtime calls (sendMessage, abort, destroy) across the
 *     extensionBackendBootstrap broker once the module is `active`.
 *
 * The bridge is intentionally async on every method: even "synchronous"
 * provider hooks (capabilities, abort) become at-most-one round-trip to
 * the privileged runtime.
 */
export interface ExtensionAgentBridge {
  initialize(args: {
    extensionId: string;
    contributionId: string;
    sessionId: string;
    config: ProviderConfig;
  }): Promise<void>;

  sendMessage(args: {
    extensionId: string;
    contributionId: string;
    sessionId: string;
    message: string;
    /** Full model id (e.g. "antigravity-gemini-agent:gemini-3-flash-agent") so the bridge can createSession with the picked variant. */
    model?: string;
    documentContext?: DocumentContext;
    messages?: Message[];
    workspacePath?: string;
    attachments?: ChatAttachment[];
    /**
     * Optional OpenAI-shaped tool definitions for this turn. The bridge
     * forwards them into the backend session so its tool loop can present
     * them. Additive — absent for built-in providers.
     */
    tools?: AgentToolDefinition[];
    /**
     * Optional system-prompt override for this turn. The bridge forwards it
     * to the backend, which prepends it as the baseSystemPrompt ahead of the
     * tool-envelope block. Used to deliver the meta-agent persona to
     * extension agents (gemini-antigravity) the same way built-in providers
     * receive it over the SDK system prompt. Additive — absent for normal
     * (non-meta-agent) extension sessions, so their behavior is unchanged.
     */
    systemPrompt?: string;
  }): AsyncIterableIterator<StreamChunk>;

  abort(args: {
    extensionId: string;
    contributionId: string;
    sessionId: string;
  }): void;

  destroy(args: {
    extensionId: string;
    contributionId: string;
    sessionId: string;
  }): void;

  getCapabilities(args: {
    extensionId: string;
    contributionId: string;
  }): ProviderCapabilities;
}

let installedBridge: ExtensionAgentBridge | null = null;

/**
 * Called from electron main during startup to wire the bridge. Must be
 * invoked before any extension-agent session is created. Calling twice
 * replaces the prior bridge (useful for hot-reload in dev).
 */
export function setExtensionAgentBridge(bridge: ExtensionAgentBridge | null): void {
  installedBridge = bridge;
}

function requireBridge(): ExtensionAgentBridge {
  if (!installedBridge) {
    throw new Error(
      '[ExtensionAgentProvider] No bridge installed. The electron main process ' +
        'must call setExtensionAgentBridge() before any extension-agent provider ' +
        'is used.'
    );
  }
  return installedBridge;
}

export interface ExtensionAgentProviderOptions {
  extensionId: string;
  contributionId: string;
  sessionId: string;
  /** Full model id for this session; threaded to the bridge so the backend session is created with the picked variant. */
  model?: string;
}

export class ExtensionAgentProvider extends EventEmitter implements AIProvider {
  readonly extensionId: string;
  readonly contributionId: string;
  readonly sessionId: string;
  readonly model?: string;

  constructor(opts: ExtensionAgentProviderOptions) {
    super();
    this.extensionId = opts.extensionId;
    this.contributionId = opts.contributionId;
    this.sessionId = opts.sessionId;
    this.model = opts.model;
  }

  async initialize(config: ProviderConfig): Promise<void> {
    await requireBridge().initialize({
      extensionId: this.extensionId,
      contributionId: this.contributionId,
      sessionId: this.sessionId,
      config,
    });
  }

  sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: Message[],
    workspacePath?: string,
    attachments?: ChatAttachment[],
    tools?: AgentToolDefinition[],
    systemPrompt?: string
  ): AsyncIterableIterator<StreamChunk> {
    return requireBridge().sendMessage({
      extensionId: this.extensionId,
      contributionId: this.contributionId,
      // The session id passed on each turn wins over the constructor's --
      // matches the existing contract used by ClaudeCodeProvider, which
      // updates its session id mid-stream when the SDK rotates it.
      sessionId: sessionId ?? this.sessionId,
      message,
      model: this.model,
      documentContext,
      messages,
      workspacePath,
      attachments,
      tools,
      systemPrompt,
    });
  }

  abort(): void {
    requireBridge().abort({
      extensionId: this.extensionId,
      contributionId: this.contributionId,
      sessionId: this.sessionId,
    });
  }

  /**
   * Default implementation matching `AIProvider`'s contract: providers
   * that don't support true mid-stream interrupt fall back to `abort()`
   * and report `method: 'abort'`. Extensions that want mid-stream
   * interrupt can route through their broker; that's a Phase 5 concern
   * and not wired in this commit.
   */
  async interruptCurrentTurn(): Promise<{ method: 'interrupt' | 'abort' }> {
    this.abort();
    return { method: 'abort' };
  }

  getCapabilities(): ProviderCapabilities {
    return requireBridge().getCapabilities({
      extensionId: this.extensionId,
      contributionId: this.contributionId,
    });
  }

  registerToolHandler(handler: ToolHandler): void {
    // Tool handling for extension agents flows through the broker (the
    // backend module's tool-use loop calls back via brokerRequest to the
    // host). The runtime-side handler isn't consulted; we keep the method
    // so the wrapper satisfies `AIProvider` and so future per-session tool
    // gating can hook in here without a signature change.
    void handler;
  }

  destroy(): void {
    requireBridge().destroy({
      extensionId: this.extensionId,
      contributionId: this.contributionId,
      sessionId: this.sessionId,
    });
    this.removeAllListeners();
  }
}
