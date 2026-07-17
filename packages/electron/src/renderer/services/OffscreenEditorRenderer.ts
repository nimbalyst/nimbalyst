/**
 * Offscreen Editor Renderer
 *
 * Manages offscreen editor instances in the renderer process.
 * Creates hidden DOM containers and mounts React editors without visible UI.
 * Editors register their APIs in the same registry used by visible editors.
 *
 * Screenshot capture uses Electron's native capturePage() via the main process,
 * which captures actual composited pixels (including WebGL, canvas, complex CSS).
 * The renderer's role is to find/position the editor element and return its
 * bounding rect so the main process can capture the correct region.
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EditorHost } from '@nimbalyst/runtime';
import { getExtensionLoader, getBaseThemeColors, hasExtensionEditorAPI, getExtensionEditorAPI, type ExtendedThemeColors } from '@nimbalyst/runtime';
import { waitForEditorRegistration } from './waitForEditorRegistration';
// Note: Window globals for mockup annotations are declared in @nimbalyst/runtime

/**
 * Map theme color keys to CSS variable names.
 * Duplicated from useTheme.ts (not exported) -- only the core subset needed for capture.
 */
const CSS_VAR_MAP: Record<keyof ExtendedThemeColors, string> = {
  'bg': '--nim-bg',
  'bg-secondary': '--nim-bg-secondary',
  'bg-tertiary': '--nim-bg-tertiary',
  'bg-hover': '--nim-bg-hover',
  'bg-selected': '--nim-bg-selected',
  'bg-active': '--nim-bg-active',
  'text': '--nim-text',
  'text-muted': '--nim-text-muted',
  'text-faint': '--nim-text-faint',
  'text-disabled': '--nim-text-disabled',
  'border': '--nim-border',
  'border-focus': '--nim-border-focus',
  'primary': '--nim-primary',
  'primary-hover': '--nim-primary-hover',
  'on-primary': '--nim-on-primary',
  'link': '--nim-link',
  'link-hover': '--nim-link-hover',
  'success': '--nim-success',
  'warning': '--nim-warning',
  'error': '--nim-error',
  'info': '--nim-info',
  'purple': '--nim-purple',
  'code-bg': '--nim-code-bg',
  'code-text': '--nim-code-text',
  'code-border': '--nim-code-border',
  'code-gutter': '--nim-code-gutter',
  'table-border': '--nim-table-border',
  'table-header': '--nim-table-header',
  'table-cell': '--nim-table-cell',
  'table-stripe': '--nim-table-stripe',
  'toolbar-bg': '--nim-toolbar-bg',
  'toolbar-border': '--nim-toolbar-border',
  'toolbar-hover': '--nim-toolbar-hover',
  'toolbar-active': '--nim-toolbar-active',
  'highlight-bg': '--nim-highlight-bg',
  'highlight-border': '--nim-highlight-border',
  'quote-text': '--nim-quote-text',
  'quote-border': '--nim-quote-border',
  'scrollbar-thumb': '--nim-scrollbar-thumb',
  'scrollbar-thumb-hover': '--nim-scrollbar-thumb-hover',
  'scrollbar-track': '--nim-scrollbar-track',
  'diff-add-bg': '--nim-diff-add-bg',
  'diff-add-border': '--nim-diff-add-border',
  'diff-remove-bg': '--nim-diff-remove-bg',
  'diff-remove-border': '--nim-diff-remove-border',
  'code-comment': '--nim-code-comment',
  'code-punctuation': '--nim-code-punctuation',
  'code-property': '--nim-code-property',
  'code-selector': '--nim-code-selector',
  'code-operator': '--nim-code-operator',
  'code-attr': '--nim-code-attr',
  'code-variable': '--nim-code-variable',
  'code-function': '--nim-code-function',
  'terminal-bg': '--terminal-bg',
  'terminal-fg': '--terminal-fg',
  'terminal-cursor': '--terminal-cursor',
  'terminal-cursor-accent': '--terminal-cursor-accent',
  'terminal-selection': '--terminal-selection',
  'terminal-ansi-black': '--terminal-ansi-black',
  'terminal-ansi-red': '--terminal-ansi-red',
  'terminal-ansi-green': '--terminal-ansi-green',
  'terminal-ansi-yellow': '--terminal-ansi-yellow',
  'terminal-ansi-blue': '--terminal-ansi-blue',
  'terminal-ansi-magenta': '--terminal-ansi-magenta',
  'terminal-ansi-cyan': '--terminal-ansi-cyan',
  'terminal-ansi-white': '--terminal-ansi-white',
  'terminal-ansi-bright-black': '--terminal-ansi-bright-black',
  'terminal-ansi-bright-red': '--terminal-ansi-bright-red',
  'terminal-ansi-bright-green': '--terminal-ansi-bright-green',
  'terminal-ansi-bright-yellow': '--terminal-ansi-bright-yellow',
  'terminal-ansi-bright-blue': '--terminal-ansi-bright-blue',
  'terminal-ansi-bright-magenta': '--terminal-ansi-bright-magenta',
  'terminal-ansi-bright-cyan': '--terminal-ansi-bright-cyan',
  'terminal-ansi-bright-white': '--terminal-ansi-bright-white',
};

