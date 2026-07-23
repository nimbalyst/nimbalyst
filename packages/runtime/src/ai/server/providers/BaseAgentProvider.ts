/**
 * Base class for agent-style AI providers (Claude Code, OpenAI Codex)
 *
 * This intermediate class sits between BaseAIProvider and concrete agent implementations,
 * consolidating shared infrastructure that all agent providers need:
 * - Abort controller management
 * - Session ID mapping (Nimbalyst session ID <-> provider session ID)
 * - Permission management (pending requests, session cache, resolve/reject lifecycle)
 * - Permission response polling (for cross-device and mobile support)
 * - Security logging
 * - Best-effort message logging
 * - Static injection points for trust checking, pattern persistence, etc.
 */

import { BaseAIProvider } from '../AIProvider';
import { ProviderCapabilities } from '../types';
import { AISessionsRepository } from '../../../storage/repositories/AISessionsRepository';
import type { MetaAgentWorkflowPreset } from '../../prompt';
import {
  ProviderPermissionMixin,
  PermissionDecision,
  TrustChecker,
  PermissionPatternSaver,
  PermissionPatternChecker,
  SecurityLogger
} from './ProviderPermissionMixin';
import { ProviderSessionManager, ProviderSessionData } from './ProviderSessionManager';
import { AgentMessagesRepository } from '../../../storage/repositories/AgentMessagesRepository';

export abstract class BaseAgentProvider extends BaseAIProvider {
  // Tools auto-allowed for the meta-agent profile. Child-session orchestration
  // (meta-agent) + session-context reads live on the deferred `nimbalyst-host`
  // server; update_session_meta + display glue on the eager core `nimbalyst`.
  // spawn_session is deliberately omitted (it reparents the child out of the
  // meta-agent group — see metaAgentServer EXTENSION_META_AGENT_ALLOWED_TOOLS).
  protected static readonly META_AGENT_ALLOWED_TOOLS: string[] = [
    'mcp__nimbalyst-host__list_spawned_sessions',
    'mcp__nimbalyst-host__list_worktrees',
    'mcp__nimbalyst-host__create_session',
    'mcp__nimbalyst-host__get_session_status',
    'mcp__nimbalyst-host__get_session_result',
    'mcp__nimbalyst-host__list_queued_prompts',
    'mcp__nimbalyst-host__send_prompt',
    'mcp__nimbalyst-host__send_prompt_now',
    'mcp__nimbalyst-host__notify_user',
    'mcp__nimbalyst-host__respond_to_prompt',
    'mcp__nimbalyst-host__get_session_summary',
    'mcp__nimbalyst-host__get_workstream_overview',
    'mcp__nimbalyst-host__list_recent_sessions',
    'mcp__nimbalyst-host__get_workstream_edited_files',
    'mcp__nimbalyst__update_session_meta',
    'mcp__nimbalyst__capture_editor_screenshot',
    'mcp__nimbalyst__display_to_user',
    'mcp__nimbalyst-situational__voice_agent_speak',
    'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
    'TodoRead', 'TodoWrite',
  ];

  // Abort management
  protected abortController: AbortController | null = null;

  // Session management
  protected readonly sessions: ProviderSessionManager;

  // Permission management
  protected readonly permissions: ProviderPermissionMixin;

  // Shared static injections - set once at app startup by Electron main process
  protected static trustChecker: TrustChecker | null = null;
  protected static permissionPatternSaver: PermissionPatternSaver | null = null;
  protected static permissionPatternChecker: PermissionPatternChecker | null = null;
  protected static securityLogger: SecurityLogger | null = null;

  constructor() {
    super();
    this.sessions = new ProviderSessionManager({ emit: this.emit.bind(this) });
    this.permissions = new ProviderPermissionMixin();
  }

  /**
   * Get the provider name for logging and identification
   */
  abstract getProviderName(): string;

  /**
   * Shared abort implementation - subclasses can override to add provider-specific cleanup
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.permissions.rejectAllPendingPermissions();
  }

  /**
   * Shared destroy implementation - subclasses can override to add provider-specific cleanup
   */
  destroy(): void {
    this.abort();
    this.sessions.clear();
    this.permissions.clearSessionCache();
    super.destroy();
  }

  /**
   * Set provider-specific session data
   */
  setProviderSessionData(sessionId: string, data: ProviderSessionData): void {
    this.sessions.setProviderSessionData(sessionId, data);
  }

