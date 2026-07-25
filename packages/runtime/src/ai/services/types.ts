/**
 * Types for the DocumentContextService.
 *
 * This service is responsible for preparing document context for AI providers,
 * including transition detection, diff computation, and user message additions.
 */

import type { AIProviderType } from '../server/types';
import type { EditorContextItem } from '@nimbalyst/extension-sdk';

export type { EditorContextItem } from '@nimbalyst/extension-sdk';

/**
 * Types of document context transitions that can occur between messages.
 */
export type DocumentTransition = 'none' | 'opened' | 'closed' | 'switched' | 'modified';

/**
 * Internal state tracked per session for transition detection.
 */
export interface DocumentState {
  /** Path to the file */
  filePath: string;
  /** Full content of the document */
  content: string;
  /** Hash of the content for quick comparison */
  contentHash: string;
  /** Whether editing instructions have been sent this session (one-time only) */
  sentEditingInstructions?: boolean;
}

/**
 * Normalized text selection - just the selected text.
 * The file is always the open document (filePath), so we don't duplicate it.
 * Staleness detection uses textSelectionTimestamp on the parent object.
 */
export type TextSelection = string;

/**
 * Raw document context from the renderer process.
 * This is what comes over IPC from SessionTranscript.tsx.
 */
export interface RawDocumentContext {
  // Core document fields
  filePath?: string;
  fileType?: string;
  content: string;  // Full content always sent from renderer

  // Cursor position
  cursorPosition?: { line: number; column: number };

  // Selection (multiple formats supported - will be normalized to just the text)
  selection?: string | { text: string; filePath: string; timestamp: number } | { start: { line: number; column: number }; end: { line: number; column: number } };
  textSelection?: string | { text: string; filePath: string; timestamp: number };  // Either format accepted
  textSelectionTimestamp?: number | null;  // For staleness detection when textSelection is a string

  // Mockup-specific fields
  mockupSelection?: {
    tagName: string;
    selector: string;
    outerHTML: string;
  };
  mockupDrawing?: string;  // Data URL of drawing annotations (truthy if user drew annotations)

  // Extension-provided selected items from node-like editors.
  // Already filtered to non-dismissed items by the renderer.
  editorContextItems?: EditorContextItem[];
}

/**
 * Minimal prepared context focused on document state.
 * Session/worktree metadata stays in AIService - this service only handles document context.
 */
export interface PreparedDocumentContext {
  // Core document identity
  filePath?: string;
  fileType?: string;

  // Content (mutually exclusive based on transition)
  content?: string;       // Full content (for 'opened', 'switched', or when no diff available)
  contentTruncated?: boolean;  // True if content was truncated (for context reduction)
  truncateLength?: number;  // The length content was truncated to (for display in prompt)
  documentDiff?: string;  // Unified diff (for 'modified' when diff is smaller than content)

  // Document transition
  documentTransition: DocumentTransition;

  // Previous file path (for 'switched' and 'closed' transitions)
  previousFilePath?: string;

  // Cursor position
  cursorPosition?: { line: number; column: number };

  // Selection (normalized)
  textSelection?: TextSelection;
  textSelectionTimestamp?: number | null;  // For staleness detection

  // Mockup-specific fields
  mockupSelection?: {
    tagName: string;
    selector: string;
    outerHTML: string;
  };
  mockupDrawing?: string;  // Data URL of drawing annotations (truthy if user drew annotations)

  // Extension-provided selected items from node-like editors (non-dismissed).
  editorContextItems?: EditorContextItem[];
}

/**
 * Prompt additions to append to the user message.
 * These are the <NIMBALYST_SYSTEM_MESSAGE> blocks.
 */
export interface UserMessageAdditions {
  /** Document context prompt (file path, cursor position, selection, content/diff, transitions) */
  documentContextPrompt?: string;

  /** One-time editing instructions (only sent on first message of session with a document open) */
  editingInstructions?: string;
}

/**
 * Complete result from context preparation.
 */
export interface ContextPreparationResult {
  /** Prepared document context for the provider */
  documentContext: PreparedDocumentContext;

  /** Additions to append to the user's message */
  userMessageAdditions: UserMessageAdditions;
}

/**
 * Mode transition information for building user message additions.
 */
export interface ModeTransition {
  /** True if entering plan mode */
  enteringPlanMode?: boolean;

  /** True if exiting plan mode */
  exitingPlanMode?: boolean;

  /** Path to the plan file (for plan mode instructions) */
  planFilePath?: string;
}

/**
 * Internal result from transition computation.
 */
export interface TransitionResult {
  /** The type of transition */
  transition: DocumentTransition;

  /** New state to cache (null if closed) */
  newState: DocumentState | null;

  /** Computed diff (only for 'modified' transition) */
  documentDiff?: string;

  /** Previous file path (for 'switched' and 'closed' transitions) */
  previousFilePath?: string;
}

/**
 * Persisted document state (stored in database).
 * Does NOT include content - only hash for comparison.
 * First message after restart cannot compute diff, but can detect changes.
 */
export interface PersistedDocumentState {
  filePath: string;
  contentHash: string;
}

/**
 * Callback to persist document state changes to the database.
 */
export type PersistDocumentStateCallback = (
  sessionId: string,
  state: PersistedDocumentState | null
) => Promise<void>;

/**
 * Service for preparing document context and user message additions for AI providers.
 *
 * Responsibilities:
 * - Track document state per session (content hashing)
 * - Compute document transitions (opened/closed/switched/modified)
 * - Generate unified diffs for modified documents
 * - Decide whether to send full content or diff
 * - Build user message additions (plan mode instructions)
 *
 * NOT responsible for:
 * - System prompt building (remains in prompt.ts)
 * - Attachment file reading (handled by providers)
 * - IPC handling (remains in AIService.ts)
 * - Session/worktree metadata enrichment (remains in AIService.ts)
 */
export interface IDocumentContextService {
  /**
   * Prepare document context and user message additions for an AI provider.
   *
   * @param rawContext - Document context from renderer (may be undefined if no document open)
   * @param sessionId - Session ID for state tracking
   * @param providerType - Type of AI provider (affects content/diff decision)
   * @param modeTransition - Information about mode changes for building user message additions
   * @returns Prepared context and any user message additions
   */
  prepareContext(
    rawContext: RawDocumentContext | undefined,
    sessionId: string,
    providerType: AIProviderType,
    modeTransition?: ModeTransition
  ): ContextPreparationResult;

  /**
   * Clear cached document state for a session.
   * Call when session ends or user explicitly closes document.
   */
  clearSessionState(sessionId: string): void;

  /**
   * Get the last known document state for a session (for debugging/testing).
   */
  getSessionState(sessionId: string): DocumentState | undefined;

  /**
   * Load persisted document state from database into memory.
   * Call when a session is loaded/resumed to restore transition detection capability.
   * Note: Only hash is persisted, not content. First message after load will use
   * full content (no diff) if file has changed.
   */
  loadPersistedState(sessionId: string, state: PersistedDocumentState): void;

  /**
   * Set the callback for persisting state changes.
   * Called whenever document state changes and needs to be saved.
   */
  setPersistCallback(callback: PersistDocumentStateCallback): void;
}
