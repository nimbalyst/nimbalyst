import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { PDFDocumentProxy } from '../hooks/usePDFDocument';

const textLayers: { viewport: { width: number; height: number } }[] = [];
const getDocument = vi.fn();
let resize: () => void;
let containerWidth = 1000;

beforeAll(() => {
  (window as any).__nimbalyst_extensions = {
    virtua: { VList: ({ children }: { children: ReactNode }) => <div>{children}</div> },
    'pdfjs-dist': {
      getDocument,
      GlobalWorkerOptions: { workerSrc: 'test-worker' },
      TextLayer: class {
        constructor(options: { viewport: { width: number; height: number } }) {
          textLayers.push(options);
        }
        render() { return Promise.resolve(); }
        cancel() {}
      },
    },
  };
});

beforeEach(() => {
  textLayers.length = 0;
  containerWidth = 1000;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => containerWidth);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function documentWithPages(sizes: [number, number][]): PDFDocumentProxy {
  return {
    numPages: sizes.length,
    getMetadata: vi.fn(),
    getPage: vi.fn(async (number: number) => ({
      // These are PDF.js viewport dimensions, after page rotation and cropping.
      getViewport: ({ scale }: { scale: number }) => ({
        width: sizes[number - 1][0] * scale,
        height: sizes[number - 1][1] * scale,
        scale,
      }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      getTextContent: async () => ({ items: [] }),
    })),
  };
}

describe('PDF page geometry', () => {
  it('uses each page viewport for its box, canvas and text layer, including after zoom', async () => {
    const { PDFScrollView } = await import('../components/PDFScrollView');
    const document = documentWithPages([[792, 612], [612, 792], [841.89, 595.28]]);
    const props = { document, totalPages: 3, firstPageWidth: 792, scale: 1, fitToWidth: false, theme: 'light' };
    const view = render(<PDFScrollView {...props} />);
    await waitFor(() => expect(textLayers).toHaveLength(3));
    const canvases = [...view.container.querySelectorAll('canvas')];
    for (const [index, canvas] of canvases.entries()) {
      const { width, height } = textLayers[index].viewport;
      expect(canvas.parentElement?.style.width).toBe(`${width}px`);
      expect(canvas.parentElement?.style.height).toBe(`${height}px`);
    }
    view.rerender(<PDFScrollView {...props} scale={1.5} />);
    await waitFor(() => expect(textLayers).toHaveLength(6));
    expect(canvases[0].parentElement?.style.width).toBe('1188px');
    expect(canvases[0].parentElement?.style.height).toBe('918px');
    expect(canvases[0].width).toBe(1188);
    expect(textLayers[3].viewport).toMatchObject({ width: 1188, height: 918 });
  });

  it('fits the real first-page width and recalculates on resize and document geometry changes', async () => {
    const { PDFScrollView } = await import('../components/PDFScrollView');
    const onFitWidthScaleChange = vi.fn();
    const props = { document: documentWithPages([[792, 612]]), totalPages: 1, firstPageWidth: 792, scale: 1, fitToWidth: true, theme: 'light', onFitWidthScaleChange };
    const view = render(<PDFScrollView {...props} />);
    await waitFor(() => expect(textLayers).toHaveLength(1));
    expect(onFitWidthScaleChange).toHaveBeenLastCalledWith(968 / 792);
    containerWidth = 700;
    act(() => resize());
    expect(onFitWidthScaleChange).toHaveBeenLastCalledWith(668 / 792);
    view.rerender(<PDFScrollView {...props} firstPageWidth={612} />);
    expect(onFitWidthScaleChange).toHaveBeenLastCalledWith(668 / 612);
  });

  it('loads first-page geometry before exposing the document', async () => {
    const { usePDFDocument } = await import('../hooks/usePDFDocument');
    const document = documentWithPages([[792, 612]]);
    getDocument.mockReturnValue({ promise: Promise.resolve(document) });
    const { result } = renderHook(() => usePDFDocument(async () => new ArrayBuffer(0), 'landscape.pdf'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ document, firstPageWidth: 792, error: null });
  });
});
