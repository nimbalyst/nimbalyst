import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_LAUNCH_EFFORT_LEVELS,
  SESSION_LAUNCH_THINKING_MODES,
  SESSION_LAUNCH_TOOL_SCOPES,
} from '@nimbalyst/runtime/ai/server/sessionLaunchConfiguration';

vi.mock('../../utils/workspaceDetection', () => ({
  resolveProjectPath: (workspacePath: string) => workspacePath,
}));

import {
  META_AGENT_TOOL_DEFS,
  dispatchMetaAgentTool,
  setMetaAgentToolFns,
} from '../metaAgentServer';

describe('meta-agent launch configuration schemas', () => {
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
      sendPromptNow: vi.fn().mockResolvedValue('{}'),
      notifyUser: vi.fn().mockResolvedValue('{}'),
      respondToPrompt: vi.fn().mockResolvedValue('{}'),
      listSpawnedSessions: vi.fn().mockResolvedValue('[]'),
    });
  });

  it('exposes the same provider-aware controls on create_session and spawn_session', () => {
    for (const toolName of ['create_session', 'spawn_session']) {
      const tool = META_AGENT_TOOL_DEFS.find(candidate => candidate.name === toolName);
      const properties = tool?.inputSchema.properties as Record<
        string,
        { enum?: string[] }
      >;

      expect(properties.effortLevel.enum).toEqual(SESSION_LAUNCH_EFFORT_LEVELS);
      expect(properties.thinkingMode.enum).toEqual(SESSION_LAUNCH_THINKING_MODES);
      expect(properties.toolScope.enum).toEqual(SESSION_LAUNCH_TOOL_SCOPES);
    }
  });

  it('forwards launch controls unchanged through both dispatch paths', async () => {
    const launch = {
      provider: 'claude-code',
      model: 'claude-code:opus',
      effortLevel: 'high',
      thinkingMode: 'disabled',
      toolScope: 'write',
    };
    await dispatchMetaAgentTool('create_session', 'parent-1', '/workspace', {
      prompt: 'create child',
      ...launch,
    });
    await dispatchMetaAgentTool('spawn_session', 'parent-1', '/workspace', {
      prompt: 'spawn sibling',
      ...launch,
    });

    expect(createSession).toHaveBeenCalledWith('parent-1', '/workspace', {
      prompt: 'create child',
      ...launch,
    });
    expect(spawnSession).toHaveBeenCalledWith('parent-1', '/workspace', {
      prompt: 'spawn sibling',
      ...launch,
    });
  });
});
