/**
 * PDF Viewer Editor
 *
 * Read-only viewer for PDF files.
 * Uses the EditorHost API for host communication.
 *
 * Note: PDFs are binary and read-only, so this viewer:
 * - Loads content via electronAPI.readFileContent (binary mode)
 * - Never marks as dirty
 * - Doesn't implement save functionality
 */

import { useState, useEffect, useCallback } from 'react';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';
import { useEditorLifecycle } from '@nimbalyst/extension-sdk';
import { usePDFDocument } from './hooks/usePDFDocument';
import { PDFScrollView } from './components/PDFScrollView';
import { Toolbar } from './components/Toolbar';

export function PDFViewerEditor({ host }: EditorHostProps) {
  const { filePath, isActive } = host;

  // useEditorLifecycle handles theme reactivity. PDF loading is delegated
  // to usePDFDocument since it has PDF.js-specific logic (worker setup, etc.)
  const { theme } = useEditorLifecycle<ArrayBuffer>(host, {
    applyContent: () => {}, // PDF loading handled by usePDFDocument
    binary: true,
  });

  // Use the EditorHost's loadBinaryContent for cross-platform compatibility
  const { document, totalPages, loading, error } = usePDFDocument(
    host.loadBinaryContent.bind(host),
    filePath
  );
  const [scale, setScale] = useState(1.0);
  const [fitToWidth, setFitToWidth] = useState(true); // Start with fit-to-width enabled

  // Handle scale changes from user zoom actions
  const handleScaleChange = useCallback((newScale: number) => {
    setFitToWidth(false); // Disable fit-to-width when user manually zooms
    setScale(newScale);
  }, []);

  // Handle fit-to-width scale updates (from resize observer)
  const handleFitWidthScaleChange = useCallback((newScale: number) => {
    setScale(newScale);
  }, []);

  // Toggle fit-to-width mode
  const handleFitToWidthToggle = useCallback(() => {
    setFitToWidth((prev) => !prev);
    if (!fitToWidth) {
      // When enabling, the PDFScrollView will calculate the appropriate scale
    }
  }, [fitToWidth]);

  // Handle keyboard shortcuts for zoom
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          setFitToWidth(false);
          const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
          const nextLevel = ZOOM_LEVELS.find((level) => level > scale);
          if (nextLevel) setScale(nextLevel);
        } else if (e.key === '-') {
          e.preventDefault();
          setFitToWidth(false);
          const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
          const prevLevel = [...ZOOM_LEVELS].reverse().find((level) => level < scale);
          if (prevLevel) setScale(prevLevel);
        } else if (e.key === '0') {
          e.preventDefault();
          setFitToWidth(true); // Cmd+0 enables fit-to-width
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, scale]);

  if (loading) {
    return (
      <div className={`flex flex-col h-full w-full bg-nim-secondary text-nim theme-${theme}`}>
        <div className="flex items-center justify-center h-full">
          <div className="text-base text-nim-muted">Loading PDF...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`flex flex-col h-full w-full bg-nim-secondary text-nim theme-${theme}`}>
        <div className="flex items-center justify-center h-full p-8">
          <div className="text-center max-w-[500px]">
            <h3 className="text-nim mb-2">Error loading PDF</h3>
            <p className="text-nim-muted text-sm">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full w-full bg-nim-secondary text-nim theme-${theme}`}>
      <Toolbar
        totalPages={totalPages}
        scale={scale}
        fitToWidth={fitToWidth}
        onScaleChange={handleScaleChange}
        onFitToWidthToggle={handleFitToWidthToggle}
      />
      <PDFScrollView
        document={document}
        totalPages={totalPages}
        scale={scale}
        fitToWidth={fitToWidth}
        theme={theme}
        onFitWidthScaleChange={handleFitWidthScaleChange}
      />
    </div>
  );
}
