/**
 * The scroll-to-bottom overlay spans the full pane width and is only faded with
 * opacity, so if it ever becomes interactive it turns the bottom of the
 * transcript into a dead band that swallows clicks, drags, selection and the
 * wheel — while looking completely normal. Only the button inside it may opt
 * back in. That is asserted on the DOM the component actually produces (class
 * plus inline style), not on injected stylesheet text.
 */
import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RichTranscriptView } from '../RichTranscriptView';

const vlistState = vi.hoisted(() => ({
  onScroll: null as ((offset: number) => void) | null,
  scrollSize: 3000,
  viewportSize: 300,
}));

vi.mock('virtua', async () => {
  const ReactModule = await import('react');
  return {
    VList: ReactModule.forwardRef(
      (
        { children, onScroll }: { children: React.ReactNode; onScroll?: (offset: number) => void },
        ref,
      ) => {
        vlistState.onScroll = onScroll ?? null;
        ReactModule.useImperativeHandle(ref, () => ({
          cache: undefined,
          scrollOffset: 0,
          scrollSize: vlistState.scrollSize,
          viewportSize: vlistState.viewportSize,
          findItemIndex: () => 0,
          scrollToIndex: vi.fn(),
          scrollTo: vi.fn(),
        }));
        return <div>{ReactModule.Children.toArray(children)}</div>;
      },
    ),
  };
});

describe('RichTranscriptView scroll-to-bottom overlay', () => {
  beforeEach(() => {
    vlistState.onScroll = null;
    vi.stubGlobal('CSS', { highlights: { delete: vi.fn(), set: vi.fn() } });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
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
