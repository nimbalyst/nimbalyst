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

describe('ZoomableImageSurface', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
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
    expect(screen.getByRole('button', { name: 'Copied' })).toBeDefined();
  });
});
