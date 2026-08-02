import { describe, expect, it } from 'vitest';

import { META_AGENT_TOOL_DEFS } from '../metaAgentServer';

describe('spawn_session project-targeting schema (NIM-408)', () => {
  it('exposes only the guarded target-project and base-branch inputs', () => {
    const spawnSession = META_AGENT_TOOL_DEFS.find((tool) => tool.name === 'spawn_session');
    const properties = spawnSession?.inputSchema.properties ?? {};

    expect(properties).toHaveProperty('targetWorkspacePath');
    expect(properties).toHaveProperty('baseBranch');
    expect(properties).not.toHaveProperty('worktreeId');
    expect(JSON.stringify(properties.targetWorkspacePath)).toContain('already-loaded');
    expect(JSON.stringify(properties.targetWorkspacePath)).toContain('isolated');
    expect(JSON.stringify(properties.targetWorkspacePath)).toContain('useWorktree');
  });

  it.each(['create_session', 'spawn_session'])(
    'describes %s claudeCodeBackend as a reviewed catalog profile',
    toolName => {
      const tool = META_AGENT_TOOL_DEFS.find(candidate => candidate.name === toolName);
      const backend = tool?.inputSchema.properties?.claudeCodeBackend as
        | { description?: string }
        | undefined;

      expect(backend?.description).toContain(
        'reviewed Claude-Agent catalog backend/profile id',
      );
      expect(backend?.description).toContain('mismatched model/provider');
      expect(backend?.description).toContain('never credentials or endpoints');
      expect(backend?.description).not.toContain('Ollama Claude-Agent backend');
    },
  );
});
