/**
 * EditorRegistry - Manages multiple editor instances for AI operations
 *
 * Replaces the singleton event bridge pattern with a registry that tracks
 * editor instances by file path, enabling targeted AI operations on specific editors.
 */

import type { LexicalEditor } from 'lexical';

export interface EditorInstance {
  instanceId?: string;
  filePath: string;
  editor: LexicalEditor;
  isVisible?: () => boolean;
  hasPendingDiffs: () => boolean;
  applyReplacements: (replacements: any[], requestId?: string) => Promise<{ success: boolean; error?: string }>;
  startStreaming: (config: any) => void;
  streamContent: (streamId: string, content: string) => void;
  endStreaming: (streamId: string) => void;
  getContent: () => string;
}

export type FileOpenerFunction = (filePath: string, content: string, switchToTab: boolean) => Promise<void> | void;

class EditorRegistry {
  private editorsByFilePath: Map<string, Map<string, EditorInstance>> = new Map();
  private activeEditorIdByFilePath: Map<string, string> = new Map();
  private activeFilePath: string | null = null;
  private fileOpener: FileOpenerFunction | null = null;

  private getInstanceId(instance: Pick<EditorInstance, 'instanceId'>): string {
    return instance.instanceId || 'default';
  }

  private resolveEditorForFilePath(filePath: string): EditorInstance | undefined {
    const editorsForFile = this.editorsByFilePath.get(filePath);
    if (!editorsForFile || editorsForFile.size === 0) {
      return undefined;
    }

    if (editorsForFile.size === 1) {
      return editorsForFile.values().next().value as EditorInstance;
    }

    const visibleEditors = Array.from(editorsForFile.values()).filter(editor => {
      try {
        return editor.isVisible?.() === true;
      } catch {
        return false;
      }
    });

    if (visibleEditors.length > 0) {
      const activeEditorId = this.activeEditorIdByFilePath.get(filePath);
      if (activeEditorId) {
        const activeVisible = visibleEditors.find(editor => this.getInstanceId(editor) === activeEditorId);
        if (activeVisible) {
          return activeVisible;
        }
      }
      return visibleEditors[visibleEditors.length - 1];
    }

    const activeEditorId = this.activeEditorIdByFilePath.get(filePath);
    if (activeEditorId) {
      const activeEditor = editorsForFile.get(activeEditorId);
      if (activeEditor) {
        return activeEditor;
      }
    }

    const allEditors = Array.from(editorsForFile.values());
    return allEditors[allEditors.length - 1];
  }

  /**
   * Register an editor instance for a file path
   */
  register(instance: EditorInstance): void {
    const instanceId = this.getInstanceId(instance);
    let editorsForFile = this.editorsByFilePath.get(instance.filePath);
    if (!editorsForFile) {
      editorsForFile = new Map();
      this.editorsByFilePath.set(instance.filePath, editorsForFile);
    }

    editorsForFile.set(instanceId, instance);

    // Set as active if it's the first editor or explicitly set later
    if (!this.activeFilePath) {
      this.activeFilePath = instance.filePath;
      this.activeEditorIdByFilePath.set(instance.filePath, instanceId);
    }
  }

  /**
   * Unregister an editor instance
   */
  unregister(filePath: string, instanceId?: string): void {
    const editorsForFile = this.editorsByFilePath.get(filePath);
    if (!editorsForFile) {
      return;
    }

    if (instanceId) {
      editorsForFile.delete(instanceId);
    } else {
      editorsForFile.clear();
    }

    if (editorsForFile.size === 0) {
      this.editorsByFilePath.delete(filePath);
      this.activeEditorIdByFilePath.delete(filePath);

      if (this.activeFilePath === filePath) {
        const remainingPaths = Array.from(this.editorsByFilePath.keys());
        this.activeFilePath = remainingPaths.length > 0 ? remainingPaths[0] : null;
      }
      return;
    }

    const activeEditorId = this.activeEditorIdByFilePath.get(filePath);
    if (!activeEditorId || !editorsForFile.has(activeEditorId)) {
      const resolved = this.resolveEditorForFilePath(filePath);
      if (resolved) {
        this.activeEditorIdByFilePath.set(filePath, this.getInstanceId(resolved));
      }
    }
  }

  /**
   * Get an editor instance by file path
   */
  getEditor(filePath: string): EditorInstance | undefined {
    return this.resolveEditorForFilePath(filePath);
  }

  /**
   * Get all registered file paths
   */
  getFilePaths(): string[] {
    return Array.from(this.editorsByFilePath.keys());
  }

  /**
   * Check if an editor is registered for a file path
   */
  has(filePath: string): boolean {
    const editorsForFile = this.editorsByFilePath.get(filePath);
    return !!editorsForFile && editorsForFile.size > 0;
  }

