/**
 * Shared types for mockup annotation data.
 * Used by MockupEditor, OffscreenEditorRenderer, and useDocumentContext.
 */

/**
 * A single drawing path with points and color.
 */
export interface DrawingPath {
  points: { x: number; y: number }[];
  color: string;
}

/**
 * Selected element in a mockup.
 */
export interface MockupSelection {
  selector: string;
  outerHTML: string;
  tagName: string;
}

/**
 * Per-file annotation data stored in the global Map.
 */
export interface MockupAnnotationData {
  drawingPaths: DrawingPath[];
  drawingDataUrl: string | null;
  selectedElement: MockupSelection | null;
  annotationTimestamp: number | null;
}

/**
 * Global window extensions for mockup annotations.
 * These globals are set by MockupEditor and read by OffscreenEditorRenderer.
 */
declare global {
  interface Window {
    // Per-file annotation storage (keyed by file path) - persists when tab is inactive
    __mockupAnnotations?: Map<string, MockupAnnotationData>;
    // Legacy globals (only set when tab is active, for backward compatibility)
    __mockupFilePath?: string;
    __mockupSelectedElement?: MockupSelection;
    __mockupDrawing?: string | null;
    __mockupAnnotationTimestamp?: number | null;
    __mockupDrawingPaths?: DrawingPath[];
  }
}

// Export empty object to make this a module
export {};
