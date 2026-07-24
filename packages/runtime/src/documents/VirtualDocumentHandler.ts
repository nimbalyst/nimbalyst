/**
 * Handler for virtual document state management
 */

import type { VirtualDocument, VirtualDocumentState } from './virtualDocTypes';
import { isVirtualPath, getVirtualDocByPath } from '../constants/virtualDocs';

export class VirtualDocumentHandler {
  private virtualDocs: Map<string, VirtualDocument> = new Map();
  private documentStates: Map<string, VirtualDocumentState> = new Map();

  /**
   * Register a virtual document
   */
  registerVirtualDoc(doc: VirtualDocument): void {
    this.virtualDocs.set(doc.path, doc);
    this.documentStates.set(doc.path, {
      isVirtual: true,
      virtualId: doc.id,
      warningDismissed: false,
    });
  }

  /**
   * Get a virtual document by path
   */
  getVirtualDoc(path: string): VirtualDocument | undefined {
    return this.virtualDocs.get(path);
  }

  /**
   * Check if a path is a virtual document
   */
  isVirtualDoc(path: string): boolean {
    return isVirtualPath(path);
  }

  /**
   * Get virtual document state
   */
  getState(path: string): VirtualDocumentState | undefined {
    return this.documentStates.get(path);
  }

  /**
   * Update virtual document state
   */
  setState(path: string, state: Partial<VirtualDocumentState>): void {
    const currentState = this.documentStates.get(path);
    if (currentState) {
      this.documentStates.set(path, { ...currentState, ...state });
    }
  }

  /**
   * Dismiss warning for a virtual document
   */
  dismissWarning(path: string): void {
    this.setState(path, { warningDismissed: true });
  }

  /**
   * Check if a virtual document should show warning
   */
  shouldShowWarning(path: string): boolean {
    const state = this.documentStates.get(path);
    return state ? !state.warningDismissed : false;
  }

  /**
   * Remove a virtual document from state
   */
  removeVirtualDoc(path: string): void {
    this.virtualDocs.delete(path);
    this.documentStates.delete(path);
  }

  /**
   * Clear all virtual documents
   */
  clear(): void {
    this.virtualDocs.clear();
    this.documentStates.clear();
  }
}

// Singleton instance
export const virtualDocHandler = new VirtualDocumentHandler();