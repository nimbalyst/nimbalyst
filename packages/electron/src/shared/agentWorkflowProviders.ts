const WORKSPACE_SLASH_WORKFLOW_PROVIDERS = new Set([
  'claude-code',
  // NIM-819: the genuine CLI runs the same workspace .claude/commands natively;
  // the typeahead surfaces them and the submit path types the command into the
  // TUI (trigger-keystroke split — see claudeCliSubmit.ts).
  'claude-code-cli',
  'openai-codex',
  'openai-codex-acp',
  'opencode',
]);

const CODEX_STYLE_WORKFLOW_PROVIDERS = new Set([
  'openai-codex',
  'openai-codex-acp',
  'opencode',
]);

export function supportsWorkspaceSlashWorkflowProvider(provider?: string | null): boolean {
  return provider != null && WORKSPACE_SLASH_WORKFLOW_PROVIDERS.has(provider);
}

export function usesCodexStyleAgentWorkflows(provider?: string | null): boolean {
  return provider != null && CODEX_STYLE_WORKFLOW_PROVIDERS.has(provider);
}
