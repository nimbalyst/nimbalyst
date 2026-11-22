/**
 * Centralized tool permission service for agent providers
 *
 * Manages the full lifecycle of permission requests:
 * - Request creation with unique IDs
 * - Pending request management (Map of requestId → promise)
 * - Permission response validation
 * - Session-level pattern caching
 * - Polling for cross-device responses
 * - Integration with persisted settings
 *
 * This service consolidates permission logic previously scattered across
 * ClaudeCodeProvider and OpenAICodexProvider.
 */

import {
  PermissionDecision,
  TrustChecker,
  PermissionPatternSaver,
  PermissionPatternChecker,
  SecurityLogger,
  PendingPermission,
} from '../providers/ProviderPermissionMixin';
import { AgentMessagesRepository } from '../../../storage/repositories/AgentMessagesRepository';
import { constrainPermissionResponse, permissionPromptHints, type PermissionPromptHints, type UserDecisionRequirement } from './permissionPromptPolicy';

/**
 * Called for each waiting request that another answer settled on its own.
 * The caller can use it to mark that request's prompt card as answered in the transcript.
 */
export type ReleasedPermissionRecorder = (
  sessionId: string,
  requestId: string,
  response: PermissionDecision,
) => void;

/**
 * Configuration options for ToolPermissionService
 */
export interface ToolPermissionServiceOptions {
  /**
   * Function to check if a workspace is trusted
   */
  trustChecker: TrustChecker;

  /**
   * Function to save an approved pattern to persisted settings
   */
  patternSaver: PermissionPatternSaver;

  /**
   * Function to check if a pattern is approved in persisted settings
   */
  patternChecker: PermissionPatternChecker;

  /**
   * Security logging function (dev-only, omitted in production to avoid logging sensitive data)
   */
  securityLogger?: SecurityLogger;

  /**
   * Event emitter function for notifying about permission events
   */
  emit: (event: string, data: any) => void;

  /**
   * Called for each waiting request that another answer settled on its own
   * (for example "Always" on one of several identical tool calls). The caller
   * can use it to mark that request's prompt card as answered in the transcript.
   */
  recordReleasedPermission?: ReleasedPermissionRecorder;
}

/**
 * Permission request parameters
 */
export interface PermissionRequest extends PermissionPromptHints {
  /**
   * Unique request ID
   */
  requestId: string;

  /**
   * Session ID for this request
   */
  sessionId: string;

  /**
   * Workspace path for permission checks
   */
  workspacePath: string;

  /**
   * Path for permission lookups (may differ from workspacePath for worktrees)
   */
  permissionsPath: string;

  /**
   * Permission pattern (e.g., 'Bash(git commit:*)')
   */
  pattern: string;

  /**
   * Human-readable display name for the pattern
   */
  patternDisplayName: string;

  /**
   * Raw command or tool description
   */
  rawCommand: string;

  /**
   * Security warnings to display to user
   */
  warnings: string[];

  /**
   * Whether this action is destructive
   */
  isDestructive: boolean;

  /**
   * Abort signal for cancellation
   */
  signal: AbortSignal;

  /**
   * Tool name (optional, for tool-specific permission requests)
   */
  toolName?: string;

  /**
   * Tool input parameters (optional, for pattern generation)
   */
  toolInput?: any;
}

/**
 * Centralized permission service for agent providers
 */
export class ToolPermissionService {
  private readonly trustChecker: TrustChecker;
  private readonly patternSaver: PermissionPatternSaver;
  private readonly patternChecker: PermissionPatternChecker;
  private readonly securityLogger: SecurityLogger;
  private readonly emit: (event: string, data: any) => void;
  private readonly recordReleasedPermission?: ReleasedPermissionRecorder;

  /**
   * Map of pending permission requests
   * Key: requestId, Value: promise resolve/reject functions
   */
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  /**
   * What each waiting tool request asked for, so one answer can settle the others
   * that ask for the same thing. Key: requestId. Cleared when the request ends.
   */
  private readonly waitingToolRequests = new Map<string, {
    sessionId: string;
    toolName: string;
    pattern: string;
    suppressAlwaysAllowRule?: boolean;
  }>();

