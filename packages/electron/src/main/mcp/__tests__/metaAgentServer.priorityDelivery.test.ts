import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/workspaceDetection', () => ({
  resolveProjectPath: (workspacePath: string) => workspacePath,
}));

import {
  META_AGENT_TOOL_DEFS,
  dispatchMetaAgentTool,
  getMetaAgentOpenAITools,
  setMetaAgentToolFns,
} from '../metaAgentServer';

describe('send_prompt_now MCP parity', () => {
  const sendPromptNow = vi.fn();

  beforeEach(() => {
    sendPromptNow.mockReset();
    sendPromptNow.mockResolvedValue('{"ok":true}');
    setMetaAgentToolFns({ sendPromptNow } as any);
  });

  it('appears exactly once on both surfaces with only host-safe required inputs', () => {
    const builtIn = META_AGENT_TOOL_DEFS.filter((tool) => tool.name === 'send_prompt_now');
    const extension = getMetaAgentOpenAITools().filter(
      (tool) => tool.function.name === 'send_prompt_now',
    );

    expect(builtIn).toHaveLength(1);
    expect(extension).toHaveLength(1);
    expect(builtIn[0].inputSchema.required).toEqual([
      'sessionId',
      'prompt',
      'idempotencyKey',
      'controlOperation',
    ]);
    expect(Object.keys(builtIn[0].inputSchema.properties)).toEqual([
      'sessionId',
      'prompt',
      'idempotencyKey',
      'controlOperation',
    ]);
    expect(builtIn[0].description).toMatch(/priority\/control/i);
    expect(builtIn[0].description).toMatch(/interrupt/i);
    expect(builtIn[0].description).toMatch(/FIFO send_prompt/i);
  });

  it('dispatches the raw argument object to the sendPromptNow binding', async () => {
    const args = {
      sessionId: 'target-session',
      prompt: 'Act now',
      idempotencyKey: 'control:key-1',
      controlOperation: 'operator_directive',
      producer: 'forged-producer',
      priorityRank: -1,
    };

    await expect(dispatchMetaAgentTool(
      'mcp__nimbalyst-host__send_prompt_now',
      'caller-session',
      'D:\\repo',
      args,
    )).resolves.toBe('{"ok":true}');

    expect(sendPromptNow).toHaveBeenCalledWith(
      'caller-session',
      'D:\\repo',
      args,
    );
  });

  it('never lists or dispatches private host control operations', async () => {
    expect(META_AGENT_TOOL_DEFS.filter(
      (tool) => tool.name === 'watcher_obligation_event',
    )).toHaveLength(0);
    expect(getMetaAgentOpenAITools().filter(
      (tool) => tool.function.name === 'watcher_obligation_event',
    )).toHaveLength(0);

    await expect(dispatchMetaAgentTool(
      'mcp__nimbalyst-host__watcher_obligation_event',
      'caller-session',
      'D:\\repo',
      {},
    )).rejects.toThrow('Unknown tool');
  });
});
