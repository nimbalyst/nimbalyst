import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { RichTranscriptView } from '../RichTranscriptView';

const vlistState = vi.hoisted(() => ({
  childCount: 0,
  onScroll: null as ((offset: number) => void) | null,
  scrollOffset: 0,
  scrollSize: 300,
  viewportSize: 100,
  scrollToIndex: vi.fn(),
  scrollBy: vi.fn(),
}));

vi.mock('virtua', async () => {
  const ReactModule = await import('react');

  return {
    VList: ReactModule.forwardRef((
      { children, className, onScroll }: { children: React.ReactNode; className?: string; onScroll?: (offset: number) => void },
      ref,
    ) => {
      const rows = ReactModule.Children.toArray(children);
      vlistState.childCount = rows.length;
      vlistState.onScroll = onScroll ?? null;

      ReactModule.useImperativeHandle(ref, () => ({
        cache: undefined,
        get scrollOffset() { return vlistState.scrollOffset; },
        get scrollSize() { return vlistState.scrollSize; },
        get viewportSize() { return vlistState.viewportSize; },
        findItemIndex: (offset: number) => offset >= 100 ? 1 : 0,
        getItemOffset: () => 0,
        scrollToIndex: vlistState.scrollToIndex,
        scrollBy: vlistState.scrollBy,
      }));

      return <div data-testid="mock-vlist" className={className}>{rows}</div>;
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
  // Revealed questions outlive the component, so each test gets its own session.
  let session = '';
  let sessionCount = 0;
  const view = (messages: TranscriptViewMessage[], sessionId = session) => (
    <RichTranscriptView sessionId={sessionId} sessionStatus="idle" messages={messages}
      provider="claude-code" persistScrollState={false} />
  );
  // The transcript hides its list when its pane is hidden (IntersectionObserver).
  let observers: Array<{ callback: IntersectionObserverCallback; target?: Element }>;
  const setTranscriptVisible = (isIntersecting: boolean) => act(() => {
    observers
      .filter(observer => observer.target?.classList.contains('rich-transcript-view'))
      .forEach(observer => observer.callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver));
  });
  // Gives the (re)mounted scroller a browser-like scrollTop and scrollHeight:
  // writes clamp to the scroll range and fire the list's onScroll.
  const instrumentScroller = (container: HTMLElement) => {
    const scroller = container.querySelector<HTMLElement>('.rich-transcript-vlist')!;
    const pins: number[] = [];
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => vlistState.scrollSize });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => vlistState.scrollOffset,
      set: (top: number) => {
        pins.push(top);
        vlistState.scrollOffset = Math.max(0, Math.min(top, vlistState.scrollSize - vlistState.viewportSize));
        vlistState.onScroll?.(vlistState.scrollOffset);
      },
    });
    return { scroller, pins };
  };
  // Rows measured after mount grow the list. virtua 0.51.3 keeps the scroll
  // offset when rows in or below the viewport grow, so the end moves down; the
  // browser then delivers the resize to the component's observers.
  let resizeObservers: ResizeObserverCallback[];
  const rowsMeasure = (grownScrollSize: number) => act(() => {
    vlistState.scrollSize = grownScrollSize;
    resizeObservers.forEach(callback => callback([], {} as ResizeObserver));
  });
  const distanceFromEnd = () => vlistState.scrollSize - vlistState.viewportSize - vlistState.scrollOffset;

  beforeEach(() => {
    session = `questions-${++sessionCount}`;
    vlistState.onScroll = null;
    vlistState.scrollOffset = 0;
    vlistState.scrollSize = 3000;
    vlistState.viewportSize = 300;
    resizeObservers = [];
    vi.stubGlobal('ResizeObserver', class {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) { this.callback = callback; }
      observe() { resizeObservers.push(this.callback); }
      unobserve() {}
      disconnect() { resizeObservers = resizeObservers.filter(callback => callback !== this.callback); }
    });
    observers = [];
    vi.stubGlobal('IntersectionObserver', class {
      private readonly entry: { callback: IntersectionObserverCallback; target?: Element };
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.target = target; }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    });
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
    // With two cards open, Jump goes to the newest one, the card the agent waits on.
    fireEvent.click(screen.getByLabelText('Jump to question'));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenLastCalledWith(2, { align: 'start' });

    rerender(view([question(0)], 'other-session'));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenLastCalledWith(0, { align: 'start' });

    // Switching back does not replay the jump the first session already made.
    vlistState.scrollToIndex.mockClear();
    rerender(view([...messages, question(2)]));
    flushFrames();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(expect.any(Number), { align: 'start' });
  });

  it('auto-jumps to the newest of several open questions once, not again when the pane is shown again', () => {
    // An abandoned card stays open above the re-asked question.
    const messages = [question(0), makeMessage(1, { text: 'Asking again' }), question(2), makeMessage(3, { text: '' })];
    const { container } = render(view(messages));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenLastCalledWith(3, { align: 'start' });
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(1, { align: 'start' });

    vlistState.scrollToIndex.mockClear();
    setTranscriptVisible(false);
    flushFrames();
    setTranscriptVisible(true);
    const { pins } = instrumentScroller(container);
    flushFrames();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(expect.any(Number), { align: 'start' });
    // The remounted list falls back to the usual bottom position: a pin of the
    // scroller to its last pixel.
    expect(pins).toContain(3000);
  });

  it('keeps the end in view as rows measure when the pane is shown again with no open question', () => {
    const messages = [makeMessage(0, { text: 'Before' }), question(1, 'AskUserQuestion', '{"answers":{"Continue?":"Yes"}}'), makeMessage(2, { text: 'After' })];
    const { container } = render(view(messages));
    flushFrames();
    setTranscriptVisible(false);
    flushFrames();
    setTranscriptVisible(true);
    instrumentScroller(container);
    flushFrames();
    rowsMeasure(4200);
    flushFrames();
    expect(distanceFromEnd()).toBe(0);
  });

  // Showing the pane again remounts the list; rows estimated before they are
  // measured grow after the one-shot pin to the end.
  const showAgainWithSeenQuestion = () => {
    const messages = [makeMessage(0, { text: 'Before' }), question(1), makeMessage(2, { text: 'After' })];
    const rendered = render(view(messages));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
    vlistState.scrollToIndex.mockClear();
    setTranscriptVisible(false);
    flushFrames();
    setTranscriptVisible(true);
    const scroller = instrumentScroller(rendered.container);
    flushFrames();
    return { ...rendered, ...scroller, messages };
  };

  it('keeps the end in view as rows measure when the pane is shown again with a question already seen', () => {
    const { pins } = showAgainWithSeenQuestion();
    // No replay of the jump, and the list is pinned to its end...
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(expect.any(Number), { align: 'start' });
    expect(pins).toEqual([3000]);
    // ...and rows measured after that pin are followed.
    rowsMeasure(4200);
    flushFrames();
    expect(distanceFromEnd()).toBe(0);
  });

  it('keeps a reader who scrolls up after the pane is shown again where they scrolled', () => {
    const { scroller, pins } = showAgainWithSeenQuestion();
    fireEvent.wheel(scroller, { deltaY: -400 });
    act(() => { vlistState.scrollOffset = 1500; vlistState.onScroll?.(1500); });
    rowsMeasure(4200);
    flushFrames();
    expect(pins).toEqual([3000]);
    expect(vlistState.scrollOffset).toBe(1500);
  });

  it('holds the view at a question jumped to after the pane is shown again', () => {
    const { pins } = showAgainWithSeenQuestion();
    fireEvent.click(screen.getByLabelText('Jump to question'));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
    rowsMeasure(4200);
    flushFrames();
    expect(pins).toEqual([3000]);
  });

  it('jumps to and holds a question opened after the pane is shown again', () => {
    const { pins, messages, rerender } = showAgainWithSeenQuestion();
    rerender(view([...messages, question(3), makeMessage(4, { text: 'Asked again' })]));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenCalledWith(4, { align: 'start' });
    rowsMeasure(4200);
    flushFrames();
    expect(pins).toEqual([3000]);
  });

  it('does not replay the jump when returning to a session remounts the transcript', () => {
    const sessionA = [makeMessage(0, { text: 'Before' }), question(1), makeMessage(2, { text: 'After' })];
    const sessionB = [makeMessage(0, { text: 'Other session' })];
    // WorkstreamSessionTabs and ChatSidebar key the transcript by session.
    const tabs = (active: 'a' | 'b') => (
      <RichTranscriptView key={active} sessionId={`${session}-${active}`} sessionStatus="idle"
        messages={active === 'a' ? sessionA : sessionB} provider="claude-code" persistScrollState={false} />
    );
    const { rerender } = render(tabs('a'));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });

    rerender(tabs('b'));
    flushFrames();
    vlistState.scrollToIndex.mockClear();
    rerender(tabs('a'));
    flushFrames();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(expect.any(Number), { align: 'start' });
  });

  it('retries a jump cut short by a session switch that remounts the transcript', () => {
    const before = [makeMessage(0, { text: 'Before' })];
    const tabs = (active: 'a' | 'b', messages: TranscriptViewMessage[]) => (
      <RichTranscriptView key={active} sessionId={`${session}-${active}`} sessionStatus="idle"
        messages={messages} provider="claude-code" persistScrollState={false} />
    );
    const { rerender } = render(tabs('a', before));
    flushFrames();
    const withQuestion = [...before, question(1), makeMessage(2, { text: 'After' })];
    // The question lands and the jump is issued, but the reader switches away
    // before its reveal frame runs.
    rerender(tabs('a', withQuestion));
    rerender(tabs('b', [makeMessage(0, { text: 'Other' })]));
    flushFrames();
    vlistState.scrollToIndex.mockClear();
    rerender(tabs('a', withQuestion));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
  });

  it('retries a jump cut short by hiding the pane, once', () => {
    const base = [makeMessage(0, { text: 'Before' })];
    const { rerender } = render(view(base));
    flushFrames();
    vlistState.scrollToIndex.mockClear();
    // The question lands; the jump is issued but its reveal frame has not run.
    rerender(view([...base, question(1), makeMessage(2, { text: 'After' })]));
    expect(vlistState.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
    setTranscriptVisible(false);
    flushFrames();
    vlistState.scrollToIndex.mockClear();
    setTranscriptVisible(true);
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
    // Hiding and showing again does not replay it.
    vlistState.scrollToIndex.mockClear();
    setTranscriptVisible(false);
    flushFrames();
    setTranscriptVisible(true);
    flushFrames();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(expect.any(Number), { align: 'start' });
  });

  it('retries a jump cut short by an in-place session switch', () => {
    const withQuestion = [makeMessage(0, { text: 'Before' }), question(1), makeMessage(2, { text: 'After' })];
    const { rerender } = render(view([makeMessage(0, { text: 'Before' })], `${session}-a`));
    flushFrames();
    rerender(view(withQuestion, `${session}-a`));
    rerender(view([makeMessage(0, { text: 'Other' })], `${session}-b`));
    flushFrames();
    vlistState.scrollToIndex.mockClear();
    rerender(view(withQuestion, `${session}-a`));
    flushFrames();
    expect(vlistState.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
  });

  it('does not pull the reader back to the question after they return to the end', () => {
    const messages = [makeMessage(0, { text: 'Before' }), question(1), makeMessage(2, { text: 'After' })];
    const { container, rerender } = render(view(messages));
    flushFrames();
    instrumentScroller(container);
    vlistState.scrollToIndex.mockClear();
    act(() => { container.querySelector<HTMLElement>('.rich-transcript-scroll-button')!.click(); });
    flushFrames();
    rerender(view([...messages]));
    flushFrames();
    rowsMeasure(3500);
    flushFrames();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(expect.any(Number), { align: 'start' });
  });

  it('ignores superseded answers and non-question prompts', () => {
    const answered = question(1, 'AskUserQuestion', '{"answers":{"Continue?":"Yes"}}');
    answered.toolCall!.providerToolCallId = 'question-0';
    render(view([question(0), answered, question(2, 'ToolPermission'), question(3, 'ExitPlanMode')]));
    flushFrames();
    expect(screen.queryByLabelText('Jump to question')).toBeNull();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(expect.any(Number), { align: 'start' });
  });

  it.each([
    ['the answer auto-resume', { text: '[Resuming after answering a question]\n\nContinue?: Yes' }],
    ['an agent send', { text: 'Child finished', promptActor: 'agent' as const }],
    ['an unpersisted optimistic send', { text: 'Do something else', optimistic: true }],
  ])('keeps an unanswered question open after %s', (_label, row) => {
    const answered = question(1, 'AskUserQuestion', '{"answers":{"Continue?":"Yes"}}');
    render(view([answered, question(2), makeMessage(3, { type: 'user_message', ...row })]));
    flushFrames();
    expect(screen.queryByTestId('ask-user-question-skipped')).toBeNull();
    screen.getByTestId('ask-user-question-submit');
  });

  it('closes a question the user moved past with a new message, but not one still open', () => {
    const newTurn = makeMessage(2, { type: 'user_message', text: 'Do something else' });
    const first = render(view([question(1), newTurn]));
    flushFrames();
    expect(screen.queryByLabelText('Jump to question')).toBeNull();
    expect(vlistState.scrollToIndex).not.toHaveBeenCalledWith(expect.any(Number), { align: 'start' });
    screen.getByTestId('ask-user-question-skipped');
    expect(screen.queryByTestId('ask-user-question-submit')).toBeNull();
    expect(screen.queryByTestId('ask-user-question-option')).toBeNull();
    first.unmount();

    // Thinking animates, so frames never settle here; assert without flushing.
    const running = (messages: TranscriptViewMessage[]) => (
      <RichTranscriptView sessionId="questions-running" sessionStatus="running" messages={messages}
        provider="claude-code" persistScrollState={false} />
    );
    const { container, rerender } = render(running([question(1), newTurn]));
    // A skipped question must not hide Thinking for the turn that replaced it.
    expect(container.querySelector('.rich-transcript-waiting')).not.toBeNull();

    // Same question asked after the latest user message: open and answerable.
    rerender(running([makeMessage(0, { type: 'user_message', text: 'Start' }), question(1)]));
    expect(container.querySelector('.rich-transcript-waiting')).toBeNull();
    expect(screen.queryByTestId('ask-user-question-skipped')).toBeNull();
    screen.getByTestId('ask-user-question-submit');
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
    vlistState.onScroll = null;
    vlistState.scrollOffset = 0;
    vlistState.scrollSize = 300;
    vlistState.viewportSize = 100;
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
