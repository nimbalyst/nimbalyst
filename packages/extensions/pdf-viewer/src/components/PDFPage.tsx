import { useRef, useEffect, useState, useMemo } from 'react';
import type { PDFDocumentProxy } from '../hooks/usePDFDocument';

// Get PDF.js from host for TextLayer class
const pdfjsLib = (window as any).__nimbalyst_extensions['pdfjs-dist'];

interface PDFPageProps {
  document: PDFDocumentProxy | null;
  pageNumber: number;
  scale: number;
  width: number;
  height: number;
}

// Custom hook for debounced value
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

export function PDFPage({ document, pageNumber, scale, width, height }: PDFPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<any>(null);
  const [rendering, setRendering] = useState(false);

  // Debounce scale changes to prevent excessive re-renders during zoom
  const debouncedScale = useDebouncedValue(scale, 100);

  // Memoize container styles
  const containerStyle = useMemo(
    () => ({
      width,
      height,
      display: 'flex' as const,
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
      position: 'relative' as const,
    }),
    [width, height]
  );

  useEffect(() => {
    if (!document || !canvasRef.current) return;

    let cancelled = false;
    let textLayerInstance: any = null;
    setRendering(true);

    const renderPage = async () => {
      try {
        // Cancel any previous render task
        if (renderTaskRef.current?.cancel) {
          renderTaskRef.current.cancel();
        }

        const page = await document.getPage(pageNumber);
        if (cancelled) return;

        const canvas = canvasRef.current;
        if (!canvas) return;

        const context = canvas.getContext('2d');
        if (!context) return;

        const viewport = page.getViewport({ scale: debouncedScale });

        // Set canvas dimensions
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        // Render the canvas layer
        const renderContext = {
          canvasContext: context,
          viewport: viewport,
        };

        const renderTask = page.render(renderContext);
        renderTaskRef.current = renderTask;

        await renderTask.promise;
        if (cancelled) return;

        // Render the text layer for text selection
        if (textLayerRef.current && pdfjsLib?.TextLayer) {
          // Clear previous text layer content
          textLayerRef.current.innerHTML = '';

          // Set the scale factor CSS variable (required by PDF.js text layer)
          textLayerRef.current.style.setProperty('--scale-factor', debouncedScale.toString());

          // Get text content from the page
          const textContent = await page.getTextContent();
          if (cancelled) return;

          // Create and render text layer using the new TextLayer class API
          textLayerInstance = new pdfjsLib.TextLayer({
            textContentSource: textContent,
            container: textLayerRef.current,
            viewport: viewport,
          });

          await textLayerInstance.render();
        }

        if (!cancelled) {
          setRendering(false);
        }
      } catch (err: any) {
        // Ignore cancellation errors
        if (err?.name === 'RenderingCancelledException') return;

        if (!cancelled) {
          console.error(`Error rendering page ${pageNumber}:`, err);
          setRendering(false);
        }
      }
    };

    renderPage();

    return () => {
      cancelled = true;
      // Cancel canvas render task if in progress
      if (renderTaskRef.current?.cancel) {
        renderTaskRef.current.cancel();
      }
      // Cancel text layer rendering if in progress
      if (textLayerInstance?.cancel) {
        textLayerInstance.cancel();
      }
    };
  }, [document, pageNumber, debouncedScale]);

  return (
    <div className="relative flex justify-center items-center bg-white shadow-[0_2px_8px_rgba(0,0,0,0.1)] rounded-sm" style={containerStyle}>
      <canvas ref={canvasRef} style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }} />
      <div
        ref={textLayerRef}
        className="textLayer"
        style={{
          position: 'absolute',
          top: 0,
          left: '50%',
          transform: 'translateX(-50%)',
        }}
      />
      {rendering && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/70 text-white px-4 py-2 rounded text-sm">
          Loading...
        </div>
      )}
    </div>
  );
}
