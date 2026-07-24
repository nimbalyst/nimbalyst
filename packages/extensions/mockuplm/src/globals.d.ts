/** Global type declarations for MockupLM extension */

interface MockupAnnotationEntry {
  drawingPaths: any[];
  drawingDataUrl: string | null;
  selectedElement: any;
  annotationTimestamp: number | null;
}

interface Window {
  electronAPI: {
    invoke: (channel: string, ...args: any[]) => Promise<any>;
    on: (channel: string, callback: (...args: any[]) => void) => () => void;
  };
  __workspacePath?: string;
  __mockupProjectOrigin?: Record<string, string>;
  __mockupAnnotations?: Map<string, MockupAnnotationEntry>;
  __mockupFilePath?: string;
  __mockupSelectedElement?: any;
  __mockupDrawing?: string | null;
  __mockupDrawingPaths?: any[];
  __mockupAnnotationTimestamp?: number | null;
}

declare module '@nimbalyst/runtime' {
  export interface DrawingPath {
    color: string;
    width?: number;
    points: Array<{ x: number; y: number }>;
  }
  export interface MockupSelection {
    tagName: string;
    selector: string;
    outerHTML: string;
    rect?: { x: number; y: number; width: number; height: number };
  }
}
