/**
 * Document diff utilities for optimizing document context transmission.
 *
 * When sending document context with AI messages, we want to avoid sending
 * the full document content on every message if it hasn't changed or has
 * only changed slightly. This module provides:
 *
 * 1. Content hashing for change detection
 * 2. Diff computation for changed content
 * 3. Diff application to reconstruct full content
 */

import { createPatch, applyPatch, parsePatch } from 'diff';

/**
 * Stored document state for a session.
 * This is persisted in message metadata to enable diff computation.
 */
export interface DocumentState {
  /** Path to the file */
  filePath: string;
  /** Full content of the document */
  content: string;
  /** Hash of the content for quick comparison */
  contentHash: string;
}

/**
 * Types of document context transitions that can occur between messages.
 */
export type DocumentTransition =
  | 'none'           // No change - same file, same content (or no file in both)
  | 'opened'         // User started viewing a file (was not viewing any)
  | 'closed'         // User stopped viewing a file (now viewing none)
  | 'switched'       // User switched to a different file
  | 'modified';      // Same file, content changed

/**
 * Document context that can be sent with a message.
 * Supports three modes:
 * 1. Full content (first message or different file)
 * 2. Unchanged (same file, same content)
 * 3. Diff (same file, changed content)
 */
export interface SerializedDocumentContext {
  /** Path to the file */
  filePath?: string;
  /** File type for syntax highlighting etc. */
  fileType?: string;
  /** Text selection context - flexible type to support different selection formats */
  textSelection?: unknown;
  /** Timestamp of when text was selected */
  textSelectionTimestamp?: number;

  // Content modes - exactly one should be set when there's content:
  /** Full document content (mode: full) */
  content?: string;
  /** Hash of the content when sending full content */
  contentHash?: string;
  /** Flag indicating content is unchanged from previous message (mode: unchanged) */
  unchanged?: boolean;
  /** Unified diff patch when content has changed (mode: diff) */
  diff?: string;
  /** Hash of the base content the diff is computed against */
  baseContentHash?: string;

  // Transition information for system messages
  /** Type of transition from previous message's document context */
  transition?: DocumentTransition;
  /** Path of the previously viewed file (for 'switched' and 'closed' transitions) */
  previousFilePath?: string;
}

/**
 * Result of resolving document context, always contains full content.
 */
export interface ResolvedDocumentContext {
  filePath?: string;
  fileType?: string;
  content?: string;
  contentHash?: string;
  /** Text selection context - flexible type to support different selection formats */
  textSelection?: unknown;
  textSelectionTimestamp?: number;
}

/**
 * Simple non-cryptographic hash for content comparison.
 * Uses djb2 algorithm - fast and good distribution for string comparison.
 */
export function hashContent(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash) + content.charCodeAt(i);
    // Convert to unsigned 32-bit integer
    hash = hash >>> 0;
  }
  return hash.toString(16);
}

/**
 * Compute a unified diff between two strings.
 * Returns undefined if the diff is larger than the new content (not worth it).
 */
export function computeDiff(
  oldContent: string,
  newContent: string,
  filePath: string = 'document'
): string | undefined {
  const patch = createPatch(filePath, oldContent, newContent, '', '', { context: 3 });

  // If the diff is larger than the new content, just send full content
  // This can happen with large changes or complete rewrites
  if (patch.length >= newContent.length) {
    return undefined;
  }

  return patch;
}

/**
 * Apply a unified diff patch to reconstruct the new content.
 */
export function applyDiff(baseContent: string, patch: string): string {
  const result = applyPatch(baseContent, patch);
  if (result === false) {
    throw new Error('Failed to apply diff patch - base content may have changed');
  }
  return result;
}

/**
 * Check if a diff patch is valid (can be parsed).
 */
export function isValidDiff(patch: string): boolean {
  try {
    const parsed = parsePatch(patch);
    return parsed.length > 0;
  } catch {
    return false;
  }
}

/**
 * Serialize document context for IPC, computing diff if beneficial.
 *
 * @param current - Current document context with full content
 * @param lastState - Last known document state for this session (if any)
 * @returns Serialized context and the new document state to store
 */
