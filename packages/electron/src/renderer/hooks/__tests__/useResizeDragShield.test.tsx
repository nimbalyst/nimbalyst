// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useResizeDragShield } from '../useResizeDragShield';

function pointerDown(clientX = 200): ReactPointerEvent<HTMLElement> {
  return {
    button: 0,
    clientX,
    preventDefault: vi.fn(),
  } as unknown as ReactPointerEvent<HTMLElement>;
}

function dispatchPointer(target: EventTarget, type: string, clientX = 0): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX }));
}

afterEach(() => {
  document.querySelector('.resize-drag-shield')?.remove();
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

describe('useResizeDragShield', () => {
  it('keeps resize pointer events in the host document above iframe content', () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const { result } = renderHook(() => useResizeDragShield({ onMove, onEnd }));
    const startEvent = pointerDown();

    act(() => result.current(startEvent));

    const shield = document.querySelector<HTMLElement>('.resize-drag-shield');
    expect(startEvent.preventDefault).toHaveBeenCalledOnce();
    expect(shield).not.toBeNull();
    expect(shield?.style.position).toBe('fixed');
    expect(shield?.style.inset).toBe('0');
    expect(shield?.style.zIndex).toBe('2147483647');

    act(() => dispatchPointer(shield!, 'pointermove', 360));
    expect(onMove).toHaveBeenCalledOnce();
    expect(onMove.mock.calls[0][0].clientX).toBe(360);

    act(() => dispatchPointer(shield!, 'pointerup', 360));
    expect(onEnd).toHaveBeenCalledOnce();
    expect(document.querySelector('.resize-drag-shield')).toBeNull();
    iframe.remove();
  });

  it('ends the drag on pointer cancellation and restores existing body styles', () => {
    document.body.style.cursor = 'wait';
    document.body.style.userSelect = 'text';
    const onEnd = vi.fn();
    const { result } = renderHook(() => useResizeDragShield({ onMove: vi.fn(), onEnd }));

    act(() => result.current(pointerDown()));
    const shield = document.querySelector<HTMLElement>('.resize-drag-shield');
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');

    act(() => dispatchPointer(shield!, 'pointercancel'));
    expect(onEnd).toHaveBeenCalledOnce();
    expect(document.body.style.cursor).toBe('wait');
    expect(document.body.style.userSelect).toBe('text');
  });

  it('cleans up without ending the drag when the owning component unmounts', () => {
    const onEnd = vi.fn();
    const { result, unmount } = renderHook(() => useResizeDragShield({ onMove: vi.fn(), onEnd }));

    act(() => result.current(pointerDown()));
    unmount();

    expect(document.querySelector('.resize-drag-shield')).toBeNull();
    expect(onEnd).not.toHaveBeenCalled();
  });
});
