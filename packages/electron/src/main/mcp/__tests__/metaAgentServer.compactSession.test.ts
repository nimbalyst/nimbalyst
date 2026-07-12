import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/workspaceDetection', () => ({
  resolveProjectPath: vi.fn(() => '/canonical-workspace'),
}));

import {
  META_AGENT_TOOL_DEFS,
  dispatchMetaAgentTool,
  getMetaAgentOpenAITools,
  setMetaAgentToolFns,
} from '../metaAgentServer';

describe('compact_session meta-agent registration', () => {
  it('advertises the bounded schema and dispatches to the injected service function', async () => {
    const compactSession = vi.fn().mockResolvedValue('{"scheduled":true}');
    setMetaAgentToolFns({
      listWorktrees: vi.fn(),
      createSession: vi.fn(),
      spawnSession: vi.fn(),
      getSessionStatus: vi.fn(),
      getSessionResult: vi.fn(),
      sendPrompt: vi.fn(),
      compactSession,
      respondToPrompt: vi.fn(),
      listSpawnedSessions: vi.fn(),
    });

    const definition = META_AGENT_TOOL_DEFS.find((tool) => tool.name === 'compact_session');
    expect(definition?.inputSchema.properties.focus).toMatchObject({
      type: 'string',
      maxLength: 1000,
    });
    expect(getMetaAgentOpenAITools().map((tool) => tool.function.name)).toContain('compact_session');

    await expect(dispatchMetaAgentTool(
      'mcp__nimbalyst-host__compact_session',
      'caller-1',
      '/worktree',
      { sessionId: 'child-1', focus: 'preserve state' },
    )).resolves.toBe('{"scheduled":true}');
    expect(compactSession).toHaveBeenCalledWith(
      'caller-1',
      '/canonical-workspace',
      { sessionId: 'child-1', focus: 'preserve state' },
    );
  });
});
