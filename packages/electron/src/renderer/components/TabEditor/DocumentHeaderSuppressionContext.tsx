/**
 * DocumentHeaderSuppressionContext - lets a host that already shows a document's
 * tracker identity tell the `TabEditor` inside it to omit that registered
 * provider while preserving unrelated document headers.
 *
 * Tracker Mode's expanded document view renders a frontmatter-projected plan (or
 * bug, decision, ...) file through `TabEditor`, directly under a header that
 * already shows the same issue key, title, status, priority, owner and tags as
 * editable chips. Without this the reader sees the same form twice.
 *
 * It is a context rather than a prop because the file-backed body is mounted
 * several components below the view that knows it is expanded, and the
 * intervening components have no other reason to know about document headers.
 * Suppression is presentational and provider-scoped: normal file tabs mount
 * outside any provider, and other matching headers remain visible.
 */

import React, { createContext, useContext } from 'react';

const EMPTY_PROVIDER_IDS: readonly string[] = [];
const DocumentHeaderSuppressionContext = createContext<readonly string[]>(EMPTY_PROVIDER_IDS);

/**
 * Provider ids already represented by an ancestor and therefore omitted here.
 */
export function useSuppressedDocumentHeaderProviderIds(): readonly string[] {
  return useContext(DocumentHeaderSuppressionContext);
}

interface DocumentHeaderSuppressionProviderProps {
  /** Suppress only these registered document-header providers. */
  providerIds: readonly string[];
  children: React.ReactNode;
}

export const DocumentHeaderSuppressionProvider: React.FC<DocumentHeaderSuppressionProviderProps> = ({
  providerIds,
  children,
}) => (
  <DocumentHeaderSuppressionContext.Provider value={providerIds}>
    {children}
  </DocumentHeaderSuppressionContext.Provider>
);