export function serializeDocumentContextWithDiff(
  current: {
    filePath?: string;
    content?: string;
    fileType?: string;
    /** Text selection context - flexible type to support different selection formats */
    textSelection?: unknown;
    textSelectionTimestamp?: number;
  },
  lastState?: DocumentState | null
): { serialized: SerializedDocumentContext; newState: DocumentState | null } {
  // Determine the transition type
  const hadFile = lastState && lastState.filePath;
  const hasFile = current.filePath && current.content;

  let transition: DocumentTransition = 'none';
  let previousFilePath: string | undefined;

  if (!hadFile && hasFile) {
    // Was not viewing a file, now viewing one
    transition = 'opened';
  } else if (hadFile && !hasFile) {
    // Was viewing a file, now not viewing any
    transition = 'closed';
    previousFilePath = lastState?.filePath;
  } else if (hadFile && hasFile && lastState?.filePath !== current.filePath) {
    // Switched from one file to another
    transition = 'switched';
    previousFilePath = lastState?.filePath;
  }
  // 'modified' and 'none' are determined below based on content comparison

  // Base result without content
  const base: SerializedDocumentContext = {
    filePath: current.filePath,
    fileType: current.fileType,
    textSelection: current.textSelection,
    textSelectionTimestamp: current.textSelectionTimestamp,
    transition,
    previousFilePath,
  };

  // No content to process (user not viewing any file)
  if (!current.content) {
    return { serialized: base, newState: null };
  }

  const currentHash = hashContent(current.content);
  const newState: DocumentState = {
    filePath: current.filePath || '',
    content: current.content,
    contentHash: currentHash,
  };

  // Case 1: No previous state or different file - send full content
  if (!lastState || lastState.filePath !== current.filePath) {
    return {
      serialized: {
        ...base,
        content: current.content,
        contentHash: currentHash,
      },
      newState,
    };
  }

  // Case 2: Same content - mark as unchanged
  if (lastState.contentHash === currentHash) {
    return {
      serialized: {
        ...base,
        unchanged: true,
        transition: 'none', // Override - no transition if same file and content
      },
      newState,
    };
  }

  // Case 3: Content changed - try to compute diff
  const diff = computeDiff(lastState.content, current.content, current.filePath);
  if (diff) {
    return {
      serialized: {
        ...base,
        diff,
        baseContentHash: lastState.contentHash,
        transition: 'modified', // Content was modified
      },
      newState,
    };
  }

  // Diff was larger than content - send full content
  return {
    serialized: {
      ...base,
      content: current.content,
      contentHash: currentHash,
      transition: 'modified', // Content was modified (large change)
    },
    newState,
  };
}

/**
 * Resolve serialized document context to full content.
 *
 * @param serialized - Serialized context (may contain diff or be unchanged)
 * @param lastState - Last known document state for this session
 * @returns Resolved context with full content
 */
export function resolveDocumentContext(
  serialized: SerializedDocumentContext,
  lastState?: DocumentState | null
): ResolvedDocumentContext {
  const base: ResolvedDocumentContext = {
    filePath: serialized.filePath,
    fileType: serialized.fileType,
    textSelection: serialized.textSelection,
    textSelectionTimestamp: serialized.textSelectionTimestamp,
  };

  // Case 1: Full content provided
  if (serialized.content) {
    return {
      ...base,
      content: serialized.content,
      contentHash: serialized.contentHash || hashContent(serialized.content),
    };
  }

  // Case 2: Unchanged - use last state's content
  if (serialized.unchanged) {
    if (!lastState) {
      console.warn('[resolveDocumentContext] Received unchanged flag but no last state available');
      return base;
    }
    // CRITICAL: Verify filePath matches before using lastState content
    // This prevents using wrong content if renderer/backend states get out of sync
    if (lastState.filePath !== serialized.filePath) {
      console.warn('[resolveDocumentContext] FilePath mismatch - lastState has', lastState.filePath, 'but serialized has', serialized.filePath);
      return base;
    }
    return {
      ...base,
      content: lastState.content,
      contentHash: lastState.contentHash,
    };
  }

  // Case 3: Diff provided - apply to last state
  if (serialized.diff) {
    if (!lastState) {
      console.warn('[resolveDocumentContext] Received diff but no last state available');
      return base;
    }

    // CRITICAL: Verify filePath matches before applying diff
    if (lastState.filePath !== serialized.filePath) {
      console.warn('[resolveDocumentContext] FilePath mismatch for diff - lastState has', lastState.filePath, 'but serialized has', serialized.filePath);
      return base;
    }

    // Verify base content hash matches
    if (serialized.baseContentHash && serialized.baseContentHash !== lastState.contentHash) {
      console.warn('[resolveDocumentContext] Base content hash mismatch - diff may not apply correctly');
    }

    try {
      const content = applyDiff(lastState.content, serialized.diff);
      return {
        ...base,
        content,
        contentHash: hashContent(content),
      };
    } catch (error) {
      console.error('[resolveDocumentContext] Failed to apply diff:', error);
      return base;
    }
  }

  // No content mode specified
  return base;
}
