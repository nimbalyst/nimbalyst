import { useState, useCallback, useMemo, useRef } from 'react';
import { getDocumentService } from '../services/RendererDocumentService';
import type { Document } from '@nimbalyst/runtime';
import { getFileIcon, fuzzyFilterDocuments } from '@nimbalyst/runtime';
import type { TypeaheadOption } from '../components/Typeahead/GenericTypeahead';

/**
 * Truncate a path for display, keeping the most relevant parts visible.
 * Example: "packages/electron/src/renderer/components" -> "...renderer/components"
 */
function truncatePath(path: string, maxLength: number = 40): string {
  if (!path || path.length <= maxLength) return path;

  const parts = path.split('/');
  if (parts.length <= 2) return path;

  // Always keep the last 2-3 parts (closest to the file)
  const keepParts = parts.slice(-3);
  const truncated = '...' + keepParts.join('/');

  if (truncated.length <= maxLength) return truncated;

  // If still too long, keep fewer parts
  const fewerParts = parts.slice(-2);
  return '...' + fewerParts.join('/');
}

/**
 * Get the directory path (without filename) from a full path
 */
function getDirectoryPath(fullPath: string): string {
  const parts = fullPath.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

export interface FileMentionReference {
  documentId: string;
  name: string;
  path: string;
  workspace?: string;
}

interface UseFileMentionOptions {
  // Callback when a file is selected
  onInsertReference: (reference: FileMentionReference) => void;
}

interface UseFileMentionReturn {
  options: TypeaheadOption[];
  isLoading: boolean;
  handleSearch: (query: string) => void;
  handleSelect: (option: TypeaheadOption) => void;
}

export function useFileMention({
  onInsertReference
}: UseFileMentionOptions): UseFileMentionReturn {
  const [allDocuments, setAllDocuments] = useState<Document[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const lastFetchTimeRef = useRef<number>(0);
  const CACHE_DURATION_MS = 5000; // 5 second cache

  const documentService = useMemo(() => getDocumentService(), []);

  // Load all documents with cache
  const loadDocuments = useCallback(async () => {
    const now = Date.now();
    const timeSinceLastFetch = now - lastFetchTimeRef.current;

    // Skip fetch if cache is still valid
    if (timeSinceLastFetch < CACHE_DURATION_MS && allDocuments.length > 0) {
      return allDocuments;
    }

    try {
      setIsLoading(true);
      const docs = await documentService.listDocuments();
      setAllDocuments(docs);
      lastFetchTimeRef.current = now;
      return docs;
    } catch (err) {
      console.error('[useFileMention] Failed to load documents:', err);
      return allDocuments;
    } finally {
      setIsLoading(false);
    }
  }, [documentService, allDocuments]);

  // Handle search query changes - just update query, fuzzy filtering happens in options memo
  const handleSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    // Ensure documents are loaded
    await loadDocuments();
  }, [loadDocuments]);

  // Convert documents to typeahead options with fuzzy filtering
  const options = useMemo<TypeaheadOption[]>(() => {
    // Use fuzzy filtering with CamelCase support
    const filtered = fuzzyFilterDocuments(allDocuments, searchQuery, 50);

    return filtered.map(({ item: doc }) => {
      const dirPath = getDirectoryPath(doc.path);
      const truncatedPath = truncatePath(dirPath);
      // Show filename with truncated path in description
      const displayLabel = doc.name;
      const description = truncatedPath || undefined;

      return {
        id: doc.id,
        label: displayLabel,
        description,
        icon: getFileIcon(doc.name, 18),
        data: doc
      };
    });
  }, [allDocuments, searchQuery]);

  // Handle option selection
  const handleSelect = useCallback((option: TypeaheadOption) => {
    const document = option.data as Document;
    if (!document) return;

    const reference: FileMentionReference = {
      documentId: document.id,
      name: document.name,
      path: document.path,
      workspace: document.workspace
    };

    onInsertReference(reference);
  }, [onInsertReference]);

  return {
    options,
    isLoading,
    handleSearch,
    handleSelect
  };
}
