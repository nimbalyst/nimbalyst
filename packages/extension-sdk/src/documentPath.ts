import { useDocumentPath as useHostDocumentPath } from '@nimbalyst/runtime';

export interface DocumentPathContextValue {
  documentPath: string | null;
  documentDir: string | null;
}

export function useDocumentPath(): DocumentPathContextValue {
  return useHostDocumentPath();
}