interface OffscreenEditorInstance {
  filePath: string;
  container: HTMLDivElement;
  root: Root;
  host: EditorHost;
}

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

class OffscreenEditorRendererImpl {
  private editors = new Map<string, OffscreenEditorInstance>();
  private hiddenContainer: HTMLDivElement | null = null;

  /**
   * Initialize the hidden container for offscreen editors.
   */
  public initialize(): void {
    if (this.hiddenContainer) return;

    // Create hidden container for all offscreen editors
    this.hiddenContainer = document.createElement('div');
    this.hiddenContainer.id = 'offscreen-editors';
    this.hiddenContainer.style.position = 'absolute';
    this.hiddenContainer.style.left = '-9999px';
    this.hiddenContainer.style.top = '-9999px';
    this.hiddenContainer.style.width = '1280px'; // Reasonable size for screenshots
    this.hiddenContainer.style.height = '800px';
    this.hiddenContainer.style.visibility = 'hidden';
    this.hiddenContainer.style.pointerEvents = 'none';

    document.body.appendChild(this.hiddenContainer);

    // console.log('[OffscreenEditorRenderer] Initialized');
  }

  /**
   * Mount an editor offscreen for a file.
   */
  public async mountEditor(filePath: string, workspacePath: string): Promise<void> {
    // console.log('[OffscreenEditorRenderer] Mounting editor for', filePath);

    if (!this.hiddenContainer) {
      this.initialize();
    }

    // Check if already mounted offscreen
    if (this.editors.has(filePath)) {
      // console.log('[OffscreenEditorRenderer] Already mounted offscreen');
      return;
    }

    // Check if an editor is already registered for this file (visible or hidden tab)
    if (hasExtensionEditorAPI(filePath)) {
      // console.log('[OffscreenEditorRenderer] Editor already registered, skipping offscreen mount');
      return;
    }

    // Find extension that handles this file
    const extensionLoader = getExtensionLoader();

    // Extract file extension (including multi-part extensions like .mockup.html)
    const fileName = filePath.split('/').pop() || filePath;
    const firstDotIndex = fileName.indexOf('.');
    const fileExtension = firstDotIndex >= 0 ? fileName.slice(firstDotIndex) : '';

    if (!fileExtension) {
      throw new Error(`File has no extension: ${filePath}`);
    }

    // Use the extension loader's built-in method to find the editor. In the
    // hidden capture window, mount requests can arrive before the extension
    // system has registered its editors (main only waits a fixed 1s after
    // load), so wait bounded for registration instead of failing the race.
    const editorInfo = await waitForEditorRegistration(
      () => extensionLoader.findEditorForExtension(fileExtension)
    ).catch(() => null);

    if (!editorInfo) {
      throw new Error(`No custom editor registered for ${filePath} (extension: ${fileExtension})`);
    }

    // Create container for this editor
    const container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = '100%';
    this.hiddenContainer!.appendChild(container);

    // Create EditorHost for offscreen editor
    const host = this.createEditorHost(filePath, workspacePath);

    // Create React root and mount editor
    const root = createRoot(container);

    const EditorComponent = editorInfo.component as React.ComponentType<{ host: EditorHost }>;
    root.render(
      React.createElement(EditorComponent, { host })
    );

    // Store instance
    this.editors.set(filePath, {
      filePath,
      container,
      root,
      host,
    });

    // console.log('[OffscreenEditorRenderer] Editor mounted for', filePath);
  }

