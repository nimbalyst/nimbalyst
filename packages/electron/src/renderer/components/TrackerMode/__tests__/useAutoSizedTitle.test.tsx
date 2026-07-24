/**
 * Renders a title field wired exactly like TrackerItemDetail's header so the
 * ref/observer plumbing of useAutoSizedTitle is covered, not just the math.
 */
import React, { useState } from 'react';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useAutoSizedTitle, sanitizeTitleInput } from '../trackerTitleAutoSize';

/** jsdom has no layout: fake scrollHeight as one 24px row per 40 characters. */
beforeAll(() => {
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return Math.max(1, Math.ceil(this.value.length / 40)) * 24;
    },
  });
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function TitleField({ initial }: { initial: string }) {
  const [title, setTitle] = useState(initial);
  const titleRef = useAutoSizedTitle(title);
  return (
    <textarea
      ref={titleRef}
      rows={1}
      value={title}
      onChange={e => setTitle(sanitizeTitleInput(e.target.value))}
      data-testid="tracker-detail-title"
    />
  );
}

const LONG_TITLE = 'Tracker titles do not wrap in detail view and this one is long enough to need three rows';

describe('useAutoSizedTitle', () => {
  it('sizes the field to its content on mount', () => {
    render(<TitleField initial="Short title" />);
    expect(screen.getByTestId('tracker-detail-title').style.height).toBe('24px');
  });

  it('grows to fit a long title instead of keeping it on one line', () => {
    render(<TitleField initial={LONG_TITLE} />);
    expect(screen.getByTestId('tracker-detail-title').style.height).toBe('72px');
  });

  it('regrows and shrinks as the title is edited', () => {
    render(<TitleField initial="Short title" />);
    const el = screen.getByTestId('tracker-detail-title') as HTMLTextAreaElement;

    fireEvent.change(el, { target: { value: LONG_TITLE } });
    expect(el.style.height).toBe('72px');

    fireEvent.change(el, { target: { value: 'Short again' } });
    expect(el.style.height).toBe('24px');
  });

  it('re-fits when the pane width changes', () => {
    const callbacks: Array<(entries: any[]) => void> = [];
    const observed: Element[] = [];
    globalThis.ResizeObserver = class {
      constructor(cb: (entries: any[]) => void) { callbacks.push(cb); }
      observe(el: Element) { observed.push(el); }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    render(<TitleField initial={LONG_TITLE} />);
    const el = screen.getByTestId('tracker-detail-title') as HTMLTextAreaElement;
    expect(observed).toContain(el);

    el.style.height = '999px';
    callbacks[0]([{ contentRect: { width: 300 } }]);
    expect(el.style.height).toBe('72px');

    // Height-only changes must not re-trigger a resize (feedback loop guard).
    const spy = vi.spyOn(el.style, 'height', 'set');
    callbacks[0]([{ contentRect: { width: 300 } }]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
