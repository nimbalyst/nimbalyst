/**
 * Shared session ID management for agent-style AI providers.
 *
 * Both ClaudeCodeProvider and OpenAICodexProvider need the same fundamental
 * pieces: mapping Nimbalyst session IDs to provider-specific session IDs
 * (Claude SDK session ID, Codex thread ID), persisting them via events,
 * and restoring them from the database on resume.
 *
 * This module follows the same composition pattern as ProviderPermissionMixin:
 * providers instantiate it as a field and delegate session ID operations to it.
 *
 * Usage:
 *   private readonly sessions = new ProviderSessionManager({
 *     emit: this.emit.bind(this),
 *   });
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderSessionManagerOptions {
  /**
   * Function to emit events on the owning provider's EventEmitter.
   * Providers pass `this.emit.bind(this)` at construction time.
   */
  emit: (event: string, data: unknown) => boolean;
}

/**
 * Standardized payload shape for setProviderSessionData / getProviderSessionData.
 * The `providerSessionId` field is the canonical key. Legacy keys are accepted
 * on input for backward compatibility but only `providerSessionId` is stored.
 */
export interface ProviderSessionData {
  providerSessionId?: string;
  /** @deprecated Use providerSessionId. Accepted on input for backward compat. */
  claudeSessionId?: string;
  /** @deprecated Use providerSessionId. Accepted on input for backward compat. */
  codexThreadId?: string;
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class ProviderSessionManager {
  private readonly sessionIds: Map<string, string> = new Map();
  private readonly emitEvent: (event: string, data: unknown) => boolean;

  constructor(options: ProviderSessionManagerOptions) {
    this.emitEvent = options.emit;
  }

  /**
   * Store a provider session ID and emit `session:providerSessionReceived`.
   *
   * Idempotent: if the sessionId already maps to the same providerSessionId,
   * no event is emitted.  If the value differs, it is updated and the event
   * fires.
   */
  captureSessionId(sessionId: string, providerSessionId: string): void {
    if (this.sessionIds.get(sessionId) === providerSessionId) {
      return;
    }
    this.sessionIds.set(sessionId, providerSessionId);
    this.emitEvent('session:providerSessionReceived', {
      sessionId,
      providerSessionId,
    });
  }

  /**
   * Get the stored provider session ID for a Nimbalyst session, or undefined.
   */
  getSessionId(sessionId: string): string | undefined {
    return this.sessionIds.get(sessionId);
  }

  /**
   * Check if a mapping exists for the given session.
   */
  hasSession(sessionId: string): boolean {
    return this.sessionIds.has(sessionId);
  }

  /**
   * Remove a session mapping.  Does NOT emit any event.
   * Used for local cleanup (e.g., session deletion, error recovery).
   */
  deleteSession(sessionId: string): void {
    this.sessionIds.delete(sessionId);
  }

  /**
   * Remove a session mapping AND emit `session:providerSessionExpired`.
   * Used when a provider detects the remote session is no longer valid.
   *
   * Always emits the event even if no local mapping exists, because the
   * database may still have a stale providerSessionId that needs clearing.
   */
  expireSession(sessionId: string): void {
    this.sessionIds.delete(sessionId);
    this.emitEvent('session:providerSessionExpired', { sessionId });
  }

  /**
   * Restore a provider session ID from the database.
   *
   * Called by AIService when loading a session for resumption. Accepts the
   * backward-compatible payload shape `{ providerSessionId, claudeSessionId,
   * codexThreadId }` and extracts the first truthy string value.
   *
   * Does NOT emit `session:providerSessionReceived` -- this is a restore
   * from the database, not a new capture.  Emitting would cause a
   * persistence loop (AIService restores -> event -> AIService re-persists).
   */
  setProviderSessionData(sessionId: string, data: ProviderSessionData): void {
    const id =
      data?.providerSessionId ??
      data?.claudeSessionId ??
      data?.codexThreadId;
    if (typeof id === 'string' && id) {
      this.sessionIds.set(sessionId, id);
    }
  }

  /**
   * Return the canonical session data shape.
   *
   * Providers wrap this to add their own legacy keys (e.g., `claudeSessionId`,
   * `codexThreadId`) for backward compat with AIService.
   */
  getProviderSessionData(sessionId: string): { providerSessionId: string | undefined } {
    return {
      providerSessionId: this.sessionIds.get(sessionId),
    };
  }

  /**
   * Clear all stored session mappings.
   */
  clear(): void {
    this.sessionIds.clear();
  }

  /**
   * Number of stored sessions (for testing/debugging).
   */
  get size(): number {
    return this.sessionIds.size;
  }
}