  /**
   * Session-level cache of approved patterns
   * SDK doesn't hot-reload settings files mid-session, so we cache approvals
   */
  private readonly sessionApprovedPatterns = new Set<string>();

  constructor(options: ToolPermissionServiceOptions) {
    this.trustChecker = options.trustChecker;
    this.patternSaver = options.patternSaver;
    this.patternChecker = options.patternChecker;
    this.securityLogger = options.securityLogger ?? (() => {});
    this.emit = options.emit;
    this.recordReleasedPermission = options.recordReleasedPermission;
  }

  /**
   * Request permission for a tool/command
   *
   * Creates a pending request and waits for user response via IPC or polling.
   * Returns a promise that resolves when user responds.
   *
   * @param request - Permission request parameters
   * @returns Promise that resolves with user's decision
   */
  async requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    const {
      requestId,
      sessionId,
      workspacePath,
      permissionsPath,
      pattern,
      patternDisplayName,
      rawCommand,
      warnings,
      isDestructive,
      signal,
    } = request;

    this.securityLogger('[ToolPermissionService] Requesting permission', {
      requestId,
      pattern,
      workspacePath: workspacePath?.slice(-30),
      permissionsPath: permissionsPath?.slice(-30),
    });

    // Create promise that will be resolved when user responds
    // Response can come from either IPC (desktop) or message polling (mobile/cross-device)
    const responsePromise = new Promise<PermissionDecision>((resolve, reject) => {
      this.pendingPermissions.set(requestId, {
        resolve,
        reject,
        request,
      });
    });

    // Start polling for cross-device responses in parallel
    // Polling will auto-stop if request is resolved via IPC
    this.pollForPermissionResponse(sessionId, requestId, signal).catch(error => {
      this.securityLogger('[ToolPermissionService] Polling error', { requestId, error });
    });

