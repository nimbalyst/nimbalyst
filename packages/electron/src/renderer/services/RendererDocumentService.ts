import {
  Document,
  DocumentService,
  DocumentOpenOptions,
  DocumentMetadataEntry,
  MetadataChangeEvent,
  TrackerItem,
  TrackerItemChangeEvent,
  TrackerItemType
} from '@nimbalyst/runtime';

/**
 * Renderer-side DocumentService that communicates with the main process
 */
export class RendererDocumentService implements DocumentService {
  private changeListeners: Map<string, (documents: Document[]) => void> = new Map();
  private metadataChangeListeners: Map<string, (change: MetadataChangeEvent) => void> = new Map();
  private trackerItemChangeListeners: Map<string, (change: TrackerItemChangeEvent) => void> = new Map();
  private cleanupFunctions: (() => void)[] = [];

  constructor() {
    // Only set up listeners if window.electronAPI is available
    if (typeof window !== 'undefined' && window.electronAPI) {
      // Listen for document change events from main process
      const unsubscribeDocuments = window.electronAPI.on('document-service:documents-changed', (documents: Document[]) => {
        this.changeListeners.forEach(callback => callback(documents));
      });
      this.cleanupFunctions.push(unsubscribeDocuments);

      // Listen for metadata change events from main process
      const unsubscribeMetadata = window.electronAPI.on('document-service:metadata-changed', (change: MetadataChangeEvent) => {
        this.metadataChangeListeners.forEach(callback => callback(change));
      });
      this.cleanupFunctions.push(unsubscribeMetadata);

      // Listen for tracker item change events from main process
      const unsubscribeTrackerItems = window.electronAPI.on('document-service:tracker-items-changed', (change: TrackerItemChangeEvent) => {
        this.trackerItemChangeListeners.forEach(callback => callback(change));
      });
      this.cleanupFunctions.push(unsubscribeTrackerItems);
    }
  }

  dispose() {
    this.cleanupFunctions.forEach(cleanup => cleanup());
    this.cleanupFunctions = [];
    this.changeListeners.clear();
    this.metadataChangeListeners.clear();
    this.trackerItemChangeListeners.clear();
  }

  async listDocuments(): Promise<Document[]> {
    if (!window.electronAPI) return [];
    return window.electronAPI.invoke('document-service:list');
  }

  async searchDocuments(query: string): Promise<Document[]> {
    if (!window.electronAPI) return [];
    return window.electronAPI.invoke('document-service:search', query);
  }

  async refreshWorkspaceData(): Promise<void> {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.invoke('document-service:refresh-workspace');
    if (!result.success && result.error) {
      throw new Error(result.error);
    }
  }

  async getDocument(id: string): Promise<Document | null> {
    if (!window.electronAPI) return null;
    return window.electronAPI.invoke('document-service:get', id);
  }

  async getDocumentByPath(path: string): Promise<Document | null> {
    if (!window.electronAPI) return null;
    return window.electronAPI.invoke('document-service:get-by-path', path);
  }

  watchDocuments(callback: (documents: Document[]) => void): () => void {
    const id = Date.now().toString();
    this.changeListeners.set(id, callback);

    // Start watching if this is the first listener
    if (this.changeListeners.size === 1 && window.electronAPI) {
      window.electronAPI.send('document-service:watch');
    }

    // Return unsubscribe function
    return () => {
      this.changeListeners.delete(id);
    };
  }

  async openDocument(documentId: string, fallback?: DocumentOpenOptions): Promise<void> {
    if (!window.electronAPI) return;
    return window.electronAPI.invoke('document-service:open', { documentId, fallback });
  }

  // Metadata API methods
  async getDocumentMetadata(id: string): Promise<DocumentMetadataEntry | null> {
    if (!window.electronAPI) return null;
    return window.electronAPI.invoke('document-service:metadata-get', id);
  }

  async getDocumentMetadataByPath(path: string): Promise<DocumentMetadataEntry | null> {
    if (!window.electronAPI) return null;
    return window.electronAPI.invoke('document-service:metadata-get-by-path', path);
  }

  async listDocumentMetadata(): Promise<DocumentMetadataEntry[]> {
    if (!window.electronAPI) return [];
    return window.electronAPI.invoke('document-service:metadata-list');
  }

  watchDocumentMetadata(listener: (change: MetadataChangeEvent) => void): () => void {
    const id = Date.now().toString();
    this.metadataChangeListeners.set(id, listener);

    // Start watching if this is the first listener
    if (this.metadataChangeListeners.size === 1 && window.electronAPI) {
      window.electronAPI.send('document-service:metadata-watch');
    }

    // Return unsubscribe function
    return () => {
      this.metadataChangeListeners.delete(id);
    };
  }

  async notifyFrontmatterChanged(path: string, frontmatter: Record<string, unknown>): Promise<void> {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.invoke('document-service:notify-frontmatter-changed', { path, frontmatter });
    if (!result.success) {
      throw new Error(result.error || 'Failed to notify frontmatter change');
    }
  }

  // Tracker items API methods
  async listTrackerItems(): Promise<TrackerItem[]> {
    if (!window.electronAPI) return [];
    return window.electronAPI.invoke('document-service:tracker-items-list');
  }

  async getTrackerItemsByType(type: TrackerItemType): Promise<TrackerItem[]> {
    if (!window.electronAPI) return [];
    return window.electronAPI.invoke('document-service:tracker-items-by-type', type);
  }

  async getTrackerItemsByModule(module: string): Promise<TrackerItem[]> {
    if (!window.electronAPI) return [];
    return window.electronAPI.invoke('document-service:tracker-items-by-module', module);
  }

  watchTrackerItems(listener: (change: TrackerItemChangeEvent) => void): () => void {
    const id = Date.now().toString();
    this.trackerItemChangeListeners.set(id, listener);

    // Start watching if this is the first listener
    if (this.trackerItemChangeListeners.size === 1 && window.electronAPI) {
      window.electronAPI.send('document-service:tracker-items-watch');
    }

    // Return unsubscribe function
    return () => {
      this.trackerItemChangeListeners.delete(id);
    };
  }

  // Asset management methods
  async storeAsset(buffer: number[], mimeType: string): Promise<{ hash: string; extension: string }> {
    if (!window.electronAPI) {
      throw new Error('Electron API not available');
    }
    return window.electronAPI.invoke('document-service:store-asset', { buffer, mimeType });
  }

  async getAssetPath(hash: string): Promise<string | null> {
    if (!window.electronAPI) return null;
    return window.electronAPI.invoke('document-service:get-asset-path', hash);
  }

  async garbageCollectAssets(): Promise<number> {
    if (!window.electronAPI) return 0;
    return window.electronAPI.invoke('document-service:gc-assets');
  }
}

// Singleton instance
let documentService: RendererDocumentService | null = null;

export function getDocumentService(): DocumentService {
  if (!documentService) {
    documentService = new RendererDocumentService();
  }
  return documentService;
}

// Cleanup on HMR
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (documentService) {
      documentService.dispose();
      documentService = null;
    }
  });
}
