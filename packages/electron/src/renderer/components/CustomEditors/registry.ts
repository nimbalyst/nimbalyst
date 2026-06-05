/**
 * Custom Editor Registry
 *
 * Manages registration and lookup of custom editor components for specific file types.
 * This allows extending the editor system without modifying TabEditor.tsx.
 */

import type { CustomEditorComponent, CustomEditorRegistration } from './types';
import { logger } from '../../utils/logger';

class CustomEditorRegistry {
  private registrations: Map<string, CustomEditorRegistration> = new Map();
  private changeListeners: Set<() => void> = new Set();

  /**
   * Subscribe to registry changes (extensions being registered/unregistered).
   * Returns an unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * Notify all listeners that the registry has changed.
   */
  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        logger.ui.error('[CustomEditorRegistry] Error in change listener:', error);
      }
    }
  }

  /**
   * Register a custom editor for one or more file extensions
   */
  register(registration: CustomEditorRegistration): void {
    const { extensions, component, name } = registration;

    if (!extensions || extensions.length === 0) {
      logger.ui.warn('[CustomEditorRegistry] Attempted to register editor without extensions');
      return;
    }

    if (!component) {
      logger.ui.warn('[CustomEditorRegistry] Attempted to register editor without component');
      return;
    }

    // Register each extension
    for (const ext of extensions) {
      const normalizedExt = ext.toLowerCase();

      // Check for conflicts
      if (this.registrations.has(normalizedExt)) {
        const existing = this.registrations.get(normalizedExt);
        logger.ui.warn(
          `[CustomEditorRegistry] Extension ${ext} is already registered by ${existing?.name || 'unknown'}. Overwriting.`
        );
      }

      this.registrations.set(normalizedExt, registration);
      logger.ui.info(
        `[CustomEditorRegistry] Registered ${name || 'custom editor'} for extension ${ext}`
      );
    }

    // Notify listeners that registry has changed
    this.notifyChange();
  }

  /**
   * Get the custom editor component for a file extension
   * Returns undefined if no custom editor is registered for this extension
   */
  getEditor(extension: string): CustomEditorComponent | undefined {
    const normalizedExt = extension.toLowerCase();
    const registration = this.registrations.get(normalizedExt);
    return registration?.component;
  }

  /**
   * Check if a custom editor is registered for a file extension
   */
  hasEditor(extension: string): boolean {
    const normalizedExt = extension.toLowerCase();
    return this.registrations.has(normalizedExt);
  }

  /**
   * Get the full registration info for a file extension
   */
  getRegistration(extension: string): CustomEditorRegistration | undefined {
    const normalizedExt = extension.toLowerCase();
    return this.registrations.get(normalizedExt);
  }

  /**
   * Find the best match for a file path by longest-suffix match across all
   * registered keys. Supports compound extensions of any depth
   * (e.g. `.reddit.watch.json`). Returns the matched key alongside the
   * registration, or undefined if no key is a suffix of the filename.
   */
  findMatchForFile(
    filePath: string
  ): { key: string; registration: CustomEditorRegistration } | undefined {
    // Virtual (fileless) tabs have no basename suffix to match on. They are
    // claimed by registrations whose key is a `virtual://…` prefix (declared as
    // a filePattern like `virtual://com.nimbalyst.browser/*`). Longest matching
    // prefix wins, mirroring the longest-suffix rule used for real files.
    if (filePath.startsWith('virtual://')) {
      const lowerPath = filePath.toLowerCase();
      let bestVirtualKey: string | undefined;
      for (const key of this.registrations.keys()) {
        if (!key.startsWith('virtual://')) continue;
        const prefix = key.endsWith('*') ? key.slice(0, -1) : key;
        if (lowerPath.startsWith(prefix) && (!bestVirtualKey || key.length > bestVirtualKey.length)) {
          bestVirtualKey = key;
        }
      }
      if (bestVirtualKey) {
        const registration = this.registrations.get(bestVirtualKey);
        if (registration) return { key: bestVirtualKey, registration };
      }
      return undefined;
    }

    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const basename = (lastSlash >= 0 ? filePath.substring(lastSlash + 1) : filePath).toLowerCase();

    let bestKey: string | undefined;
    for (const key of this.registrations.keys()) {
      if (basename.endsWith(key) && (!bestKey || key.length > bestKey.length)) {
        bestKey = key;
      }
    }
    if (!bestKey) return undefined;
    const registration = this.registrations.get(bestKey);
    return registration ? { key: bestKey, registration } : undefined;
  }

  /**
   * Convenience wrapper around `findMatchForFile` that returns just the
   * registration, for callers that don't need the matched key.
   */
  findRegistrationForFile(filePath: string): CustomEditorRegistration | undefined {
    return this.findMatchForFile(filePath)?.registration;
  }

  /**
   * Unregister a custom editor for specific extensions
   */
  unregister(extensions: string[]): void {
    let changed = false;
    for (const ext of extensions) {
      const normalizedExt = ext.toLowerCase();
      const registration = this.registrations.get(normalizedExt);
      if (registration) {
        this.registrations.delete(normalizedExt);
        changed = true;
        logger.ui.info(
          `[CustomEditorRegistry] Unregistered ${registration.name || 'custom editor'} for extension ${ext}`
        );
      }
    }

    // Notify listeners if any registrations were removed
    if (changed) {
      this.notifyChange();
    }
  }

  /**
   * Get all registered extensions
   */
  getRegisteredExtensions(): string[] {
    return Array.from(this.registrations.keys());
  }

  /**
   * Clear all registrations (useful for testing)
   */
  clear(): void {
    this.registrations.clear();
    logger.ui.info('[CustomEditorRegistry] Cleared all custom editor registrations');
  }
}

// Singleton instance
export const customEditorRegistry = new CustomEditorRegistry();
