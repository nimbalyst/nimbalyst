import { describe, expect, it } from 'vitest';
import {
  supportsWorkspaceSlashWorkflowProvider,
  usesCodexStyleAgentWorkflows,
} from '../agentWorkflowProviders';

describe('agentWorkflowProviders', () => {
  it('supports workspace slash workflows for OpenCode sessions', () => {
    expect(supportsWorkspaceSlashWorkflowProvider('opencode')).toBe(true);
    expect(usesCodexStyleAgentWorkflows('opencode')).toBe(true);
  });

  it('keeps Claude Agent on the Claude-style workflow path', () => {
    expect(supportsWorkspaceSlashWorkflowProvider('claude-code')).toBe(true);
    expect(usesCodexStyleAgentWorkflows('claude-code')).toBe(false);
  });
});
