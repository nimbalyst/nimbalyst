import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';

const mocks = vi.hoisted(() => ({
  getMatchesForSession: vi.fn(),
  getDiffsForSession: vi.fn(),
}));

vi.mock('../ToolCallMatcher', () => ({
  toolCallMatcher: {
    getMatchesForSession: mocks.getMatchesForSession,
    getDiffsForSession: mocks.getDiffsForSession,
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
    mocks.getDiffsForSession.mockReset();
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
    // Batched entry point: given the candidate refs, return a map keyed by
    // `${toolCallItemId} ${timestamp}` (matching the enricher's refKey).
    mocks.getDiffsForSession.mockImplementation(
      async (_sessionId: string, refs: Array<{ toolCallItemId: string; toolCallTimestamp?: number }>) => {
        const out = new Map<string, unknown[]>();
        for (const { toolCallItemId, toolCallTimestamp } of refs) {
          const key = `${toolCallItemId} ${toolCallTimestamp ?? ''}`;
          if (toolCallItemId === 'nimtc|item_1|100|1') {
            out.set(key, [{ filePath: '/repo/a.ts', operation: 'edit', diffs: [{ oldString: 'a', newString: 'b' }] }]);
          } else if (toolCallItemId === 'bash-call-1') {
            out.set(key, [{ filePath: '/repo/b.ts', operation: 'bash', diffs: [], linesAdded: 1, linesRemoved: 0 }]);
          }
        }
        return out;
      },
    );

    const enriched = await enrichTranscriptMessagesWithToolCallDiffs('session-1', messages);

    expect(mocks.getMatchesForSession).toHaveBeenCalledWith('session-1');
    // One batched call for the whole session (not one per tool call).
    expect(mocks.getDiffsForSession).toHaveBeenCalledTimes(1);
    const passedRefs = mocks.getDiffsForSession.mock.calls[0][1] as Array<{ toolCallItemId: string }>;
    expect(passedRefs.map((r) => r.toolCallItemId).sort()).toEqual(['bash-call-1', 'nimtc|item_1|100|1']);
    expect(enriched[0]?.toolCall?.fileDiffs?.[0]?.filePath).toBe('/repo/a.ts');
    expect(enriched[1]?.toolCall?.fileDiffs?.[0]?.filePath).toBe('/repo/b.ts');
    expect(enriched[2]?.toolCall?.fileDiffs).toBeUndefined();
    expect(messages[0]?.toolCall?.fileDiffs).toBeUndefined();
    expect(enriched[0]).not.toBe(messages[0]);
  });
});
