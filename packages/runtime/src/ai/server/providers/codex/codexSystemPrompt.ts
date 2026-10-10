import { buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt, type MetaAgentWorkflowPreset } from '../../../prompt';
import type { DocumentContext } from '../../types';
import {
  areTrackerToolsEnabled,
  isInternalMcpServerEnabled,
  resolveTrackersWorkspacePath,
} from '../../services/mcpServerConfig';

export interface CodexSystemPromptOptions {
  documentContext?: DocumentContext;
  isMetaAgent: boolean;
  workflowPreset: MetaAgentWorkflowPreset;
  model?: string;
  /** `metadata.sessionDirective`, frozen per session by `BaseAgentProvider.getSessionDirective`. */
  sessionDirective?: string;
  /** The session was titled by its caller, so the agent must not name it (frozen at the first turn). */
  hasOutOfBandNaming: boolean;
}

/**
 * System prompt for an OpenAI Codex turn, using the same addendum as Claude
 * Code (visual tools, worktrees, session naming, etc.). Re-sent at the head of
 * every turn as developer instructions, so every input must be stable for the
 * session.
 */
export function buildCodexSystemPrompt(options: CodexSystemPromptOptions): string {
  const { documentContext, sessionDirective } = options;
  if (options.isMetaAgent) {
    return buildMetaAgentSystemPrompt('codex', options.workflowPreset, {
      provider: 'openai-codex',
      model: options.model,
      sessionDirective,
    });
  }

  return buildClaudeCodeSystemPrompt({
    hasSessionNaming: isInternalMcpServerEnabled(),
    hasOutOfBandNaming: options.hasOutOfBandNaming,
    toolReferenceStyle: 'codex',
    worktreePath: documentContext?.worktreePath,
    sessionDirective,
    isVoiceMode: (documentContext as any)?.isVoiceMode,
    voiceModeCodingAgentPrompt: (documentContext as any)?.voiceModeCodingAgentPrompt,
    // Agent teams are not currently supported for Codex.
    enableAgentTeams: false,
    trackersEnabled: areTrackerToolsEnabled(resolveTrackersWorkspacePath(documentContext)),
  });
}
