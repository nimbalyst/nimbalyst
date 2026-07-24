import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

/**
 * Excalidraw file format
 */
export interface ExcalidrawFile {
  type: 'excalidraw';
  version: number;
  source: string;
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files?: BinaryFiles;
}

/**
 * Element type for identification
 */
export type ElementType = 'rectangle' | 'arrow' | 'text' | 'ellipse' | 'diamond' | 'line' | 'freedraw';

/**
 * Layout algorithm types
 */
export type LayoutAlgorithm = 'hierarchical' | 'force-directed' | 'grid';

/**
 * Element with label for AI tools
 */
export interface LabeledElement {
  id: string;
  type: ElementType;
  label: string;
  groupId?: string;
  groupName?: string;
}

/**
 * Group information
 */
export interface GroupInfo {
  id: string;
  name: string;
  elementIds: string[];
}

/**
 * Layout options
 */
export interface LayoutOptions {
  algorithm: LayoutAlgorithm;
  spacing?: number;
  direction?: 'TB' | 'LR' | 'BT' | 'RL';
}

/**
 * Store state
 */
export interface ExcalidrawStore {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
  groups: Map<string, GroupInfo>;
  excalidrawAPI: ExcalidrawImperativeAPI | null;

  setElements: (elements: readonly ExcalidrawElement[]) => void;
  setAppState: (appState: Partial<AppState>) => void;
  setFiles: (files: BinaryFiles) => void;
  setExcalidrawAPI: (api: ExcalidrawImperativeAPI | null) => void;
  loadFile: (data: ExcalidrawFile) => void;
  toFile: () => ExcalidrawFile;

  // Element operations
  addElement: (element: ExcalidrawElement) => void;
  updateElement: (id: string, updates: Partial<ExcalidrawElement>) => void;
  removeElement: (id: string) => void;
  getElementById: (id: string) => ExcalidrawElement | undefined;
  getElementByLabel: (label: string) => ExcalidrawElement | undefined;

  // Group operations
  createGroup: (name: string, elementIds: string[]) => void;
  addToGroup: (groupId: string, elementIds: string[]) => void;
  removeFromGroup: (elementIds: string[]) => void;
  getGroupByName: (name: string) => GroupInfo | undefined;
}
