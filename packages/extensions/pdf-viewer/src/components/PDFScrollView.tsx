import { forwardRef, useRef, useEffect, useCallback } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { PDFPage } from './PDFPage';
import type { PDFDocumentProxy } from '../hooks/usePDFDocument';

// Get virtua from the host
const { VList } = (window as any).__nimbalyst_extensions.virtua;

interface PDFScrollViewProps {
  document: PDFDocumentProxy | null;
  totalPages: number;
  firstPageWidth: number | null;
  scale: number;
  fitToWidth: boolean;
  theme: string;
  onFitWidthScaleChange?: (scale: number) => void;
}

const GAP = 16; // Gap between pages
const PADDING = 32; // Horizontal padding for container

// Virtua's default fixed-width row contains overflow. Let wide pages contribute
// their width to the scroll area instead of clipping them at manual zoom levels.
const PDFPageRow = forwardRef<HTMLDivElement, { style: CSSProperties; children: ReactNode }>(
  function PDFPageRow({ style, children }, ref) {
    return <div ref={ref} style={{ ...style, width: 'max-content', minWidth: '100%' }}>{children}</div>;
  }
);

export function PDFScrollView({
  document,
  totalPages,
  firstPageWidth,
  scale,
  fitToWidth,
  theme: _theme,
  onFitWidthScaleChange,
}: PDFScrollViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Calculate fit-to-width scale based on container width
  const calculateFitScale = useCallback(() => {
    if (!containerRef.current || firstPageWidth === null) return null;
    const containerWidth = containerRef.current.clientWidth - PADDING;
    const fitScale = containerWidth / firstPageWidth;
    // Clamp scale between reasonable bounds
    return Math.max(0.25, Math.min(3.0, fitScale));
  }, [firstPageWidth]);

  // Update fit-to-width scale when container resizes
  useEffect(() => {
    if (!fitToWidth || !onFitWidthScaleChange) return;

    const updateFitScale = () => {
      const newScale = calculateFitScale();
      if (newScale !== null) onFitWidthScaleChange(newScale);
    };

    // Initial calculation
    updateFitScale();

    // Watch for container resize
    const resizeObserver = new ResizeObserver(updateFitScale);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => resizeObserver.disconnect();
  }, [fitToWidth, calculateFitScale, onFitWidthScaleChange]);

  if (!document) {
    return (
      <div
        ref={containerRef}
        className="pdf-scroll-view flex-1 overflow-y-auto overflow-x-hidden scroll-smooth"
        style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <div>No document loaded</div>
      </div>
    );
  }

  // Create array of page numbers
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);

  return (
    <div
      ref={containerRef}
      className="pdf-scroll-view flex-1 overflow-y-auto overflow-x-hidden scroll-smooth"
      style={{
        height: '100%',
        backgroundColor: 'var(--nim-bg-secondary)',
      }}
    >
      <VList
        style={{ height: '100%' }}
        item={PDFPageRow}
      >
        {pages.map((pageNumber) => (
          <div
            key={pageNumber}
            style={{
              display: 'flex',
              justifyContent: 'center',
              paddingTop: `${GAP / 2}px`,
              paddingBottom: `${GAP / 2}px`,
            }}
          >
            <PDFPage
              document={document}
              pageNumber={pageNumber}
              scale={scale}
            />
          </div>
        ))}
      </VList>
    </div>
  );
}
