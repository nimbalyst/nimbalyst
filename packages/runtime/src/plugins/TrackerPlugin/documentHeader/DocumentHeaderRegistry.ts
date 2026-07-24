/**
 * DocumentHeaderRegistry - System for plugins to register document header components
 *
 * Document headers appear at the top of the document scroll pane (above the editor)
 * and are triggered by document frontmatter or other detection mechanisms.
 */

import React from 'react';

export interface DocumentHeaderComponentProps {
  filePath: string;
  fileName: string;
  /** Get fresh content from the editor. Call this when you need the current content. */
  getContent: () => string;
  /** Version counter that increments when content changes. Use as a dependency to re-read content. */
  contentVersion: number;
  onContentChange?: (newContent: string) => void;
  editor?: any; // Lexical editor instance
}

export interface DocumentHeaderProvider {
  id: string;
  priority: number; // Higher priority renders first
  shouldRender: (content: string, filePath: string) => boolean;
  component: React.ComponentType<DocumentHeaderComponentProps>;
}

class DocumentHeaderRegistryImpl {
  private providers: Map<string, DocumentHeaderProvider> = new Map();

  register(provider: DocumentHeaderProvider): () => void {
    this.providers.set(provider.id, provider);

    // Return unregister function
    return () => {
      this.providers.delete(provider.id);
    };
  }

  unregister(providerId: string): void {
    this.providers.delete(providerId);
  }

  getProviders(content: string, filePath: string): DocumentHeaderProvider[] {
    const matching = Array.from(this.providers.values())
      .filter(provider => provider.shouldRender(content, filePath))
      .sort((a, b) => b.priority - a.priority); // Higher priority first

    return matching;
  }

  getAllProviders(): DocumentHeaderProvider[] {
    return Array.from(this.providers.values());
  }
}

// Singleton instance
export const DocumentHeaderRegistry = new DocumentHeaderRegistryImpl();
