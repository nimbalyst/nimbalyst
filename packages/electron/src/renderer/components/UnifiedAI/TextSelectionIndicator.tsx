import React, { useSyncExternalStore, useCallback } from 'react';

/**
 * Represents a text selection from the editor
 */
export interface TextSelection {
  text: string;
  filePath: string;
  timestamp: number;
}

interface TextSelectionIndicatorProps {
  /** Current document file path */
  currentFilePath?: string;
  /** Timestamp of the last user message in the session (or null if no messages) */
  lastUserMessageTimestamp: number | null;
}

// Store for text selection state
// This allows React to properly subscribe to changes
let listeners: Set<() => void> = new Set();
let snapshotVersion = 0;

function subscribe(callback: () => void): () => void {
  listeners.add(callback);

  // Also listen for the custom event
  const handleEvent = () => {
    snapshotVersion++;
    callback();
  };
  window.addEventListener('text-selection-changed', handleEvent);

  return () => {
    listeners.delete(callback);
    window.removeEventListener('text-selection-changed', handleEvent);
  };
}

function getSnapshot(): number {
  return snapshotVersion;
}

/**
 * Notify listeners that text selection has changed
 */
export function notifyTextSelectionChanged(): void {
  snapshotVersion++;
  listeners.forEach((listener) => listener());
  window.dispatchEvent(new CustomEvent('text-selection-changed'));
}

/**
 * Get current text selection from window globals
 */
export function getTextSelection(): TextSelection | null {
  const text = (window as any).__textSelectionText as string | undefined;
  const filePath = (window as any).__textSelectionFilePath as string | undefined;
  const timestamp = (window as any).__textSelectionTimestamp as number | undefined;

  if (!text || !filePath || !timestamp) {
    return null;
  }

  return { text, filePath, timestamp };
}

/**
 * Set text selection in window globals
 */
export function setTextSelection(text: string, filePath: string): void {
  (window as any).__textSelectionText = text;
  (window as any).__textSelectionFilePath = filePath;
  (window as any).__textSelectionTimestamp = Date.now();
  notifyTextSelectionChanged();
}

/**
 * Clear text selection from window globals.
 *
 * `ownerFilePath` scopes the clear: an editor should only clear a selection it
 * owns. Because every editor across every mounted mode (Files / Collab / Agent
 * are all mounted via CSS `display`) shares this single global selection, an
 * unscoped clear from a background editor's activation/cleanup effect would
 * instantly wipe a selection the focused editor just published. When
 * `ownerFilePath` is provided and the stored selection belongs to a DIFFERENT
 * file, we leave it alone. Omit `ownerFilePath` (e.g. the user removing the
 * chip, or a prompt send) to force an unconditional clear.
 */
export function clearTextSelection(ownerFilePath?: string): void {
  if (ownerFilePath) {
    const currentFilePath = (window as any).__textSelectionFilePath as string | undefined;
    if (currentFilePath && currentFilePath !== ownerFilePath) {
      return;
    }
  }
  (window as any).__textSelectionText = undefined;
  (window as any).__textSelectionFilePath = undefined;
  (window as any).__textSelectionTimestamp = undefined;
  notifyTextSelectionChanged();
}

/**
 * Indicator that shows when there is selected text in the editor
 * that will be included with the next AI prompt.
 *
 * Shows "+ selection" between attachments and the prompt box.
 */
export const TextSelectionIndicator: React.FC<TextSelectionIndicatorProps> = ({
  currentFilePath,
  lastUserMessageTimestamp
}) => {
  // Subscribe to selection changes using React 18's useSyncExternalStore
  // This ensures the component re-renders when the external state changes
  useSyncExternalStore(subscribe, getSnapshot);

  // Read current state directly from window globals
  // This ensures we always have the latest values
  const selectionText = (window as any).__textSelectionText as string | undefined;
  const selectionFilePath = (window as any).__textSelectionFilePath as string | undefined;
  const selectionTimestamp = (window as any).__textSelectionTimestamp as number | undefined;

  // Determine if we should show the indicator
  const shouldShow = useCallback((): boolean => {
    // Must have selected text
    if (!selectionText || selectionText.trim().length === 0) {
      return false;
    }

    // Must have a file path
    if (!selectionFilePath) {
      return false;
    }

    // Selection must be from the current file
    if (currentFilePath && selectionFilePath !== currentFilePath) {
      return false;
    }

    // Must have a timestamp
    if (!selectionTimestamp) {
      return false;
    }

    // If no user messages yet, show the indicator (new session)
    if (!lastUserMessageTimestamp) {
      return true;
    }

    // Show if selection was made after the last prompt
    return selectionTimestamp > lastUserMessageTimestamp;
  }, [selectionText, selectionFilePath, selectionTimestamp, currentFilePath, lastUserMessageTimestamp]);

  if (!shouldShow()) {
    return null;
  }

  // Create preview text (truncated if too long)
  const previewText = selectionText && selectionText.length > 50
    ? selectionText.slice(0, 50) + '...'
    : selectionText;

  // Use native title attribute for tooltip - browser handles escaping automatically
  const tooltipText = `Selected text will be included: "${previewText}"`;

  return (
    <div
      className="text-selection-indicator"
      title={tooltipText}
      style={{
        padding: '4px 8px',
        marginBottom: '4px',
        fontSize: '12px',
        color: 'var(--nim-text-muted)',
        display: 'flex',
        alignItems: 'center',
        gap: '4px'
      }}
    >
      <span>+ selection</span>
    </div>
  );
};