    // Wait for response (from IPC or polling)
    try {
      const response = constrainPermissionResponse(await responsePromise, request);

      // Save pattern if user chose "Always" or "Always All"
      if ((response.scope === 'always' || response.scope === 'always-all') && response.decision === 'allow') {
        const pathForSave = permissionsPath || workspacePath;
        if (pathForSave) {
          try {
            await this.patternSaver(pathForSave, pattern);
            this.securityLogger('[ToolPermissionService] Saved pattern to settings', {
              pattern,
              scope: response.scope,
            });
          } catch (error) {
            this.securityLogger('[ToolPermissionService] Failed to save pattern', {
              pattern,
              error,
            });
          }
        }
      }

      // Add to session cache if scope is session or higher
      if (response.scope === 'session' || response.scope === 'always' || response.scope === 'always-all') {
        this.sessionApprovedPatterns.add(pattern);
      }

      return response;
    } catch (error) {
      this.securityLogger('[ToolPermissionService] Permission request failed', {
        requestId,
        error,
      });
      throw error;
    }
  }

  /**
   * Resolve a pending permission request with user's decision
   *
   * Called from IPC when user responds via desktop UI.
   *
   * @param requestId - Request ID to resolve
   * @param decision - User's decision
   */
  resolvePermission(requestId: string, decision: PermissionDecision): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      pending.resolve(decision);
      this.pendingPermissions.delete(requestId);
      this.securityLogger('[ToolPermissionService] Resolved permission', {
        requestId,
        decision: decision.decision,
        scope: decision.scope,
      });
    } else {
      this.securityLogger('[ToolPermissionService] No pending permission found', { requestId });
    }
  }

  /**
   * Reject a pending permission request
   *
   * Called when request is cancelled or times out.
   *
   * @param requestId - Request ID to reject
   * @param error - Error to reject with
   */
  rejectPermission(requestId: string, error: Error): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      pending.reject(error);
      this.pendingPermissions.delete(requestId);
      this.securityLogger('[ToolPermissionService] Rejected permission', {
        requestId,
        error: error.message,
      });
    }
  }

  /**
   * Reject all pending permission requests
   *
   * Called on abort or provider cleanup.
   */
  rejectAllPending(): void {
    const count = this.pendingPermissions.size;
    for (const [requestId, pending] of this.pendingPermissions) {
      pending.reject(new Error('Request aborted'));
    }
    this.pendingPermissions.clear();
    if (count > 0) {
      this.securityLogger('[ToolPermissionService] Rejected all pending permissions', { count });
    }
  }

  hasPendingPermissions(): boolean {
    return this.pendingPermissions.size > 0;
  }

  /**
   * Check if pattern is already approved in session cache or persisted settings
   *
   * @param workspacePath - Path to workspace
   * @param pattern - Permission pattern to check
   * @returns True if pattern is approved
   */
  async isPatternApproved(workspacePath: string, pattern: string): Promise<boolean> {
    // Check session cache first (fast path)
    if (this.sessionApprovedPatterns.has(pattern)) {
      return true;
    }

    // Check persisted settings (slower, requires file read)
    return await this.patternChecker(workspacePath, pattern);
  }

  /**
   * Clear session cache of approved patterns
   *
   * Called on provider cleanup or when starting a new session.
   */
  clearSessionCache(): void {
    this.sessionApprovedPatterns.clear();
  }

  /**
   * Get the session-level approved patterns cache
   * Used by providers for pattern matching
   */
  getSessionApprovedPatterns(): Set<string> {
    return this.sessionApprovedPatterns;
  }

  /** A Session approval or a saved Always rule that already covers this pattern. */
  private async findRememberedApproval(workspacePath: string, toolName: string, pattern: string): Promise<PermissionDecision | null> {
    if (this.sessionApprovedPatterns.has(pattern)) {
      this.securityLogger('[ToolPermissionService] Pattern already approved this session', {
        pattern,
        toolName,
      });
      return { decision: 'allow', scope: 'session' };
    }

    // Check for wildcard patterns (e.g., 'WebFetch' matches any WebFetch call)
    if (toolName === 'WebFetch' && this.sessionApprovedPatterns.has('WebFetch')) {
      this.securityLogger('[ToolPermissionService] WebFetch wildcard approved this session', { toolName });
      return { decision: 'allow', scope: 'session' };
    }

    // Check persisted settings
    if (await this.isPatternApproved(workspacePath, pattern)) {
      this.securityLogger('[ToolPermissionService] Pattern already approved in settings', {
        pattern,
        toolName,
      });
      // Add to session cache for fast lookups
      this.sessionApprovedPatterns.add(pattern);
      return { decision: 'allow', scope: 'always' };
    }

    return null;
  }

  /**
   * Request permission for a tool call (Claude Code style)
   *
   * This is a higher-level API that handles:
   * - Trust checking (with mode-specific fast paths)
   * - Session cache checking
   * - Permission request with UI events
   * - Pattern saving on approval
   *
   * @param options - Tool permission request options
   * @returns Promise that resolves with user's decision
   */
  async requestToolPermission(options: PermissionPromptHints & {
    requestId: string;
    sessionId: string;
    workspacePath: string;
    permissionsPath: string;
    toolName: string;
    toolInput: any;
    pattern: string;
    patternDisplayName: string;
    toolDescription: string;
    isDestructive: boolean;
    warnings?: string[];
    signal: AbortSignal;
    /** Name of the teammate requesting permission (undefined for lead agent) */
    teammateName?: string;
    /**
     * The caller already decided the user must answer. 'escalated' skips the bypass-all
     * shortcut (#1740); 'hook-ask' also skips the allow-edits shortcut and every remembered
     * Session or Always approval (#1741).
     */
    requiresUserDecision?: UserDecisionRequirement;
  }): Promise<PermissionDecision> {
    const {
      requestId,
      sessionId,
      workspacePath,
      permissionsPath,
      toolName,
      toolInput,
      pattern,
      patternDisplayName,
      toolDescription,
      isDestructive,
      warnings = [],
      signal,
      teammateName,
      requiresUserDecision,
    } = options;

    const pathForTrust = permissionsPath || workspacePath;
    const hookAsked = requiresUserDecision === 'hook-ask';

    // Check trust status
    if (pathForTrust && this.trustChecker) {
      const trustStatus = this.trustChecker(pathForTrust);

      if (!trustStatus.trusted) {
        this.securityLogger('[ToolPermissionService] Workspace not trusted, denying tool', {
          toolName,
          workspacePath: pathForTrust,
        });
        throw new Error('Workspace is not trusted. Please trust the workspace to use AI tools.');
      }

      // Bypass-all mode: auto-approve everything, unless the call was escalated to the user (#1740)
      if (trustStatus.mode === 'bypass-all' && !requiresUserDecision) {
        this.securityLogger('[ToolPermissionService] Bypass-all mode, auto-approving', { toolName });
        return { decision: 'allow', scope: 'once' };
      }

      // Allow-all mode: auto-approve file edit operations, unless a hook asked (#1741)
      if (trustStatus.mode === 'allow-all' && !hookAsked) {
        const fileEditTools = ['Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep', 'LS', 'NotebookEdit'];
        if (fileEditTools.includes(toolName)) {
          this.securityLogger('[ToolPermissionService] Allow-all mode, auto-approving file tool', { toolName });
          return { decision: 'allow', scope: 'once' };
        }
      }
    }

    // A hook "ask" is answered by the user every time, never by a remembered approval (#1741)
    if (hookAsked) {
      this.securityLogger('[ToolPermissionService] PreToolUse hook asked, skipping remembered approvals', { pattern, toolName });
    } else {
      const remembered = await this.findRememberedApproval(workspacePath, toolName, pattern);
      if (remembered) {
        return remembered;
      }
    }

    // Looking up the saved settings took a moment. Another prompt in this session may have been
    // answered "Always" in that time, and it could not release this request because it was not
    // waiting yet. Look at the session cache once more before asking the user.
    if (!hookAsked && this.isApprovedThisSession(toolName, pattern)) {
      this.securityLogger('[ToolPermissionService] Pattern approved this session while settings were read', {
        pattern,
        toolName,
      });
      const response: PermissionDecision = { decision: 'allow', scope: 'session' };
      this.recordReleasedPermission?.(sessionId, requestId, response);
      return response;
    }

    const rawCommand = toolName === 'Bash' ? toolInput?.command || '' : toolDescription;

    this.securityLogger('[ToolPermissionService] Requesting tool permission', {
      requestId,
      toolName,
      pattern,
      workspacePath: workspacePath?.slice(-30),
    });

    // Create simplified request structure for UI widget
    const request = {
      ...permissionPromptHints(options),
      id: requestId,
      toolName,
      rawCommand,
      actionsNeedingApproval: [{
        action: {
          pattern,
          displayName: toolDescription,
          command: toolName === 'Bash' ? toolInput?.command || '' : '',
          isDestructive,
          referencedPaths: [],
          hasRedirection: false,
        },
        decision: 'ask' as const,
        reason: 'Tool requires user approval',
        isDestructive,
        isRisky: toolName === 'Bash',
        warnings,
        outsidePaths: [],
        sensitivePaths: [],
      }],
      hasDestructiveActions: isDestructive,
      createdAt: Date.now(),
    };

    this.waitingToolRequests.set(requestId, {
      sessionId,
      toolName,
      pattern,
      suppressAlwaysAllowRule: options.suppressAlwaysAllowRule || hookAsked,
    });

    // Create promise that will be resolved when user responds
    const responsePromise = new Promise<PermissionDecision>((resolve, reject) => {
      this.pendingPermissions.set(requestId, {
        resolve,
        reject,
        request,
      });

      // Set up abort handler
      if (signal) {
        signal.addEventListener('abort', () => {
          this.pendingPermissions.delete(requestId);
          reject(new Error('Request aborted'));
        }, { once: true });
      }
    });

    // Emit pending event for UI
    this.emit('toolPermission:pending', {
      requestId,
      sessionId,
      workspacePath,
      request,
      teammateName,
      timestamp: Date.now(),
    });

    // Start polling for cross-device responses in parallel
    this.pollForPermissionResponse(sessionId, requestId, signal).catch(error => {
      this.securityLogger('[ToolPermissionService] Polling error', { requestId, error });
    });

    try {
      // Wait for user response
      const response = constrainPermissionResponse(await responsePromise, options);

      this.securityLogger('[ToolPermissionService] User response received', {
        toolName,
        decision: response.decision,
        scope: response.scope,
      });

      // Add to session cache for non-once approvals
      // Skip compound commands (they must be approved each time)
      const isCompoundCommand = pattern.startsWith('Bash:compound:');
      if (response.decision === 'allow' && response.scope !== 'once' && !isCompoundCommand) {
        // For "Allow All WebFetches", the rule is the wildcard 'WebFetch' instead of the exact pattern
        const approvedRule = this.approvedRuleFor(response.scope, toolName, pattern);
        this.sessionApprovedPatterns.add(approvedRule);
        this.securityLogger(
          approvedRule === pattern
            ? '[ToolPermissionService] Added pattern to session cache'
            : '[ToolPermissionService] Added wildcard pattern to session cache',
          { pattern: approvedRule, scope: response.scope },
        );

        // The model may call the same tool several times at once. Each call is already
        // waiting on its own prompt, so this answer must settle those prompts too.
        this.releaseCoveredRequests(requestId, sessionId, approvedRule);
      }

      // Save pattern if user chose "Always" or "Always All"
      if (response.decision === 'allow' && (response.scope === 'always' || response.scope === 'always-all') && !isCompoundCommand) {
        const pathForSave = permissionsPath || workspacePath;
        if (pathForSave) {
          try {
            // For "Always All WebFetches", save the wildcard pattern
            const patternToSave = this.approvedRuleFor(response.scope, toolName, pattern);
            await this.patternSaver(pathForSave, patternToSave);
            this.securityLogger('[ToolPermissionService] Saved pattern to settings', {
              pattern: patternToSave,
              scope: response.scope,
            });
          } catch (error) {
            this.securityLogger('[ToolPermissionService] Failed to save pattern', {
              pattern,
              error,
            });
          }
        }
      }

      // Emit resolved event for UI
      this.emit('toolPermission:resolved', {
        requestId,
        sessionId,
        response,
        timestamp: Date.now(),
      });

      return response;
    } catch (error) {
      // Emit resolved event on error path so the "waiting for input" indicator is cleared
      this.emit('toolPermission:resolved', {
        requestId,
        sessionId,
        response: { decision: 'deny', scope: 'once' },
        timestamp: Date.now(),
      });
      this.securityLogger('[ToolPermissionService] Permission request failed', {
        requestId,
        toolName,
        error,
      });
      throw error;
    } finally {
      this.waitingToolRequests.delete(requestId);
    }
  }

  /**
   * Which rule an answer approves. Usually that is the exact pattern of the call.
   * "Allow all WebFetches" approves the wildcard 'WebFetch' instead, so every
   * WebFetch call is covered no matter which site it asks for.
   */
  private approvedRuleFor(scope: PermissionDecision['scope'], toolName: string, pattern: string): string {
    return (scope === 'always-all' && toolName === 'WebFetch') ? 'WebFetch' : pattern;
  }

  /**
   * True when this session already approved the call's pattern, or approved
   * all WebFetches and this call is a WebFetch.
   */
  private isApprovedThisSession(toolName: string, pattern: string): boolean {
    return this.sessionApprovedPatterns.has(pattern)
      || (toolName === 'WebFetch' && this.sessionApprovedPatterns.has('WebFetch'));
  }

  /**
   * Allow every other waiting request that an approved rule covers
   *
   * A request is covered when it is in the same session, asks for the same pattern
   * (or is a WebFetch call and the rule is the "all WebFetches" one), and did not
   * ask us to keep its approval to one time only. Each released request gets a
   * "session" answer, the same one a later call gets from the session cache. That
   * keeps the rule from being saved to settings again for every released request.
   */
  private releaseCoveredRequests(answeredRequestId: string, sessionId: string, approvedPattern: string): void {
    for (const [otherId, other] of this.waitingToolRequests) {
      if (otherId === answeredRequestId || other.sessionId !== sessionId || other.suppressAlwaysAllowRule) continue;
      const covered = other.pattern === approvedPattern
        || (approvedPattern === 'WebFetch' && other.toolName === 'WebFetch');
      const pending = this.pendingPermissions.get(otherId);
      if (!covered || !pending) continue;

      const response: PermissionDecision = { decision: 'allow', scope: 'session' };
      pending.resolve(response);
      this.pendingPermissions.delete(otherId);
      this.securityLogger('[ToolPermissionService] Released waiting request covered by approved rule', {
        requestId: otherId,
        pattern: approvedPattern,
      });
      // Mark its prompt card as answered, like an answer typed into the card would.
      this.recordReleasedPermission?.(sessionId, otherId, response);
    }
  }

  /**
   * Poll for permission response messages in the session
   *
   * This enables mobile and cross-device responses by checking for
   * nimbalyst_tool_result messages in the session's message log.
   *
   * Uses exponential backoff and auto-stops if request is resolved via IPC.
   *
   * @param sessionId - Session ID to poll
   * @param requestId - Request ID to look for
   * @param signal - Abort signal for cancellation
   */
  private async pollForPermissionResponse(
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
      if (!this.pendingPermissions.has(requestId)) {
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

              if (!this.isValidPermissionResponse(result)) {
                this.securityLogger('[ToolPermissionService] Invalid permission response format', {
                  requestId,
                  result,
                });
                continue;
              }

              const pending = this.pendingPermissions.get(requestId);
              if (pending) {
                pending.resolve({ decision: result.decision, scope: result.scope });
                this.pendingPermissions.delete(requestId);
                this.securityLogger('[ToolPermissionService] Found nimbalyst_tool_result response', {
                  requestId,
                  decision: result.decision,
                  scope: result.scope,
                });
              }
              return;
            }

            // Legacy: permission_response format (for backwards compatibility)
            if (content.type === 'permission_response' && content.requestId === requestId) {
              if (!this.isValidPermissionResponse(content)) {
                this.securityLogger('[ToolPermissionService] Invalid legacy permission response format', {
                  requestId,
                  content,
                });
                continue;
              }

              const pending = this.pendingPermissions.get(requestId);
              if (pending) {
                pending.resolve({ decision: content.decision, scope: content.scope });
                this.pendingPermissions.delete(requestId);
                this.securityLogger('[ToolPermissionService] Found legacy permission_response', {
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
        this.securityLogger('[ToolPermissionService] Error polling for permission response', {
          error,
          requestId,
        });
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        pollInterval = Math.min(pollInterval * 1.5, maxPollInterval);
      }
    }

    // Polling timed out - reject the pending promise
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      pending.reject(new Error('Permission request timed out'));
      this.pendingPermissions.delete(requestId);
    }
  }

  /**
   * Validate permission response format
   *
   * @param value - Value to validate
   * @returns True if value is a valid PermissionDecision
   */
  private isValidPermissionResponse(value: unknown): value is PermissionDecision {
    if (typeof value !== 'object' || value === null) return false;
    const obj = value as Record<string, unknown>;

    const VALID_DECISIONS = new Set(['allow', 'deny']);
    const VALID_SCOPES = new Set(['once', 'session', 'always', 'always-all']);

    return (
      typeof obj.decision === 'string' &&
      VALID_DECISIONS.has(obj.decision) &&
      typeof obj.scope === 'string' &&
      VALID_SCOPES.has(obj.scope)
    );
  }
}
