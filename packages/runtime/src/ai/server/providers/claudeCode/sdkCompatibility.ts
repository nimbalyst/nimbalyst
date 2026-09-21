import type { Options } from '@anthropic-ai/claude-agent-sdk';

// Newer models no longer include task tracking in the SDK's default tool set.
export const CLAUDE_TASK_TOOLS = ['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TodoWrite'];

export function createClaudeSystemPrompt(prompt: string, isMetaAgent = false): NonNullable<Options['systemPrompt']> {
  // Resumed turns must receive updated voice/workflow instructions. Stable
  // appends already retain cache hits without the SDK freezing their content.
  return isMetaAgent
    ? { type: 'custom', prompt, snapshot: false }
    : { type: 'preset', preset: 'claude_code', append: prompt, snapshot: false };
}
