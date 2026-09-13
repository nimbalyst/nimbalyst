import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { RichTranscriptView } from '../RichTranscriptView';

const vlistState = vi.hoisted(() => ({
  childCount: 0,
  scrollToIndex: vi.fn(),
  scrollBy: vi.fn(),
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
        scrollBy: vlistState.scrollBy,
      }));

      return <div data-testid="mock-vlist">{rows}</div>;
    }),
  };
});

describe('pending question navigation', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  const flushFrames = () => {
    for (let i = 0; i < 12 && frames.size; i++) {
      act(() => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach(callback => callback(0));
      });
    }
    expect(frames.size).toBe(0);
  };
  const question = (index: number, toolName = 'AskUserQuestion', result?: string) => makeMessage(index, {
    type: 'tool_call',
    toolCall: {
      toolName, status: 'running', toolDisplayName: toolName, description: null,
      arguments: toolName.endsWith('AskUserQuestion')
        ? { questions: [{ header: 'Next', question: 'Continue?', options: [{ label: 'Yes', description: 'Continue' }] }] }
        : { fields: [{ type: 'confirm', id: 'continue', label: 'Continue?' }] },
      result, targetFilePath: null, mcpServer: null, mcpTool: null,
      providerToolCallId: `question-${index}`, progress: [],
    },
  });
  const view = (messages: TranscriptViewMessage[], sessionId = 'questions') => (
    <RichTranscriptView sessionId={sessionId} sessionStatus="idle" messages={messages}
      provider="claude-code" persistScrollState={false} />
  );

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    vlistState.scrollToIndex.mockReset();
    vlistState.scrollBy.mockReset();
    vi.stubGlobal('CSS', { highlights: { delete: vi.fn(), set: vi.fn() } });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });

  it.each(['AskUserQuestion', 'mcp__nimbalyst__PromptForUserInput', 'RequestUserInput'])(
    'reveals %s inside its grouped row once and stays reachable after later output', toolName => {
      const messages = [makeMessage(0, { text: 'Before' }), question(1, toolName), makeMessage(2, { text: 'After' })];
      const { rerender, container } = render(view(messages));
      const card = container.querySelector<HTMLElement>('[data-transcript-tool-id="question-1"]')!;
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ top: 180 } as DOMRect);
      flushFrames();
      expect(vlistState.scrollToIndex).toHaveBeenLastCalledWith(2, { align: 'start' });
      expect(vlistState.scrollBy).toHaveBeenLastCalledWith(172);
      vlistState.scrollToIndex.mockClear();

      rerender(view([...messages, makeMessage(3, { text: 'More output' })]));
      flushFrames();
      expect(vlistState.scrollToIndex).not.toHaveBeenCalled();
      fireEvent.click(screen.getByLabelText('Jump to question'));
      flushFrames();
      expect(vlistState.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });

      rerender(view([messages[0], question(1, toolName, '{"cancelled":true}'), messages[2]]));
      flushFrames();
      expect(screen.queryByLabelText('Jump to question')).toBeNull();
    },
  );

  it('handles orphan regrouping, a second question, and session switches without replaying old arrivals', () => {
    const { rerender } = render(view([question(0)]));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenLastCalledWith(0, { align: 'start' });
    vlistState.scrollToIndex.mockClear();
    const messages = [question(0), makeMessage(1, { text: 'Continuation' })];
    rerender(view(messages));
    flushFrames();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Jump to question'));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenLastCalledWith(1, { align: 'start' });

    rerender(view([...messages, question(2)]));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenLastCalledWith(2, { align: 'start' });
    fireEvent.click(screen.getByLabelText('Jump to question'));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenLastCalledWith(1, { align: 'start' });

    rerender(view([question(0)], 'other-session'));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenLastCalledWith(0, { align: 'start' });
  });

  it('ignores superseded answers and non-question prompts', () => {
    const answered = question(1, 'AskUserQuestion', '{"answers":{"Continue?":"Yes"}}');
    answered.toolCall!.providerToolCallId = 'question-0';
    render(view([question(0), answered, question(2, 'ToolPermission'), question(3, 'ExitPlanMode')]));
    flushFrames();
    expect(screen.queryByLabelText('Jump to question')).toBeNull();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(expect.any(Number), { align: 'start' });
  });

  it('cancels queued bottom-follow when a question arrives and targets only the latest duplicate card', () => {
    const { rerender, container } = render(view([makeMessage(0, { text: 'Running' })]));
    flushFrames();
    rerender(view([makeMessage(0, { text: 'More output' })]));
    // The bottom-follow animation frame has not run when the question arrives.
    const latest = question(2);
    latest.toolCall!.providerToolCallId = 'question-1';
    rerender(view([makeMessage(0, { text: 'More output' }), question(1), latest, makeMessage(3, { text: 'After' })]));
    vlistState.scrollToIndex.mockClear();
    flushFrames();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(expect.any(Number), { align: 'end' });
    expect(container.querySelectorAll('[data-transcript-tool-id="question-1"]')).toHaveLength(1);
    expect(vlistState.scrollBy).toHaveBeenCalled();
  });
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
