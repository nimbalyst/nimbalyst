import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { SerializableDocumentContext } from '../../hooks/useDocumentContext';
import type { PullRequestRow } from '../../services/RendererPullRequestService';
import {
  getActiveEditorContextItems,
  setEditorContextItems,
} from '../../stores/editorContextStore';
import { buildPrContextItem, prContextPath } from './prFormat';

export interface PrAiContext {
  documentContext: SerializableDocumentContext;
  getDocumentContext: () => Promise<SerializableDocumentContext>;
}

/**
 * Publish the visible PR through the editor-context store using a synthetic
 * path, keeping the chat chip scoped to PR mode and clearing it while hidden.
 */
export function usePrAiContext(
  remote: string | null,
  selectedPr: PullRequestRow | null,
  isActive: boolean,
): PrAiContext {
  const path = isActive && remote && selectedPr
    ? prContextPath(remote, selectedPr.number)
    : '';
  const item = useMemo(
    () => remote && selectedPr ? buildPrContextItem(remote, selectedPr) : null,
    [remote, selectedPr],
  );
  const activePathRef = useRef('');

  useEffect(() => {
    const previousPath = activePathRef.current;
    if (previousPath && previousPath !== path) {
      setEditorContextItems(previousPath, null);
    }

    if (path && item) {
      setEditorContextItems(path, [item]);
    }
    activePathRef.current = path;
  }, [item, path]);

  useEffect(() => () => {
    if (activePathRef.current) {
      setEditorContextItems(activePathRef.current, null);
      activePathRef.current = '';
    }
  }, []);

  const documentContext = useMemo<SerializableDocumentContext>(() => ({
    filePath: path,
    fileType: 'pull-request',
    content: '',
  }), [path]);

  const getDocumentContext = useCallback(async (): Promise<SerializableDocumentContext> => ({
    ...documentContext,
    editorContextItems: path ? getActiveEditorContextItems(path) : undefined,
  }), [documentContext, path]);

  return { documentContext, getDocumentContext };
}