  /**
   * Get provider-specific session data
   * Subclasses should override this for backward-compatible legacy key mapping
   */
  abstract getProviderSessionData(sessionId: string): ProviderSessionData | null;

  /**
   * Resolve a pending tool permission request with the user's decision
   */
  resolveToolPermission(
    requestId: string,
    response: PermissionDecision,
    sessionId?: string,
    respondedBy: 'desktop' | 'mobile' = 'desktop'
  ): void {
    this.permissions.resolveToolPermission(
      requestId,
      response,
      (reqId, resp, by) => {
        if (sessionId) {
          void this.logAgentMessageBestEffort(
            sessionId,
            'output',
            this.createPermissionResultMessage(reqId, resp, by)
          );
        }
      },
      respondedBy
    );
  }

  /**
   * Reject a pending tool permission request (e.g., on cancel/abort)
   */
  rejectToolPermission(requestId: string, error: Error, sessionId?: string): void {
    this.permissions.rejectToolPermission(requestId, error, (reqId) => {
      if (sessionId) {
        void this.logAgentMessageBestEffort(
          sessionId,
          'output',
          this.createPermissionCancellationMessage(reqId)
        );
      }
    });
  }

  /**
   * Reject all pending tool permission requests (e.g., on abort)
   */
  rejectAllPendingPermissions(): void {
    this.permissions.rejectAllPendingPermissions();
  }

  /**
   * Poll for permission response messages in the session.
   * This enables mobile and cross-session responses.
   *
   * Based on OpenAICodexProvider implementation with:
   * - Exponential backoff
   * - Validation via isValidPermissionResponse()
   * - Timeout rejection
   */
  protected async pollForPermissionResponse(
    sessionId: string,
    requestId: string,
    signal: AbortSignal
  ): Promise<void> {
    const startTime = Date.now();
    const maxPollTime = 300000; // 5 minutes
    const pollLimit = 50;
    let pollInterval = 500; // Start at 500ms
    const maxPollInterval = 5000; // Cap at 5s

    while (!signal.aborted && Date.now() - startTime < maxPollTime) {
      // Check if request was already resolved (e.g., via IPC)
      if (!this.permissions.pendingToolPermissions.has(requestId)) {
        return; // Already resolved, stop polling
      }

      try {
        // Get recent messages for this session
        const messages = await AgentMessagesRepository.list(sessionId, { limit: pollLimit });

        // Look for a nimbalyst_tool_result that matches our requestId
        for (const msg of messages) {
          try {
            const content = JSON.parse(msg.content);

            // Primary: nimbalyst_tool_result format
            if (content.type === 'nimbalyst_tool_result' && content.tool_use_id === requestId) {
              const result = typeof content.result === 'string' ? JSON.parse(content.result) : content.result;

              if (!BaseAgentProvider.isValidPermissionResponse(result)) {
                this.logSecurity('[BaseAgentProvider] Invalid permission response format', { requestId, result });
                continue;
              }

              const pending = this.permissions.pendingToolPermissions.get(requestId);
              if (pending) {
                pending.resolve({ decision: result.decision, scope: result.scope });
                this.permissions.pendingToolPermissions.delete(requestId);
                this.logSecurity('[BaseAgentProvider] Found nimbalyst_tool_result response', {
                  requestId,
                  decision: result.decision,
                  scope: result.scope,
                });
              }
              return;
            }

            // Legacy: permission_response format (for backwards compatibility)
            if (content.type === 'permission_response' && content.requestId === requestId) {
              if (!BaseAgentProvider.isValidPermissionResponse(content)) {
                this.logSecurity('[BaseAgentProvider] Invalid legacy permission response format', { requestId, content });
                continue;
              }

              const pending = this.permissions.pendingToolPermissions.get(requestId);
              if (pending) {
                pending.resolve({ decision: content.decision, scope: content.scope });
                this.permissions.pendingToolPermissions.delete(requestId);
                this.logSecurity('[BaseAgentProvider] Found legacy permission_response', {
                  requestId,
                  decision: content.decision,
                  scope: content.scope,
                });
              }
              return;
            }
          } catch {
            // Not JSON or doesn't match our format - skip
            continue;
          }
        }

        // No response found yet - wait before next poll with exponential backoff
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        pollInterval = Math.min(pollInterval * 1.5, maxPollInterval);
      } catch (error) {
        this.logSecurity('[BaseAgentProvider] Error polling for permission response', { error, requestId });
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        pollInterval = Math.min(pollInterval * 1.5, maxPollInterval);
      }
    }

    // Polling timed out - reject the pending promise
    const pending = this.permissions.pendingToolPermissions.get(requestId);
    if (pending) {
      pending.reject(new Error('Permission request timed out'));
      this.permissions.pendingToolPermissions.delete(requestId);
    }
  }

