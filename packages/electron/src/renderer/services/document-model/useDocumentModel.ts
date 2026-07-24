/**
 * useDocumentModel - React hook for connecting a component to a DocumentModel.
 *
 * Acquires a DocumentModel from the registry synchronously on first render.
 * Releases on unmount or when filePath changes.
 */

import { useEffect, useRef } from 'react';
import { DocumentModelRegistry } from './DocumentModelRegistry';
import type { DocumentModelOptions } from './DocumentModel';
import type { DocumentModel } from './DocumentModel';
import type { DocumentModelEditorHandle } from './types';

interface UseDocumentModelResult {
  model: DocumentModel;
  handle: DocumentModelEditorHandle;
}

/**
 * Connect a component to a DocumentModel via the registry.
 *
 * The model is acquired synchronously on first render so that it's
 * available immediately (not deferred to a useEffect).
 * Released on unmount or when filePath changes.
 */
export function useDocumentModel(
  filePath: string,
  options?: DocumentModelOptions,
): UseDocumentModelResult {
  // Acquire synchronously so the handle is available on first render.
  // The ref persists across re-renders; we only re-acquire if filePath changes.
  const resultRef = useRef<{
    filePath: string;
    model: DocumentModel;
    handle: DocumentModelEditorHandle;
  } | null>(null);

  if (!resultRef.current) {
    const { model, handle } = DocumentModelRegistry.getOrCreate(filePath, options);
    resultRef.current = { filePath, model, handle };
  } else if (resultRef.current.filePath !== filePath) {
    // Fast-path for file renames: the registry may have migrated the existing
    // model in place before this component re-renders. If so, keep the current
    // attachment rather than releasing/re-acquiring, which would drop dirty
    // state when the old handle is the only attachment.
    if (resultRef.current.model.filePath === filePath) {
      resultRef.current.filePath = filePath;
    } else {
      DocumentModelRegistry.release(
        resultRef.current.model.filePath,
        resultRef.current.handle,
      );
      const { model, handle } = DocumentModelRegistry.getOrCreate(filePath, options);
      resultRef.current = { filePath, model, handle };
    }
  }

  // Cleanup on unmount. Path changes are handled synchronously above.
  useEffect(() => {
    return () => {
      if (resultRef.current) {
        DocumentModelRegistry.release(
          resultRef.current.model.filePath,
          resultRef.current.handle,
        );
        resultRef.current = null;
      }
    };
  }, []);

  return {
    model: resultRef.current.model,
    handle: resultRef.current.handle,
  };
}
