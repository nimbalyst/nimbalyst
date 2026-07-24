import { useMemo } from 'react';
import type { TabData } from '../contexts/TabsContext';
import { getTextSelection } from '../components/UnifiedAI/TextSelectionIndicator';
import type { MockupSelection, EditorContextItem } from '@nimbalyst/runtime';
import { getActiveEditorContextItems } from '../stores/editorContextStore';
import { isCollabUri } from '../utils/collabUri';

export interface DocumentContext {
  filePath: string;
  fileType: string;
  content: string;
  cursorPosition: undefined;
  selection?: {
    text: string;
    filePath: string;
    timestamp: number;
  };
  getLatestContent: (() => string) | undefined;
  mockupSelection?: MockupSelection;
  mockupDrawing?: string; // Data URL of drawing annotations
  mockupAnnotationTimestamp?: number | null; // Timestamp when annotations were created
  textSelection?: {
    text: string;
    filePath: string;
    timestamp: number;
  };
  textSelectionTimestamp?: number | null; // Timestamp when text was selected
  /** Extension-provided selected items (node-like editors), non-dismissed only. */
  editorContextItems?: EditorContextItem[];
}

/**
 * Serializable document context for IPC calls and component props.
 * Subset of DocumentContext with all optional fields.
 */
export interface SerializableDocumentContext {
  filePath?: string;
  content?: string;
  fileType?: string;
  textSelection?: {
    text: string;
    filePath: string;
    timestamp: number;
  };
  textSelectionTimestamp?: number;
  mockupSelection?: MockupSelection;
  mockupDrawing?: string;
  editorContextItems?: EditorContextItem[];
}

interface UseDocumentContextProps {
  activeTab: TabData | null;
  getContentRef: React.MutableRefObject<(() => string) | null>;
}

/**
 * Detect file type from file path for AI context
 */
export function detectFileType(filePath: string): string {
  if (!filePath) return 'unknown';

  // Collaborative shared documents (collab:// URIs) are always markdown,
  // but we tag them distinctly so the AI knows they live in Yjs and must be
  // edited via applyCollabDocEdit / applyDiff (not Edit/Write).
  if (isCollabUri(filePath)) return 'collab-markdown';

  const lowerPath = filePath.toLowerCase();

  // Check for compound extensions first (more specific)
  if (lowerPath.endsWith('.mockup.html')) return 'mockup';

  // Check single extensions
  const lastDot = lowerPath.lastIndexOf('.');
  if (lastDot === -1) return 'unknown';

  const ext = lowerPath.substring(lastDot);

  switch (ext) {
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.json':
      return 'json';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.js':
    case '.jsx':
    case '.ts':
    case '.tsx':
      return 'javascript';
    case '.html':
      return 'html';
    case '.css':
    case '.scss':
      return 'css';
    case '.py':
      return 'python';
    default:
      return 'code';
  }
}

/**
 * Custom hook for building document context object
 *
 * Consolidates the logic for creating document context that's used by:
 * - AIChat component
 * - AgenticPanel component
 *
 * Returns a memoized document context object based on the active tab
 */
export function useDocumentContext({ activeTab, getContentRef }: UseDocumentContextProps): DocumentContext {
  return useMemo(() => {
    if (!activeTab) {
      return {
        filePath: '',
        fileType: 'unknown',
        content: '',
        cursorPosition: undefined,
        selection: undefined,
        getLatestContent: undefined,
        textSelection: undefined,
        textSelectionTimestamp: undefined
      };
    }

    const fileType = detectFileType(activeTab.filePath || '');

    // Get mockup selection, drawing, and annotation timestamp if file is a mockup
    // These window globals are typed in @nimbalyst/runtime
    const mockupSelection = fileType === 'mockup'
      ? window.__mockupSelectedElement
      : undefined;

    const mockupDrawing = fileType === 'mockup'
      ? window.__mockupDrawing ?? undefined  // Convert null to undefined
      : undefined;

    const mockupAnnotationTimestamp = fileType === 'mockup'
      ? window.__mockupAnnotationTimestamp
      : undefined;

    // Get text selection for markdown/code files
    const textSelectionData = getTextSelection();
    const textSelection = textSelectionData && textSelectionData.filePath === (activeTab.filePath || '')
      ? textSelectionData
      : undefined;

    // Get extension-provided selected items (node-like editors), excluding any
    // the user has dismissed. Only for the currently active file.
    const editorContextItems = getActiveEditorContextItems(activeTab.filePath || '');

    return {
      filePath: activeTab.filePath || '',
      fileType,
      content: getContentRef.current ? getContentRef.current() : '',
      cursorPosition: undefined, // TODO: Get from Lexical editor
      selection: textSelection, // Selected text from editor
      getLatestContent: getContentRef.current || undefined,
      mockupSelection,
      mockupDrawing,
      mockupAnnotationTimestamp,
      textSelection,
      textSelectionTimestamp: textSelection?.timestamp ?? undefined,
      editorContextItems: editorContextItems && editorContextItems.length > 0 ? editorContextItems : undefined,
    };
  }, [activeTab, activeTab?.filePath, getContentRef.current]);
}
