/**
 * usePDFDocument Hook
 *
 * Loads a PDF document using the EditorHost API for binary content loading.
 * Uses PDF.js to parse and render the PDF.
 */

import { useState, useEffect, useRef } from 'react';

// Get PDF.js from the host
const pdfjsLib = (window as any).__nimbalyst_extensions['pdfjs-dist'];

export interface PDFDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PDFPageProxy>;
  getMetadata(): Promise<any>;
}

export interface PDFPageProxy {
  getViewport(params: { scale: number }): PDFViewport;
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: PDFViewport }): { promise: Promise<void> };
  getTextContent(): Promise<any>;
}

export interface PDFViewport {
  width: number;
  height: number;
  scale: number;
}

export interface UsePDFDocumentResult {
  document: PDFDocumentProxy | null;
  totalPages: number;
  loading: boolean;
  error: string | null;
}

/**
 * Function to load binary content - matches EditorHost.loadBinaryContent signature
 */
type LoadBinaryContent = () => Promise<ArrayBuffer>;

/**
 * Load a PDF document using the provided content loader.
 *
 * @param loadBinaryContent Function to load binary content (from EditorHost)
 * @param filePath File path (used as dependency to re-load when path changes)
 */
export function usePDFDocument(
  loadBinaryContent: LoadBinaryContent,
  filePath: string
): UsePDFDocumentResult {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Use ref to store the loadBinaryContent function to avoid dependency changes
  // The function identity changes on every render but points to the same underlying operation
  const loadBinaryContentRef = useRef(loadBinaryContent);
  loadBinaryContentRef.current = loadBinaryContent;

  useEffect(() => {
    let cancelled = false;

    const loadPDF = async () => {
      try {
        setLoading(true);
        setError(null);

        if (!pdfjsLib) {
          throw new Error('PDF.js library not available');
        }

        // Configure worker - PDF.js needs a worker to parse PDFs without blocking the main thread
        // The worker is loaded as a blob URL by the activation function
        // Wait for the worker URL to be available (with timeout)
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
          let attempts = 0;
          while (!((window as any).__pdfViewerWorkerUrl) && attempts < 20) {
            await new Promise(resolve => setTimeout(resolve, 50));
            attempts++;
          }

          const workerUrl = (window as any).__pdfViewerWorkerUrl;
          if (workerUrl) {
            pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
            console.log('[PDF Viewer] Worker configured with blob URL');
          } else {
            throw new Error('PDF.js worker URL not available after waiting');
          }
        }

        // Load binary content via EditorHost
        const arrayBuffer = await loadBinaryContentRef.current();
        const bytes = new Uint8Array(arrayBuffer);

        // Load the PDF document from binary data
        const loadingTask = pdfjsLib.getDocument({ data: bytes });
        const pdf = await loadingTask.promise;

        if (cancelled) return;

        setDocument(pdf);
        setTotalPages(pdf.numPages);
        setLoading(false);
      } catch (err: any) {
        if (!cancelled) {
          console.error('Error loading PDF:', err);
          setError(err.message || 'Failed to load PDF');
          setLoading(false);
        }
      }
    };

    loadPDF();

    return () => {
      cancelled = true;
    };
  // Only re-run when filePath changes - loadBinaryContent is accessed via ref
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  return { document, totalPages, loading, error };
}
