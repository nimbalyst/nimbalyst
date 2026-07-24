export * from './types';
export * from './AIProvider';
export * from './ProviderFactory';
export * from './ModelRegistry';
export * from './SessionManager';
export * from './providers/ClaudeProvider';
export * from './providers/ClaudeCodeProvider';
export * from './providers/OpenAIProvider';
export * from './providers/OpenAICodexProvider';
export * from './providers/OpenAICodexACPProvider';
export * from './providers/ProviderPermissionMixin';
export * from './providers/LMStudioProvider';
export * from './providers/OpenCodeProvider';
export * from './providers/CopilotCLIProvider';
export * from './utils/errorDetection';
export * from './preferredAgentLanguageConfig';
export { McpConfigService } from './services/McpConfigService';
export type { McpConfigServiceDeps } from './services/McpConfigService';
export {
  configureMcpServers,
  getMcpConfigService,
  isInternalMcpServerEnabled,
} from './services/mcpServerConfig';
export type { SharedMcpServerConfig, PerProviderMcpDeps } from './services/mcpServerConfig';
export * from './services/mcpTopology';
export * from './services/mcpTokenBudget';

// Meta-agent persona builder. Re-exported here (rather than from the root
// barrel which would collide with `buildSystemPrompt`) so the electron-main
// extension-agent path can deliver the SAME persona text the built-in
// providers (claude-code, openai-codex) use. Keeping the source shared means
// the gemini extension and claude-code never drift.
export { buildMetaAgentSystemPrompt, buildDevAgentSystemPrompt } from '../prompt';
export type { MetaAgentWorkflowPreset } from '../prompt';
