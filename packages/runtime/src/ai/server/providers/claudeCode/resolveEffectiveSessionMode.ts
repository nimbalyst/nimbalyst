export type SessionMode = 'planning' | 'agent' | 'auto';

export interface TrustStatusForMode {
  trusted: boolean;
  mode: 'ask' | 'allow-all' | 'bypass-all' | null;
  /**
   * Opt-in flag (issue #628). When true, "Allow All" (bypass-all) workspaces
   * route agent-mode sessions through the SDK auto-mode classifier instead of
   * bypassing every operation. Defaults to off so "Allow All" means literal
   * allow-all, matching the mode's UI description.
   */
  allowAllUsesClassifier?: boolean;
}

/**
 * Resolve the effective session mode after applying the "Allow All" classifier
 * opt-in.
 *
 * The only transformation here is the bypass-all -> auto upgrade for agent-mode
 * sessions, and it now fires ONLY when the user has explicitly enabled the
 * classifier for the workspace. Previously this upgrade was forced on every
 * "Allow All" workspace, which silently re-routed deploys and settings edits
 * through the classifier and contradicted "all operations auto-approved without
 * any prompts" (issue #628).
 *
 * Non-agent modes (planning, an explicitly-requested auto) are returned
 * unchanged.
 */
export function resolveEffectiveSessionMode(
  requestedMode: SessionMode,
  trustStatus: TrustStatusForMode | null | undefined,
): SessionMode {
  if (requestedMode !== 'agent') return requestedMode;
  if (!trustStatus?.trusted) return requestedMode;
  if (trustStatus.mode === 'bypass-all' && trustStatus.allowAllUsesClassifier === true) {
    return 'auto';
  }
  return requestedMode;
}
