// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useMapViewport, type MapViewport } from '../typeMap/useMapViewport';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function setup() {
  let api: MapViewport;
  const select = vi.fn();
  function Harness() {
    api = useMapViewport(null);
    return <div ref={api.canvasRef} onClick={() => { if (!api.dragged()) select(); }}>
      <svg ref={api.svgRef}><g ref={api.sceneRef} /></svg>
      <div className="type-map-hud"><button>Control</button></div>
    </div>;
  }
  const rendered = render(<Harness />);
  const canvas = rendered.container.firstElementChild as HTMLDivElement;
  const captured = new Set<number>();
  canvas.setPointerCapture = vi.fn((id: number) => { captured.add(id); });
  canvas.hasPointerCapture = (id: number) => captured.has(id);
  canvas.releasePointerCapture = vi.fn((id: number) => { captured.delete(id); });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20 } as DOMRect);
  const view = () => {
    const numbers = canvas.querySelector('g')!.getAttribute('transform')?.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)?.map(Number);
    return numbers ? { x: numbers[0], y: numbers[1], k: numbers[2] } : { x: 0, y: 0, k: 1 };
  };
  const pointer = (type: string, id: number, x: number, y: number, target: Element = canvas) => {
    // jsdom has no native PointerEvent constructor.
    const event = new MouseEvent(type, { bubbles: true, clientX: x + 10, clientY: y + 20, button: 0 });
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: 'touch' } });
    fireEvent(target, event);
  };
  return { canvas, view, pointer, select, api: () => api!, unmount: rendered.unmount };
}

test('two-finger scrolling pans both axes; ctrl-wheel pinch zooms around the cursor and clamps', () => {
  const { canvas, view } = setup();
  fireEvent.wheel(canvas, { deltaX: 30, deltaY: 40 });
  expect(view()).toEqual({ x: -30, y: -40, k: 1 });
  fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -Math.log(2) / 0.01, clientX: 110, clientY: 120 });
  expect(view().k).toBeCloseTo(2);
  expect(view().x).toBeCloseTo(-160);
  expect(view().y).toBeCloseTo(-180);
  fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -10000 });
  expect(view().k).toBe(3);
  fireEvent.wheel(canvas, { ctrlKey: true, deltaY: 10000 });
  expect(view().k).toBe(0.2);
});

test('two touches pan and pinch together, then lifting one continues without a jump or selection', () => {
  vi.useFakeTimers();
  const { canvas, view, pointer, select } = setup();
  pointer('pointerdown', 1, 100, 100);
  pointer('pointerdown', 2, 200, 100);
  pointer('lostpointercapture', 1, 100, 100, canvas.querySelector('g')!);
  pointer('pointermove', 1, 120, 130);
  pointer('pointermove', 2, 220, 130);
  expect(view().x).toBeCloseTo(20);
  expect(view().y).toBeCloseTo(30);
  expect(view().k).toBeCloseTo(1);
  pointer('pointermove', 2, 320, 130);
  expect(view().k).toBeCloseTo(2);
  expect(view().x).toBeCloseTo(-80);
  expect(view().y).toBeCloseTo(-70);
  pointer('pointerup', 2, 320, 130);
  vi.runAllTimers();
  fireEvent.click(canvas);
  expect(select).not.toHaveBeenCalled();
  pointer('pointermove', 1, 130, 140);
  expect(view().x).toBeCloseTo(-70);
  expect(view().y).toBeCloseTo(-60);
  pointer('pointerup', 1, 130, 140);
  fireEvent.click(canvas);
  expect(select).not.toHaveBeenCalled();
  pointer('pointerdown', 3, 150, 150);
  pointer('pointerup', 3, 150, 150);
  fireEvent.click(canvas);
  expect(select).toHaveBeenCalledOnce();
});

test('unrelated releases and controls do not interrupt a gesture; cancellation releases it', () => {
  const { canvas, pointer, view } = setup();
  pointer('pointerdown', 1, 100, 100);
  pointer('pointerup', 9, 0, 0);
  pointer('pointerdown', 2, 0, 0, canvas.querySelector('button')!);
  pointer('pointermove', 1, 110, 115);
  expect(view()).toEqual({ x: 10, y: 15, k: 1 });
  pointer('pointercancel', 1, 110, 115);
  pointer('pointermove', 1, 200, 200);
  expect(view()).toEqual({ x: 10, y: 15, k: 1 });
  expect(canvas.hasPointerCapture(1)).toBe(false);
});

test('manual gestures cancel an in-progress animated focus', () => {
  const { api, canvas } = setup();
  const cancel = vi.spyOn(window, 'cancelAnimationFrame');
  api().focus({ x: 0, y: 0, w: 100, h: 100 });
  fireEvent.wheel(canvas, { deltaY: 20 });
  expect(cancel).toHaveBeenCalled();
});

test('mouse drags, lost capture and unmount clean up without leaving a stuck gesture', () => {
  const { canvas, view, pointer, unmount } = setup();
  fireEvent(canvas, Object.assign(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 110, clientY: 120 }), { pointerId: 5, pointerType: 'mouse' }));
  pointer('pointermove', 5, 120, 140);
  expect(view()).toEqual({ x: 20, y: 40, k: 1 });
  canvas.releasePointerCapture(5);
  pointer('lostpointercapture', 5, 120, 140);
  pointer('pointermove', 5, 200, 200);
  expect(view()).toEqual({ x: 20, y: 40, k: 1 });
  pointer('pointerdown', 6, 100, 100);
  pointer('pointermove', 6, 110, 110);
  unmount();
  expect(canvas.hasPointerCapture(6)).toBe(false);
  expect(canvas.hasAttribute('data-dragging')).toBe(false);
});
