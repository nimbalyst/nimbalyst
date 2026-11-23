/**
 * The scroll-to-bottom overlay spans the full pane width and is only faded with
 * opacity, so if it ever becomes interactive it turns the bottom of the
 * transcript into a dead band that swallows clicks, drags, selection and the
 * wheel — while looking completely normal. Only the button inside it may opt
 * back in. That is asserted on the DOM the component actually produces (class
 * plus inline style), not on injected stylesheet text.
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RichTranscriptView } from '../RichTranscriptView';

const vlistState = vi.hoisted(() => ({
  onScroll: null as ((offset: number) => void) | null,
  scrollSize: 3000,
  viewportSize: 300,
  scrollOffset: 0,
  scrollToIndex: vi.fn(),
}));

vi.mock('virtua', async () => {
  const ReactModule = await import('react');
  return {
    VList: ReactModule.forwardRef(
      (
        { children, onScroll, className }: { children: React.ReactNode; onScroll?: (offset: number) => void; className?: string },
        ref,
      ) => {
        vlistState.onScroll = onScroll ?? null;
        ReactModule.useImperativeHandle(ref, () => ({
          cache: undefined,
          get scrollOffset() { return vlistState.scrollOffset; },
          scrollSize: vlistState.scrollSize,
          viewportSize: vlistState.viewportSize,
          findItemIndex: () => 0,
          getItemOffset: () => 0,
          scrollToIndex: vlistState.scrollToIndex,
          scrollTo: vi.fn(),
        }));
        return <div className={className}>{ReactModule.Children.toArray(children)}</div>;
      },
    ),
  };
});

describe('RichTranscriptView scroll-to-bottom overlay', () => {
  beforeEach(() => {
    vlistState.onScroll = null;
    vlistState.scrollOffset = 0;
    vlistState.scrollToIndex.mockReset();
    vi.stubGlobal('CSS', { highlights: { delete: vi.fn(), set: vi.fn() } });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it('follows streamed updates until the reader leaves the bottom, then resumes on return', () => {
    const message = {
      id: 1, sequence: 1, createdAt: new Date(1_784_648_445_000),
      type: 'assistant_message' as const, subagentId: null, text: 'First chunk',
    };
    const view = (text: string) => (
      <RichTranscriptView sessionId="stream-follow-contract" sessionStatus="running"
        messages={[{ ...message, text }]} provider="claude-code" persistScrollState={false} />
    );
    const { container, rerender } = render(view(message.text));
    // Following pins the list to its last pixel (past the trailing waiting row).
    const scroller = container.querySelector<HTMLElement>('.rich-transcript-vlist')!;
    const pins: number[] = [];
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => vlistState.scrollSize });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true, get: () => vlistState.scrollOffset, set: (top: number) => { pins.push(top); },
    });
    const scrollTo = (offset: number) => act(() => { vlistState.scrollOffset = offset; vlistState.onScroll?.(offset); });
    const stream = (() => { let text = message.text; return () => rerender(view(text += ' more')); })();

    // A same-row Markdown update can grow well beyond the near-bottom threshold.
    stream();
    expect(pins).toEqual([vlistState.scrollSize]);
    scrollTo(2700);

    // The reader wheels up to read.
    fireEvent.wheel(scroller, { deltaY: -400 });
    scrollTo(900);
    stream();
    expect(pins).toHaveLength(1);

    // Back at the end, following resumes.
    scrollTo(2700);
    stream();
    expect(pins).toHaveLength(2);

    // Dragging the scrollbar up a line stays inside the bottom band, but it is
    // the reader leaving.
    fireEvent.pointerDown(scroller);
    scrollTo(2680);
    fireEvent.pointerUp(window);
    stream();
    expect(pins).toHaveLength(2);

    // So is a wheel turned upward, before the scroll it causes has landed.
    scrollTo(2700);
    fireEvent.wheel(scroller, { deltaY: -40 });
    stream();
    expect(pins).toHaveLength(2);
  });

  // Mounts a running session at the end of its transcript. `pins` records every
  // scrollTop write; `resize` delivers a row resize the way the browser does:
  // the component's observers first, then virtua re-aiming any scrollToIndex it
  // still has in flight (virtua 0.51.3 keeps re-aiming until 150ms pass without
  // a resize, and only a newer imperative scroll supersedes it; a smooth one
  // aims once and lets go).
  function mountStreaming() {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { observers.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    let inFlightJump: number | null = null;
    vlistState.scrollToIndex.mockImplementation((index: number, options?: { smooth?: boolean }) => {
      inFlightJump = options?.smooth ? null : index;
    });
    const message = {
      id: 1, sequence: 1, createdAt: new Date(1_784_648_445_000),
      type: 'assistant_message' as const, subagentId: null, text: 'First chunk',
    };
    const ref = React.createRef<{ scrollToMessage: (index: number) => void }>();
    let text = message.text;
    const view = () => (
      <RichTranscriptView ref={ref as never} sessionId="stream-touch-nav" sessionStatus="running"
        messages={[{ ...message, text }]} provider="claude-code" persistScrollState={false} />
    );
    const { container, rerender } = render(view());
    const scroller = container.querySelector<HTMLElement>('.rich-transcript-vlist')!;
    const pins: number[] = [];
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => vlistState.scrollSize });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true, get: () => vlistState.scrollOffset, set: (top: number) => { pins.push(top); },
    });
    const JUMP_TARGET_OFFSET = 1200;
    return {
      container, scroller, pins, ref, JUMP_TARGET_OFFSET,
      scrollTo: (offset: number) => act(() => { vlistState.scrollOffset = offset; vlistState.onScroll?.(offset); }),
      stream: () => { text += ' more'; rerender(view()); },
      resize: () => act(() => {
        observers.forEach(callback => callback([], {} as ResizeObserver));
        if (inFlightJump !== null) scroller.scrollTop = JUMP_TARGET_OFFSET;
      }),
    };
  }

  it('keeps a touch reader where they scrolled after native panning cancels the pointer', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { scroller, pins, scrollTo, resize } = mountStreaming();
      scrollTo(2700);
      resize();
      const pinned = pins.length;
      expect(pins.at(-1)).toBe(vlistState.scrollSize);

      // The browser takes over the gesture for native panning and cancels the
      // pointer, then the finger drags the transcript up a little.
      // jsdom has no PointerEvent, so carry pointerType on a plain event.
      const touchDown = () => {
        const event = new MouseEvent('pointerdown', { bubbles: true });
        Object.defineProperty(event, 'pointerType', { value: 'touch' });
        fireEvent(scroller, event);
      };
      touchDown();
      fireEvent.pointerCancel(scroller);
      scrollTo(2650);
      resize();
      expect(pins).toHaveLength(pinned);

      // The finger lifts and momentum carries the scroll further up.
      fireEvent.touchEnd(window);
      scrollTo(2400);
      resize();
      vi.advanceTimersByTime(500);
      resize();
      expect(pins).toHaveLength(pinned);

      // A quick flick: the finger lifts before the list moves, and all of the
      // upward travel is momentum.
      scrollTo(2700);
      resize();
      const repinned = pins.length;
      expect(repinned).toBeGreaterThan(pinned);
      touchDown();
      fireEvent.pointerCancel(scroller);
      fireEvent.touchEnd(window);
      scrollTo(2600);
      resize();
      vi.advanceTimersByTime(100);
      scrollTo(2300);
      resize();
      vi.advanceTimersByTime(500);
      resize();
      expect(pins).toHaveLength(repinned);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops an outstanding jump when the reader returns to the end mid-stream', () => {
    const { container, pins, ref, scrollTo, stream, resize, JUMP_TARGET_OFFSET } = mountStreaming();
    scrollTo(2700);

    // A jump (search hit, message link, permission prompt) is still re-aiming
    // at its row while the reply streams.
    act(() => ref.current!.scrollToMessage(0));
    scrollTo(JUMP_TARGET_OFFSET);
    resize();
    expect(pins.at(-1)).toBe(JUMP_TARGET_OFFSET);

    // The reader clicks back to the end: streamed growth keeps them there.
    fireEvent.click(container.querySelector('.rich-transcript-scroll-button')!);
    scrollTo(2700);
    let mark = pins.length;
    stream();
    resize();
    expect(pins.slice(mark)).not.toContain(JUMP_TARGET_OFFSET);
    expect(pins.at(-1)).toBe(vlistState.scrollSize);

    // Same when they scroll back down to the end themselves.
    act(() => ref.current!.scrollToMessage(0));
    scrollTo(JUMP_TARGET_OFFSET);
    scrollTo(2700);
    mark = pins.length;
    stream();
    resize();
    expect(pins.slice(mark)).not.toContain(JUMP_TARGET_OFFSET);
    expect(pins.at(-1)).toBe(vlistState.scrollSize);
  });

  it('only ever makes the button interactive, never the full-width band', () => {
    const { container } = render(
      <RichTranscriptView
        sessionId="session-1"
        sessionStatus="idle"
        messages={[
          {
            id: 1,
            sequence: 1,
            createdAt: new Date(1_784_648_445_000),
            type: 'assistant_message',
            subagentId: null,
            text: 'hello',
          },
        ]}
        provider="claude-code"
        persistScrollState={false}
      />,
    );

    const overlay = container.querySelector<HTMLElement>('.rich-transcript-scroll-button-container')!;
    const button = container.querySelector<HTMLElement>('.rich-transcript-scroll-button')!;

    // Scroll far from the bottom so the button becomes visible.
    act(() => vlistState.onScroll?.(0));
    expect(overlay.style.opacity).toBe('1');
    expect(overlay.className).toContain('pointer-events-none');
    expect(overlay.style.pointerEvents).toBe('');
    expect(button.style.pointerEvents).toBe('auto');

    // Back near the bottom: the button hides and goes inert again, inheriting
    // `none` from the band rather than staying clickable under a faded overlay.
    act(() => vlistState.onScroll?.(vlistState.scrollSize - vlistState.viewportSize));
    expect(overlay.style.opacity).toBe('0');
    expect(button.style.pointerEvents).toBe('');
  });
});