  /**
   * Set the active editor by file path
   *
   * DEFENSIVE: This method is called during tab switching. If the editor hasn't
   * registered yet (e.g., due to slow mount or error), we silently skip rather
   * than blocking or throwing. The editor will set itself as active when it
   * registers if it has data-active="true".
   *
   * @returns true if the editor was found and set active, false otherwise
   */
  setActive(filePath: string, instanceId?: string): boolean {
    const editorsForFile = this.editorsByFilePath.get(filePath);
    if (!editorsForFile || editorsForFile.size === 0) {
      return false;
    }

    let targetEditorId = instanceId;
    if (targetEditorId && !editorsForFile.has(targetEditorId)) {
      return false;
    }

    if (!targetEditorId) {
      const resolved = this.resolveEditorForFilePath(filePath);
      if (!resolved) return false;
      targetEditorId = this.getInstanceId(resolved);
    }

    this.activeFilePath = filePath;
    this.activeEditorIdByFilePath.set(filePath, targetEditorId);
    return true;
  }

  /**
   * Get the currently active file path
   */
  getActiveFilePath(): string | null {
    return this.activeFilePath;
  }

  /**
   * Apply text replacements to a specific editor
   */
  async applyReplacements(
    filePath: string,
    replacements: any[],
    requestId?: string
  ): Promise<{ success: boolean; error?: string }> {
    const editor = this.getEditor(filePath);

    if (!editor) {
      return { success: false, error: `No editor registered for ${filePath}` };
    }

    return editor.applyReplacements(replacements, requestId);
  }

  /**
   * Start a streaming edit session for a specific editor
   */
  startStreaming(filePath: string, config: any): void {
    const editor = this.getEditor(filePath);

    if (!editor) {
      console.error('[EditorRegistry] No editor found for streaming to file:', filePath);
      return;
    }

    console.log('[EditorRegistry] Starting streaming for:', filePath, config);
    editor.startStreaming(config);
  }

  /**
   * Stream content to an active session
   */
  streamContent(filePath: string, streamId: string, content: string): void {
    const editor = this.getEditor(filePath);

    if (!editor) {
      console.error('[EditorRegistry] No editor found for streaming content to:', filePath);
      return;
    }

    editor.streamContent(streamId, content);
  }

  /**
   * End a streaming session
   */
  endStreaming(filePath: string, streamId: string): void {
    const editor = this.getEditor(filePath);

    if (!editor) {
      console.error('[EditorRegistry] No editor found for ending stream:', filePath);
      return;
    }

    console.log('[EditorRegistry] Ending streaming for:', filePath, streamId);
    editor.endStreaming(streamId);
  }

  /**
   * Get content from a specific editor
   */
  getContent(filePath: string): string {
    const editor = this.getEditor(filePath);

    if (!editor) {
      console.error('[EditorRegistry] No editor found for getting content from:', filePath);
      return '';
    }

    return editor.getContent();
  }

  /**
   * Set the file opener function to be called when opening files in background
   */
  setFileOpener(opener: FileOpenerFunction): void {
    this.fileOpener = opener;
  }

  /**
   * Open a file in the background (without switching focus)
   */
  async openFileInBackground(filePath: string, content: string): Promise<void> {
    if (!this.fileOpener) {
      console.warn('[EditorRegistry] No file opener registered, cannot open file:', filePath);
      return;
    }

    await this.fileOpener(filePath, content, false);

    // Wait a bit for the editor to register
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * Scroll to a tracker item in the document by its ID
   */
  scrollToTrackerItem(filePath: string, itemId: string): void {
    const editorInstance = this.getEditor(filePath);

    if (!editorInstance) {
      console.warn('[EditorRegistry] No editor found for scrolling to tracker item:', filePath);
      return;
    }

    const { editor } = editorInstance;

    // Find the TrackerItemNode with the matching ID
    editor.getEditorState().read(() => {
      let targetKey: string | null = null;

      // Walk through all nodes to find the TrackerItemNode with matching ID
      const allNodes = editor._editorState._nodeMap;
      for (const [key, node] of allNodes) {
        if ((node as any).__type === 'tracker-item') {
          const trackerNode = node as any;
          if (trackerNode.__data?.id === itemId) {
            targetKey = key;
            break;
          }
        }
      }

      if (targetKey) {
        const domElement = editor.getElementByKey(targetKey);
        if (domElement) {
          // Scroll the element into view with smooth behavior
          domElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } else {
        console.warn('[EditorRegistry] TrackerItemNode not found with ID:', itemId);
      }
    });
  }
}

// Export singleton instance
export const editorRegistry = new EditorRegistry();

// Expose for testing (browser environment only)
if (typeof window !== 'undefined') {
  (window as any).__editorRegistry = editorRegistry;
}
