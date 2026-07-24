import { useRef, useEffect, useCallback } from 'react';
import { PDFPage } from './PDFPage';
import type { PDFDocumentProxy } from '../hooks/usePDFDocument';

// Get virtua from the host
const { VList } = (window as any).__nimbalyst_extensions.virtua;

interface PDFScrollViewProps {
  document: PDFDocumentProxy | null;
  totalPages: number;
  scale: number;
  fitToWidth: boolean;
  theme: string;
  onFitWidthScaleChange?: (scale: number) => void;
}

// Standard PDF page dimensions in points
const PAGE_WIDTH = 612; // US Letter width in points
const PAGE_HEIGHT = 792; // US Letter height in points
const GAP = 16; // Gap between pages
const PADDING = 32; // Horizontal padding for container

export function PDFScrollView({
  document,
  totalPages,
  scale,
  fitToWidth,
  theme: _theme,
  onFitWidthScaleChange,
}: PDFScrollViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Calculate fit-to-width scale based on container width
  const calculateFitScale = useCallback(() => {
    if (!containerRef.current) return 1.0;
    const containerWidth = containerRef.current.clientWidth - PADDING;
    const fitScale = containerWidth / PAGE_WIDTH;
    // Clamp scale between reasonable bounds
    return Math.max(0.25, Math.min(3.0, fitScale));
  }, []);

  // Update fit-to-width scale when container resizes
  useEffect(() => {
    if (!fitToWidth || !onFitWidthScaleChange) return;

    const updateFitScale = () => {
      const newScale = calculateFitScale();
      onFitWidthScaleChange(newScale);
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

  const scaledWidth = PAGE_WIDTH * scale;
  const scaledHeight = PAGE_HEIGHT * scale;

  if (!document) {
    return (
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden scroll-smooth"
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
      className="flex-1 overflow-y-auto overflow-x-hidden scroll-smooth"
      style={{
        height: '100%',
        backgroundColor: 'var(--nim-bg-secondary)',
      }}
    >
      <VList
        style={{ height: '100%' }}
        overscan={2}
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
              width={scaledWidth}
              height={scaledHeight}
            />
          </div>
        ))}
      </VList>
    </div>
  );
}
