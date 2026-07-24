import { Document, DocumentService, DocumentOpenOptions } from '@nimbalyst/runtime';
// electronAPI is declared in electron.d.ts

/**
 * Electron renderer-side implementation of DocumentService
 * This connects to the main process document service via IPC
 */
export class ElectronRendererDocumentService implements DocumentService {
  async listDocuments(): Promise<Document[]> {
    return window.electronAPI.documentService.list();
  }

  async searchDocuments(query: string): Promise<Document[]> {
    return window.electronAPI.documentService.search(query);
  }

  async getDocument(id: string): Promise<Document | null> {
    return window.electronAPI.documentService.get(id);
  }

  async getDocumentByPath(path: string): Promise<Document | null> {
    // For virtual documents, we need to create a synthetic document
    if (path.startsWith('virtual://')) {
      return {
        id: path,
        name: path.split('://')[1],
        path: path
      };
    }
    return window.electronAPI.documentService.getByPath(path);
  }

  async openDocument(documentId: string, fallback?: DocumentOpenOptions): Promise<void> {
    return window.electronAPI.documentService.open(documentId, fallback);
  }

  watchDocuments(callback: (documents: Document[]) => void): () => void {
    // Start watching
    window.electronAPI.documentService.watch();

    // Set up the listener
    const unsubscribe = window.electronAPI.documentService.onDocumentsChanged(callback);

    // Return unsubscribe function
    return unsubscribe;
  }

  /**
   * Load a virtual document's content
   */
  async loadVirtualDocument(virtualPath: string): Promise<string | null> {
    return window.electronAPI.documentService.loadVirtual(virtualPath);
  }
}
