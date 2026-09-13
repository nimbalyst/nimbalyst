/** #1476: app-managed Claude children must never update the pinned executable. */
export function managedClaudeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' };
}
