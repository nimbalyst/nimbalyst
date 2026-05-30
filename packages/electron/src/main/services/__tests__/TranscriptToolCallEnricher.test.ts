import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';

const mocks = vi.hoisted(() => ({
  getMatchesForSession: vi.fn(),
  getDiffsForToolCall: vi.fn(),
}));

vi.mock('../ToolCallMatcher', () => ({
  toolCallMatcher: {
    getMatchesForSession: mocks.getMatchesForSession,
    getDiffsForToolCall: mocks.getDiffsForToolCall,
  },
}));

import { enrichTranscriptMessagesWithToolCallDiffs } from '../TranscriptToolCallEnricher';

function makeToolMessage(overrides: Partial<TranscriptViewMessage['toolCall']> & { toolName: string; providerToolCallId: string | null }): TranscriptViewMessage {
  return {
    id: 1,
    sequence: 1,
    createdAt: new Date('2026-05-29T19:00:00Z'),
    type: 'tool_call',
    subagentId: null,
    toolCall: {
      toolDisplayName: overrides.toolName,
      status: 'completed',
      description: null,
      arguments: {},
      targetFilePath: null,
      mcpServer: null,
      mcpTool: null,
      progress: [],
      result: 'ok',
      ...overrides,
    },
  };
}

describe('enrichTranscriptMessagesWithToolCallDiffs', () => {
  beforeEach(() => {
    mocks.getMatchesForSession.mockReset();
    mocks.getDiffsForToolCall.mockReset();
  });

  it('hydrates matched tool rows and file_change rows without mutating the input transcript', async () => {
    const fileChange = makeToolMessage({
      toolName: 'file_change',
      providerToolCallId: 'nimtc|item_1|100|1',
    });
    const bash = makeToolMessage({
      toolName: 'Bash',
      providerToolCallId: 'bash-call-1',
    });
    const untouched = makeToolMessage({
      toolName: 'Read',
      providerToolCallId: 'read-call-1',
    });

    const messages: TranscriptViewMessage[] = [fileChange, bash, untouched];

    mocks.getMatchesForSession.mockResolvedValue([
      { toolCallItemId: 'bash-call-1' },
    ]);
    mocks.getDiffsForToolCall.mockImplementation(async (_sessionId: string, toolCallItemId: string) => {
      if (toolCallItemId === 'nimtc|item_1|100|1') {
        return [{ filePath: '/repo/a.ts', operation: 'edit', diffs: [{ oldString: 'a', newString: 'b' }] }];
      }
      if (toolCallItemId === 'bash-call-1') {
        return [{ filePath: '/repo/b.ts', operation: 'bash', diffs: [], linesAdded: 1, linesRemoved: 0 }];
      }
      return [];
    });

    const enriched = await enrichTranscriptMessagesWithToolCallDiffs('session-1', messages);

    expect(mocks.getMatchesForSession).toHaveBeenCalledWith('session-1');
    expect(mocks.getDiffsForToolCall).toHaveBeenCalledTimes(2);
    expect(enriched[0]?.toolCall?.fileDiffs?.[0]?.filePath).toBe('/repo/a.ts');
    expect(enriched[1]?.toolCall?.fileDiffs?.[0]?.filePath).toBe('/repo/b.ts');
    expect(enriched[2]?.toolCall?.fileDiffs).toBeUndefined();
    expect(messages[0]?.toolCall?.fileDiffs).toBeUndefined();
    expect(enriched[0]).not.toBe(messages[0]);
  });
});
