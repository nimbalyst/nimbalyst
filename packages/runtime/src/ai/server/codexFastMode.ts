export type CodexServiceTier = 'fast';

/**
 * Resolve the effective Codex service tier from a session override and the
 * global provider default. Session metadata wins when it is explicitly boolean.
 */
export function resolveCodexServiceTier(
  sessionFastModeEnabled: unknown,
  defaultFastModeEnabled: unknown
): CodexServiceTier | undefined {
  const enabled = typeof sessionFastModeEnabled === 'boolean'
    ? sessionFastModeEnabled
    : defaultFastModeEnabled === true;

  return enabled ? 'fast' : undefined;
}