  /**
   * Validate permission response format
   */
  protected static readonly VALID_DECISIONS = new Set(['allow', 'deny']);
  protected static readonly VALID_SCOPES = new Set(['once', 'session', 'always', 'always-all']);

  protected static isValidPermissionResponse(value: unknown): value is PermissionDecision {
    if (typeof value !== 'object' || value === null) return false;
    const obj = value as Record<string, unknown>;
    return (
      typeof obj.decision === 'string' &&
      BaseAgentProvider.VALID_DECISIONS.has(obj.decision) &&
      typeof obj.scope === 'string' &&
      BaseAgentProvider.VALID_SCOPES.has(obj.scope)
    );
  }

  /**
   * Security logging helper
   */
  protected logSecurity(message: string, data?: Record<string, unknown>): void {
    BaseAgentProvider.securityLogger?.(message, data);
  }

  protected async getAgentRole(sessionId?: string): Promise<'standard' | 'meta-agent'> {
    if (!sessionId) {
      return 'standard';
    }
    try {
      const session = await AISessionsRepository.get(sessionId);
      return session?.agentRole === 'meta-agent' ? 'meta-agent' : 'standard';
    } catch {
      return 'standard';
    }
  }

  protected async getWorkflowPreset(sessionId?: string): Promise<MetaAgentWorkflowPreset> {
    if (!sessionId) {
      return 'default';
    }
    try {
      const session = await AISessionsRepository.get(sessionId);
      const preset = (session?.metadata as Record<string, unknown> | undefined)?.workflowPreset;
      if (preset === 'implement-review-test' || preset === 'research' || preset === 'default') {
        return preset;
      }
      return 'default';
    } catch {
      return 'default';
    }
  }

  /**
   * Best-effort message logging - doesn't throw on failure
   */
  protected async logAgentMessageBestEffort(
    sessionId: string,
    direction: 'input' | 'output',
    content: string,
    options?: {
      metadata?: Record<string, unknown>;
      hidden?: boolean;
      searchable?: boolean;
    }
  ): Promise<void> {
    try {
      // Check if database is available
      AgentMessagesRepository.getStore();
    } catch {
      return; // No database available
    }

    try {
      await this.logAgentMessage(
        sessionId,
        this.getProviderName(),
        direction,
        content,
        options?.metadata,
        options?.hidden ?? false,
        undefined,
        options?.searchable ?? true
      );
    } catch {
      // Best-effort - don't crash on log failures
    }
  }

  /**
   * Create permission result message for persistence
   */
  protected createPermissionResultMessage(
    requestId: string,
    response: PermissionDecision,
    respondedBy: 'desktop' | 'mobile'
  ): string {
    return JSON.stringify({
      type: 'nimbalyst_tool_result',
      tool_use_id: requestId,
      result: JSON.stringify({
        decision: response.decision,
        scope: response.scope,
        respondedAt: Date.now(),
        respondedBy
      })
    });
  }

  /**
   * Create permission cancellation message for persistence
   */
  protected createPermissionCancellationMessage(requestId: string): string {
    return JSON.stringify({
      type: 'nimbalyst_tool_result',
      tool_use_id: requestId,
      result: JSON.stringify({
        decision: 'deny',
        scope: 'once',
        cancelled: true,
        respondedAt: Date.now(),
      }),
      is_error: true
    });
  }

  /**
   * Default capabilities for agent providers
   * Subclasses can override if they need different capabilities
   */
  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      mcpSupport: true,
      edits: true,
      resumeSession: true,
      supportsFileTools: true
    };
  }

  // Static setters for dependency injection

  static setTrustChecker(checker: TrustChecker | null): void {
    BaseAgentProvider.trustChecker = checker;
  }

  static setPermissionPatternSaver(saver: PermissionPatternSaver | null): void {
    BaseAgentProvider.permissionPatternSaver = saver;
  }

  static setPermissionPatternChecker(checker: PermissionPatternChecker | null): void {
    BaseAgentProvider.permissionPatternChecker = checker;
  }

  static setSecurityLogger(logger: SecurityLogger | null): void {
    BaseAgentProvider.securityLogger = logger;
  }
}
