import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EFFORT_LEVELS } from '@nimbalyst/runtime/ai/server/effortLevels';

vi.mock('../../utils/workspaceDetection', () => ({
  resolveProjectPath: (workspacePath: string) => workspacePath,
}));

import {
  META_AGENT_TOOL_DEFS,
  dispatchMetaAgentTool,
  setMetaAgentToolFns,
} from '../metaAgentServer';

const EXPECTED_EFFORT_LEVELS = EFFORT_LEVELS.map(({ key }) => key);

describe('meta-agent child effort tools (#899)', () => {
  const createSession = vi.fn().mockResolvedValue('{"created":true}');
  const spawnSession = vi.fn().mockResolvedValue('{"spawned":true}');

  beforeEach(() => {
    createSession.mockClear();
    spawnSession.mockClear();
    setMetaAgentToolFns({
      listWorktrees: vi.fn().mockResolvedValue('[]'),
      createSession,
      spawnSession,
      getSessionStatus: vi.fn().mockResolvedValue('{}'),
      getSessionResult: vi.fn().mockResolvedValue('{}'),
      listQueuedPrompts: vi.fn().mockResolvedValue('[]'),
      sendPrompt: vi.fn().mockResolvedValue('{}'),
      respondToPrompt: vi.fn().mockResolvedValue('{}'),
      listSpawnedSessions: vi.fn().mockResolvedValue('[]'),
    });
  });

  it('exposes the same exact effortLevel enum on create_session and spawn_session', () => {
    for (const toolName of ['create_session', 'spawn_session']) {
      const tool = META_AGENT_TOOL_DEFS.find((candidate) => candidate.name === toolName);
      const effortLevel = tool?.inputSchema.properties.effortLevel as { enum?: string[] } | undefined;

      expect(effortLevel?.enum).toEqual(EXPECTED_EFFORT_LEVELS);
    }
  });

  it('forwards effortLevel unchanged through both tool dispatch paths', async () => {
    await dispatchMetaAgentTool('create_session', 'parent-1', '/workspace', {
      prompt: 'create child',
      effortLevel: 'max',
    });
    await dispatchMetaAgentTool('spawn_session', 'parent-1', '/workspace', {
      prompt: 'spawn sibling',
      effortLevel: 'xhigh',
    });

    expect(createSession).toHaveBeenCalledWith('parent-1', '/workspace', {
      prompt: 'create child',
      effortLevel: 'max',
    });
    expect(spawnSession).toHaveBeenCalledWith('parent-1', '/workspace', {
      prompt: 'spawn sibling',
      effortLevel: 'xhigh',
    });
  });
});
