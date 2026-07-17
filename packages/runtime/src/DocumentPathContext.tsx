/**
 * DocumentPathContext - Provides the current document's file path to the editor tree.
 *
 * This context is used by decorator nodes (like DataModelNode) to resolve
 * relative paths correctly. Each TabEditor wraps its NimbalystEditor with this
 * provider, so each editor instance has access to its own document path
 * regardless of which tab is currently active.
 */

import type { JSX } from 'react';
import { createContext, useContext, type ReactNode } from 'react';

interface DocumentPathContextValue {
  /** Absolute path to the document file (e.g., "/Users/foo/docs/readme.md") */
  documentPath: string | null;
  /** Directory containing the document (e.g., "/Users/foo/docs") */
  documentDir: string | null;
}

const DocumentPathContext = createContext<DocumentPathContextValue>({
  documentPath: null,
  documentDir: null,
});

export function DocumentPathProvider({
  documentPath,
  children,
}: {
  documentPath: string | null;
  children: ReactNode;
}): JSX.Element {
  // Compute document directory from path
  const documentDir = documentPath
    ? documentPath.substring(0, documentPath.lastIndexOf('/')) || null
    : null;

  return (
    <DocumentPathContext.Provider value={{ documentPath, documentDir }}>
      {children}
    </DocumentPathContext.Provider>
  );
}

/**
 * Hook to get the current document's path within an editor tree.
 * Returns null values if the document path hasn't been set.
 */
export function useDocumentPath(): DocumentPathContextValue {
  return useContext(DocumentPathContext);
}
