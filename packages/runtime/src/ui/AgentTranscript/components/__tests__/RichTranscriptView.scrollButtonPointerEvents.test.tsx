import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
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

        return <div data-testid="mock-vlist">{ReactModule.Children.toArray(children)}</div>;
      },
    ),
  };
});

function makeMessage(index: number): TranscriptViewMessage {
  return {
    id: index + 1,
    sequence: index + 1,
    createdAt: new Date(1_784_648_445_000 + index),
    type: 'assistant_message',
    subagentId: null,
    text: `message ${index}`,
  };
}

/**
 * Tailwind utilities aren't loaded in jsdom, so declare the two the overlay relies on.
 * This lets getComputedStyle resolve the real cascade (class vs inline style).
 */
function installPointerEventUtilities(): void {
  const style = document.createElement('style');
  style.textContent = `
    .pointer-events-none { pointer-events: none; }
    .pointer-events-auto { pointer-events: auto; }
  `;
  document.head.appendChild(style);
}

describe('RichTranscriptView scroll-to-bottom overlay', () => {
  beforeEach(() => {
    vlistState.onScroll = null;
    installPointerEventUtilities();
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

  it('never captures pointer events outside the button, including while visible', () => {
    const { container } = render(
      <RichTranscriptView
        sessionId="session-1"
        sessionStatus="idle"
        messages={[makeMessage(0), makeMessage(1)]}
        provider="claude-code"
        persistScrollState={false}
      />,
    );

    const overlay = container.querySelector<HTMLElement>('.rich-transcript-scroll-button-container');
    const button = container.querySelector<HTMLElement>('.rich-transcript-scroll-button');
    expect(overlay).not.toBeNull();
    expect(button).not.toBeNull();

    // Hidden state: faded out, so nothing in the band may capture - not even the button.
    expect(getComputedStyle(overlay!).pointerEvents).toBe('none');
    expect(getComputedStyle(button!).pointerEvents).toBe('none');

    // Scroll far from the bottom so the button becomes visible.
    act(() => {
      vlistState.onScroll?.(0);
    });

    expect(overlay!.style.opacity).toBe('1');
    // The overlay spans the full pane width; only the button may be interactive,
    // otherwise it becomes a dead band for clicks, drags, selection and the wheel.
    expect(getComputedStyle(overlay!).pointerEvents).toBe('none');
    expect(getComputedStyle(button!).pointerEvents).toBe('auto');

    // Scrolled back near the bottom: the button hides and goes inert again.
    act(() => {
      vlistState.onScroll?.(vlistState.scrollSize - vlistState.viewportSize);
    });

    expect(overlay!.style.opacity).toBe('0');
    expect(getComputedStyle(button!).pointerEvents).toBe('none');
  });
});
