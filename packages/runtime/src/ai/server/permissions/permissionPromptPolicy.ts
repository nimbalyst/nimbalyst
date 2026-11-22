import type { PermissionDecision } from '../providers/ProviderPermissionMixin';

export interface PermissionPromptHints {
  /** Start on decline rather than a one-keystroke approval. */
  defaultToNo?: boolean;
  /** A reusable rule would authorize more than this particular request. */
  suppressAlwaysAllowRule?: boolean;
}

export function permissionPromptHints(options: PermissionPromptHints): PermissionPromptHints {
  return {
    ...(options.defaultToNo && { defaultToNo: true }),
    ...(options.suppressAlwaysAllowRule && { suppressAlwaysAllowRule: true }),
  };
}

/**
 * Why a permission request must be answered by the user:
 * - 'escalated': Agent-verified mode escalated the call, so bypass-all must not auto-approve it (#1740).
 * - 'hook-ask': a PreToolUse hook returned "ask". Nothing remembered answers it: not a Session
 *   or Always approval, not a mode shortcut (#1741).
 */
export type UserDecisionRequirement = 'escalated' | 'hook-ask';

/**
 * True when canUseTool runs because a PreToolUse hook returned "ask". The SDK forwards the
 * CLI's `decision_reason_type` as `decisionReasonType`; Nimbalyst's own hooks never ask, so
 * 'hook' always means a user-configured hook.
 */
export function isHookAsk(options: { decisionReasonType?: string } | undefined): boolean {
  return options?.decisionReasonType === 'hook';
}

/** Older/remote clients may still submit a reusable scope; enforce this at the host too. */
export function constrainPermissionResponse(response: PermissionDecision, hints: PermissionPromptHints): PermissionDecision {
  return hints.suppressAlwaysAllowRule && response.scope !== 'once'
    ? { ...response, scope: 'once' }
    : response;
}