  /**
   * Unmount an offscreen editor.
   */
  public unmountEditor(filePath: string): void {
    // console.log('[OffscreenEditorRenderer] Unmounting editor for', filePath);

    const instance = this.editors.get(filePath);
    if (!instance) {
      // console.warn('[OffscreenEditorRenderer] No editor to unmount for', filePath);
      return;
    }

    // Unmount React
    instance.root.unmount();

    // Remove container
    if (instance.container.parentNode) {
      instance.container.parentNode.removeChild(instance.container);
    }

    this.editors.delete(filePath);

    // console.log('[OffscreenEditorRenderer] Editor unmounted for', filePath);
  }

  /**
   * Create EditorHost implementation for offscreen editor.
   */
  private createEditorHost(filePath: string, workspacePath: string): EditorHost {
    const fileName = filePath.split('/').pop() || filePath;
    const electronAPI = (window as any).electronAPI;

    // File change subscribers
    const fileChangeCallbacks: Array<(content: string) => void> = [];
    const saveRequestCallbacks: Array<() => void> = [];
    const themeChangeCallbacks: Array<(theme: string) => void> = [];

    // Dirty state
    let isDirty = false;

    const host: EditorHost = {
      filePath,
      fileName,
      theme: 'light', // TODO: Get from app settings
      isActive: false, // Offscreen editors are never "active"

      async loadContent(): Promise<string> {
        const result = await electronAPI.readFileContent(filePath);
        if (!result || !result.success) {
          throw new Error(result?.error || 'Failed to load file');
        }
        return result.content || '';
      },

      async loadBinaryContent(): Promise<ArrayBuffer> {
        const result = await electronAPI.readFileContent(filePath, { binary: true });
        if (!result || !result.success) {
          throw new Error(result?.error || 'Failed to load file');
        }
        return result.content;
      },

      onFileChanged(callback: (newContent: string) => void): () => void {
        fileChangeCallbacks.push(callback);
        return () => {
          const index = fileChangeCallbacks.indexOf(callback);
          if (index >= 0) {
            fileChangeCallbacks.splice(index, 1);
          }
        };
      },

      setDirty(dirty: boolean): void {
        isDirty = dirty;
      },

      async saveContent(content: string | ArrayBuffer): Promise<void> {
        if (typeof content === 'string') {
          await electronAPI.saveFile(content, filePath);
        } else {
          throw new Error('Binary content saving not yet implemented for offscreen editors');
        }

        isDirty = false;
      },

      onSaveRequested(callback: () => void): () => void {
        saveRequestCallbacks.push(callback);
        return () => {
          const index = saveRequestCallbacks.indexOf(callback);
          if (index >= 0) {
            saveRequestCallbacks.splice(index, 1);
          }
        };
      },

      openHistory(): void {
        // console.log('[OffscreenEditorRenderer] openHistory not implemented for offscreen editors');
      },

      onThemeChanged(callback: (theme: string) => void): () => void {
        themeChangeCallbacks.push(callback);
        return () => {
          const index = themeChangeCallbacks.indexOf(callback);
          if (index >= 0) {
            themeChangeCallbacks.splice(index, 1);
          }
        };
      },

      storage: {
        get<T>(key: string): T | undefined {
          // TODO: Implement extension storage
          return undefined;
        },
        async set<T>(key: string, value: T): Promise<void> {
          // TODO: Implement extension storage
        },
        async delete(key: string): Promise<void> {
          // TODO: Implement extension storage
        },
        getGlobal<T>(key: string): T | undefined {
          // TODO: Implement extension storage
          return undefined;
        },
        async setGlobal<T>(key: string, value: T): Promise<void> {
          // TODO: Implement extension storage
        },
        async deleteGlobal(key: string): Promise<void> {
          // TODO: Implement extension storage
        },
        async getSecret(key: string): Promise<string | undefined> {
          // TODO: Implement extension storage
          return undefined;
        },
        async setSecret(key: string, value: string): Promise<void> {
          // TODO: Implement extension storage
        },
        async deleteSecret(key: string): Promise<void> {
          // TODO: Implement extension storage
        },
      },

      setEditorContext(): void {
        // No editor context for offscreen editors
      },

      registerEditorAPI(): void {
        // Offscreen editors don't use the central registry
      },

      registerMenuItems(): void {
        // No menu items for offscreen editors
      },
    };

    // Internal helper for theme change notification (used by applyTheme)
    (host as any)._notifyThemeChanged = (newTheme: string) => {
      // Override the readonly 'theme' property on the host object
      Object.defineProperty(host, 'theme', { value: newTheme, writable: true, configurable: true });
      for (const cb of themeChangeCallbacks) {
        cb(newTheme);
      }
    };

    return host;
  }

