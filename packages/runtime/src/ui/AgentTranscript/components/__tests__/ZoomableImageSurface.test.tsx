import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../utils/clipboard', () => ({
  copyImageToClipboard: vi.fn().mockResolvedValue(undefined),
}));

import { ZoomableImageSurface } from '../ZoomableImageSurface';

class ResizeObserverMock {
  observe(target: Element) {
    this.callback([
      {
        target,
        contentRect: {
          width: 400,
          height: 300,
        },
      },
    ] as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }

  unobserve() {}

  disconnect() {}

  constructor(
    private readonly callback: ResizeObserverCallback,
  ) {}
}

// jsdom has no PointerEvent, so fireEvent.pointer* would drop pointerId.
class PointerEventMock extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

describe('ZoomableImageSurface', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.stubGlobal('PointerEvent', PointerEventMock);
  });

  it('fits the image by default and supports zoom controls', async () => {
    render(
      <div style={{ width: 400, height: 300 }}>
        <ZoomableImageSurface src="test.png" alt="Test image" />
      </div>
    );

    const image = screen.getByTestId('zoomable-image') as HTMLImageElement;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 800 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 600 });
    fireEvent.load(image);

    await waitFor(() => {
      expect(screen.getByTestId('zoomable-image-zoom').textContent).toBe('50%');
    });

    fireEvent.click(screen.getByRole('button', { name: '+' }));
    await waitFor(() => {
      expect(screen.getByTestId('zoomable-image-zoom').textContent).toBe('63%');
    });

    fireEvent.click(screen.getByRole('button', { name: '100%' }));
    await waitFor(() => {
      expect(screen.getByTestId('zoomable-image-zoom').textContent).toBe('100%');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    await waitFor(() => {
      expect(screen.getByTestId('zoomable-image-zoom').textContent).toBe('50%');
    });
  });

  it('zooms with a two-finger pinch and with trackpad ctrl+wheel', async () => {
    render(
      <div style={{ width: 400, height: 300 }}>
        <ZoomableImageSurface src="test.png" alt="Test image" />
      </div>
    );

    const image = screen.getByTestId('zoomable-image') as HTMLImageElement;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 800 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 600 });
    fireEvent.load(image);
    await waitFor(() => {
      expect(screen.getByTestId('zoomable-image-zoom').textContent).toBe('50%');
    });

    const viewport = screen.getByTestId('zoomable-image-viewport');
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 150, clientY: 100 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 250, clientY: 100 });
    // Spread from 100px apart to 200px apart: 2x the starting 50% fit scale.
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 300, clientY: 100 });
    await waitFor(() => {
      expect(screen.getByTestId('zoomable-image-zoom').textContent).toBe('100%');
    });
    fireEvent.pointerUp(viewport, { pointerId: 1 });
    fireEvent.pointerUp(viewport, { pointerId: 2 });

    // A plain wheel scrolls; only ctrl+wheel (trackpad pinch) zooms.
    fireEvent.wheel(viewport, { deltaY: -50, clientX: 200, clientY: 150 });
    expect(screen.getByTestId('zoomable-image-zoom').textContent).toBe('100%');
    fireEvent.wheel(viewport, { deltaY: -50, ctrlKey: true, clientX: 200, clientY: 150 });
    await waitFor(() => {
      expect(screen.getByTestId('zoomable-image-zoom').textContent).toBe(`${Math.round(Math.exp(0.5) * 100)}%`);
    });
  });

  it('copies the current image from the toolbar', async () => {
    const { copyImageToClipboard } = await import('../../../../utils/clipboard');

    render(
      <div style={{ width: 400, height: 300 }}>
        <ZoomableImageSurface src="test.png" alt="Test image" copyFilePath="/tmp/test.png" />
      </div>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }));

    await waitFor(() => {
      expect(copyImageToClipboard).toHaveBeenCalledWith({
        src: 'test.png',
        filePath: '/tmp/test.png',
      });
    });
    await screen.findByRole('button', { name: 'Copied' });
  });
});
