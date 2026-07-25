import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { RichTranscriptView } from '../RichTranscriptView';

const vlistState = vi.hoisted(() => ({
  childCount: 0,
  scrollToIndex: vi.fn(),
}));

vi.mock('virtua', async () => {
  const ReactModule = await import('react');

  return {
    VList: ReactModule.forwardRef(({ children }: { children: React.ReactNode }, ref) => {
      const rows = ReactModule.Children.toArray(children);
      vlistState.childCount = rows.length;

      ReactModule.useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollOffset: 0,
        scrollSize: 300,
        viewportSize: 100,
        findItemIndex: (offset: number) => offset >= 100 ? 1 : 0,
        scrollToIndex: vlistState.scrollToIndex,
      }));

      return <div data-testid="mock-vlist">{rows}</div>;
    }),
  };
});

function makeMessage(
  index: number,
  overrides: Partial<TranscriptViewMessage>,
): TranscriptViewMessage {
  return {
    id: index + 1,
    sequence: index + 1,
    createdAt: new Date(1_784_648_445_000 + index),
    type: 'assistant_message',
    subagentId: null,
    ...overrides,
  };
}

describe('RichTranscriptView permission review banner', () => {
  beforeEach(() => {
    vlistState.childCount = 0;
    vlistState.scrollToIndex.mockReset();
    vi.stubGlobal('CSS', {
      highlights: {
        delete: vi.fn(),
        set: vi.fn(),
      },
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it('keeps the pending permission scroll target addressable after a hidden classifier denial', async () => {
    const messages: TranscriptViewMessage[] = [
      makeMessage(0, {
        type: 'system_message',
        systemMessage: {
          systemType: 'permission_denied',
          deniedToolName: 'Bash',
          deniedReason: 'Classifier requested review',
          deniedReasonType: 'classifier',
        },
      }),
      makeMessage(1, {
        type: 'tool_call',
        toolCall: {
          toolName: 'ToolPermission',
          toolDisplayName: 'ToolPermission',
          status: 'running',
          description: null,
          arguments: {
            requestId: 'permission-1',
            toolName: 'Bash',
            rawCommand: 'npm test',
            pattern: 'Bash(npm test:*)',
            patternDisplayName: 'npm test commands',
            isDestructive: true,
            warnings: ['Auto-mode classifier requested review'],
            workspacePath: '/workspace',
          },
          targetFilePath: null,
          mcpServer: null,
          mcpTool: null,
          providerToolCallId: 'permission-1',
          progress: [],
        },
      }),
      makeMessage(2, {
        type: 'assistant_message',
        text: '',
      }),
    ];

    render(
      <RichTranscriptView
        sessionId="session-1"
        sessionStatus="waiting"
        isProcessing
        hasPendingInteractivePrompt
        messages={messages}
        provider="claude-code"
        persistScrollState={false}
      />,
    );

    const reviewButton = await screen.findByRole('button', {
      name: /1 pending permission.*click to review/i,
    });

    vlistState.scrollToIndex.mockClear();
    fireEvent.click(reviewButton);

    await waitFor(() => {
      expect(vlistState.scrollToIndex).toHaveBeenCalledWith(2, { align: 'center' });
    });
    expect(vlistState.childCount).toBe(messages.length);
    expect(vlistState.scrollToIndex.mock.calls[0][0]).toBeLessThan(vlistState.childCount);
  });
});