  /**
   * Apply a theme to the capture window DOM.
   * Sets CSS class, data-theme attribute, and all --nim-* CSS variables.
   * Also notifies mounted editors via their onThemeChanged callbacks.
   */
  private applyTheme(theme: string): void {
    const isDark = theme === 'dark';
    const colors = getBaseThemeColors(isDark);
    const root = document.documentElement;

    // Set class and data-theme attribute
    const targetClass = isDark ? 'dark-theme' : 'light-theme';
    root.classList.remove('dark-theme', 'light-theme');
    root.classList.add(targetClass);
    root.setAttribute('data-theme', theme);

    // Apply all CSS variables
    for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
      const value = colors[key as keyof ExtendedThemeColors];
      if (value) {
        root.style.setProperty(cssVar, value);
      }
    }

    // Notify mounted editors so extensions can react to the theme change
    for (const instance of this.editors.values()) {
      (instance.host as any)._notifyThemeChanged?.(theme);
    }

    // console.log(`[OffscreenEditorRenderer] Applied ${theme} theme`);
  }

  /**
   * Capture a screenshot of an editor using Electron's native capturePage().
   *
   * For visible editors: gets bounding rect and invokes native capture directly.
   * For offscreen editors: temporarily positions the editor in the viewport,
   * invokes native capture, then IMMEDIATELY restores -- all within this method
   * to guarantee restore always happens and minimize visible flash.
   *
   * Returns base64-encoded PNG data.
   */
  public async captureScreenshot(filePath: string, selector?: string, theme?: string): Promise<string> {
    const electronAPI = (window as any).electronAPI;

    // If the editor's registered API supports direct PNG export, use it.
    // This produces a clean, auto-cropped image with no toolbar UI.
    // Extensions opt in by adding an exportToPngBlob method to their registered API.
    const apiExport = await this.tryExportViaEditorAPI(filePath, theme);
    if (apiExport) return apiExport;

    // Apply theme if requested (for the capture window)
    if (theme) {
      this.applyTheme(theme);
      // Wait for extensions to re-render with new theme
      await new Promise<void>(resolve => {
        requestAnimationFrame(() => setTimeout(resolve, 100));
      });
    }

    // First, check if a visible editor has this file open
    const visibleRect = this.findVisibleEditorRect(filePath, selector);
    if (visibleRect) {
      // console.log('[OffscreenEditorRenderer] Capturing visible editor for', filePath);
      const result = await electronAPI.invoke('offscreen-editor:native-capture', { rect: visibleRect });
      if (!result.success) {
        throw new Error(result.error || 'Native capture failed');
      }
      return result.imageBase64;
    }

    // Fall back to offscreen editor -- position, capture, restore all here
    const instance = this.editors.get(filePath);
    if (!instance) {
      throw new Error(`No offscreen editor mounted for ${filePath}`);
    }

    const container = instance.container;

    // Save original styles
    const originalStyles = {
      position: container.style.position,
      left: container.style.left,
      top: container.style.top,
      width: container.style.width,
      height: container.style.height,
      zIndex: container.style.zIndex,
      visibility: container.style.visibility,
    };

    try {
      // Position this specific editor at viewport origin
      container.style.position = 'fixed';
      container.style.left = '0px';
      container.style.top = '0px';
      container.style.width = '1280px';
      container.style.height = '800px';
      container.style.zIndex = '999999';
      container.style.visibility = 'visible';

      // Also make the parent visible (it's hidden by default)
      if (this.hiddenContainer) {
        this.hiddenContainer.style.visibility = 'visible';
      }

      // Wait for the compositor to render the repositioned content
      await new Promise<void>(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(resolve, 100);
          });
        });
      });

      const targetElement = selector
        ? container.querySelector(selector) as HTMLElement
        : container;

      if (!targetElement) {
        throw new Error(`Element not found: ${selector || 'container'}`);
      }

      const domRect = targetElement.getBoundingClientRect();

      if (domRect.width <= 0 || domRect.height <= 0) {
        throw new Error(`Editor element has zero dimensions: ${domRect.width}x${domRect.height}`);
      }

      const rect = {
        x: Math.round(domRect.x),
        y: Math.round(domRect.y),
        width: Math.round(domRect.width),
        height: Math.round(domRect.height),
      };

      // console.log('[OffscreenEditorRenderer] Capturing offscreen editor:', rect.width, 'x', rect.height);

      // Invoke native capture -- main process calls capturePage(rect)
      const result = await electronAPI.invoke('offscreen-editor:native-capture', { rect });
      if (!result.success) {
        throw new Error(result.error || 'Native capture failed');
      }

      return result.imageBase64;
    } finally {
      // ALWAYS restore -- this runs even if capture throws
      for (const [prop, value] of Object.entries(originalStyles)) {
        (container.style as any)[prop] = value;
      }
      if (this.hiddenContainer) {
        this.hiddenContainer.style.visibility = 'hidden';
      }
    }
  }

  /**
   * Try to export a screenshot via the editor's registered API.
   * Extensions can opt into clean export by adding an `exportToPngBlob` method
   * to the API they register via host.registerEditorAPI(). This produces an
   * auto-cropped image with no toolbar UI -- much better than a DOM capture.
   * Returns null if the API doesn't support export (falls back to DOM capture).
   */
  private async tryExportViaEditorAPI(filePath: string, theme?: string): Promise<string | null> {
    const api = getExtensionEditorAPI(filePath) as any;
    if (!api?.exportToPngBlob) {
      return null;
    }

    try {
      if (theme) {
        this.applyTheme(theme);
        await new Promise<void>(resolve => {
          requestAnimationFrame(() => setTimeout(resolve, 200));
        });
      }

      // console.log('[OffscreenEditorRenderer] Using editor API exportToPngBlob for', filePath);
      const blob: Blob = await api.exportToPngBlob({ padding: 20, maxWidthOrHeight: 1920 });

      // Convert blob to base64
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      // console.log(`[OffscreenEditorRenderer] Editor API export: ${base64.length} base64 chars`);
      return base64;
    } catch (error) {
      // console.warn('[OffscreenEditorRenderer] Editor API export failed, falling back to DOM capture:', error);
      return null;
    }
  }

  /**
   * Find the bounding rect of a visible editor for the given file.
   * Returns null if no visible editor is found.
   */
  private findVisibleEditorRect(filePath: string, selector?: string): CaptureRect | null {
    // Check for visible Excalidraw editor via central registry
    if (filePath.endsWith('.excalidraw') && hasExtensionEditorAPI(filePath)) {
      const editors = document.querySelectorAll('.excalidraw-editor');
      if (editors.length > 0) {
        const el = (selector ? editors[0].querySelector(selector) : editors[0]) as HTMLElement;
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
          }
        }
      }
    }

    // Check for any visible editor by data-file-path attribute
    const editorWrapper = document.querySelector(`[data-file-path="${filePath}"]`) as HTMLElement | null;
    if (editorWrapper) {
      const rect = editorWrapper.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        // For mockups/iframe editors, try to find the content area
        const contentArea = editorWrapper.querySelector('.flex-1.overflow-hidden') as HTMLElement | null;
        if (contentArea) {
          const contentRect = contentArea.getBoundingClientRect();
          if (contentRect.width > 0 && contentRect.height > 0) {
            return { x: Math.round(contentRect.x), y: Math.round(contentRect.y), width: Math.round(contentRect.width), height: Math.round(contentRect.height) };
          }
        }

        return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      }
    }

    return null;
  }

  /**
   * Cleanup on shutdown.
   */
  public cleanup(): void {
    // console.log('[OffscreenEditorRenderer] Cleaning up');

    // Unmount all editors
    for (const filePath of Array.from(this.editors.keys())) {
      this.unmountEditor(filePath);
    }

    // Remove hidden container
    if (this.hiddenContainer && this.hiddenContainer.parentNode) {
      this.hiddenContainer.parentNode.removeChild(this.hiddenContainer);
      this.hiddenContainer = null;
    }
  }
}

// Singleton instance
export const offscreenEditorRenderer = new OffscreenEditorRendererImpl();
