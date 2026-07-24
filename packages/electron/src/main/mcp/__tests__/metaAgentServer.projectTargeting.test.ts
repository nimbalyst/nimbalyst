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
});
