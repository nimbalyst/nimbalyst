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
    vlistState.scrollToIndex.mockClear();
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
