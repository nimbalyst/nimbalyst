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

/** Older/remote clients may still submit a reusable scope; enforce this at the host too. */
export function constrainPermissionResponse(response: PermissionDecision, hints: PermissionPromptHints): PermissionDecision {
  return hints.suppressAlwaysAllowRule && response.scope !== 'once'
    ? { ...response, scope: 'once' }
    : response;
}
