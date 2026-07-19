/**
 * Shared permission infrastructure for agent-style AI providers.
 *
 * Both ClaudeCodeProvider and OpenAICodexProvider need the same fundamental
 * pieces: trust checking, pattern-based permission persistence, security
 * logging, and pending-permission request/response management.
 *
 * This module provides:
 * - Shared TypeScript types used across providers
 * - A mixin class (`ProviderPermissionMixin`) that provides the instance-
 *   level permission management (pending requests, session cache, resolve/
 *   reject lifecycle) without dictating the static injection surface.
 *
 * Providers extend this mixin (or apply it to their class) and wire the
 * static setters themselves, since each provider class needs its own static
 * property to avoid cross-provider leakage.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type PermissionMode = 'ask' | 'allow-all' | 'bypass-all' | null;
export type ToolPermissionScope = 'once' | 'session' | 'always' | 'always-all';

export interface PermissionDecision {
  decision: 'allow' | 'deny';
  scope: ToolPermissionScope;
}

export interface PendingPermission {
  resolve: (response: PermissionDecision) => void;
  reject: (error: Error) => void;
  request: unknown;
}

export type TrustChecker = (
  workspacePath: string
) => {
  trusted: boolean;
  mode: PermissionMode;
  /**
   * Opt-in flag (issue #628): when true, "Allow All" (bypass-all) workspaces
   * route agent-mode Claude Code sessions through the SDK auto-mode classifier.
   * Defaults to off so "Allow All" stays literal allow-all.
   */
  allowAllUsesClassifier?: boolean;
};

export type PermissionPatternSaver = (
  workspacePath: string,
  pattern: string
) => Promise<void>;

export type PermissionPatternChecker = (
  workspacePath: string,
  pattern: string
) => Promise<boolean>;

export type SecurityLogger = (message: string, data?: unknown) => void;

// ---------------------------------------------------------------------------
// Mixin class
// ---------------------------------------------------------------------------

/**
 * Mixin that manages pending permission requests and a session-level
 * approved-pattern cache.
 *
 * Providers that extend `BaseAIProvider` should also extend or apply this
 * mixin to get the shared resolve/reject/rejectAll lifecycle plus the
 * session pattern cache.
 *
 * Static injection points (trustChecker, patternSaver, etc.) are NOT part
 * of the mixin because static state must live on each concrete class to
 * avoid cross-provider contamination.
 */
export class ProviderPermissionMixin {
  readonly pendingToolPermissions: Map<string, PendingPermission> = new Map();
  readonly sessionApprovedPatterns: Set<string> = new Set();

  resolveToolPermission(
    requestId: string,
    response: PermissionDecision,
    onPersist?: (requestId: string, response: PermissionDecision, respondedBy: 'desktop' | 'mobile' | 'telegram') => void,
    respondedBy: 'desktop' | 'mobile' | 'telegram' = 'desktop'
  ): void {
    const pending = this.pendingToolPermissions.get(requestId);
    if (pending) {
      pending.resolve(response);
      this.pendingToolPermissions.delete(requestId);
      onPersist?.(requestId, response, respondedBy);
    } else {
      console.warn(`[ProviderPermission] No pending permission found for requestId: ${requestId}`);
    }
  }

  rejectToolPermission(
    requestId: string,
    error: Error,
    onPersist?: (requestId: string) => void
  ): void {
    const pending = this.pendingToolPermissions.get(requestId);
    if (pending) {
      pending.reject(error);
      this.pendingToolPermissions.delete(requestId);
      onPersist?.(requestId);
    }
  }

  rejectAllPendingPermissions(): void {
    for (const [, pending] of this.pendingToolPermissions) {
      pending.reject(new Error('Request aborted'));
    }
    this.pendingToolPermissions.clear();
  }

  clearSessionCache(): void {
    this.sessionApprovedPatterns.clear();
  }
}
