/**
 * Service for preparing document context for AI providers.
 *
 * Extracts and centralizes logic for:
 * - Document transition detection (opened/closed/switched/modified)
 * - Diff computation for modified documents
 * - Content vs diff decision based on provider type
 * - User message additions (document context prompts)
 */

import { hashContent, computeDiff } from '../../utils/documentDiff';
import type { AIProviderType } from '../server/types';

import type {
  IDocumentContextService,
  RawDocumentContext,
  DocumentState,
  DocumentTransition,
  TransitionResult,
  PreparedDocumentContext,
  UserMessageAdditions,
  ContextPreparationResult,
  ModeTransition,
  TextSelection,
  PersistedDocumentState,
  PersistDocumentStateCallback,
} from './types';

const MAX_EDITOR_CONTEXT_DATA_CHARS = 32_768;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function serializeEditorContextData(data: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(data);
    if (!serialized || serialized.length > MAX_EDITOR_CONTEXT_DATA_CHARS) return undefined;
    return serialized;
  } catch {
    return undefined;
  }
}

export class DocumentContextService implements IDocumentContextService {
  /** Per-session document state for transition detection */
  private lastDocumentStateBySession: Map<string, DocumentState> = new Map();

  /** Callback to persist state changes to database */
  private persistCallback: PersistDocumentStateCallback | null = null;

  /** Debug logging enabled flag */
  private debugEnabled = false;

  private debug(message: string, data?: Record<string, unknown>): void {
    if (this.debugEnabled) {
      const dataStr = data ? ` ${JSON.stringify(data, null, 2)}` : '';
      console.log(`[DocumentContextService] ${message}${dataStr}`);
    }
  }

  /**
   * Options for content handling in prepareContext
   */
  static readonly DEFAULT_TRUNCATE_LENGTH = 2000;

  prepareContext(
    rawContext: RawDocumentContext | undefined,
    sessionId: string,
    providerType: AIProviderType,
    modeTransition?: ModeTransition,
    options?: { truncateContent?: boolean; truncateLength?: number }
  ): ContextPreparationResult {
    this.debug('prepareContext INPUT', {
      sessionId,
      providerType,
      hasRawContext: !!rawContext,
      filePath: rawContext?.filePath,
      contentLength: rawContext?.content?.length,
      contentHash: rawContext?.content ? hashContent(rawContext.content) : undefined,
      hasSelection: !!rawContext?.selection || !!rawContext?.textSelection,
    });

    // 1. Compute document transition
    const transitionResult = this.computeTransition(rawContext, sessionId);

    // 2. Update cached state and persist
    if (transitionResult.newState) {
      this.lastDocumentStateBySession.set(sessionId, transitionResult.newState);
      // Persist to database (fire and forget - don't block on persistence)
      this.persistState(sessionId, {
        filePath: transitionResult.newState.filePath,
        contentHash: transitionResult.newState.contentHash,
      });
    } else if (transitionResult.transition === 'closed') {
      this.lastDocumentStateBySession.delete(sessionId);
      // Clear persisted state
      this.persistState(sessionId, null);
    }

    // 3. Build document context (decide content vs diff)
    const documentContext = this.buildDocumentContext(
      rawContext,
      transitionResult,
      providerType,
      options
    );

    // 4. Build user message additions (includes document context prompt and one-time editing instructions)
    const userMessageAdditions = this.buildUserMessageAdditions(modeTransition, documentContext, sessionId, providerType);

    this.debug('prepareContext OUTPUT', {
      sessionId,
      transition: transitionResult.transition,
      outputFilePath: documentContext.filePath,
      hasContent: !!documentContext.content,
      contentLength: documentContext.content?.length,
      hasDiff: !!documentContext.documentDiff,
      diffLength: documentContext.documentDiff?.length,
      hasTextSelection: !!documentContext.textSelection,
    });

    return { documentContext, userMessageAdditions };
  }

  clearSessionState(sessionId: string): void {
    this.lastDocumentStateBySession.delete(sessionId);
    // Also clear persisted state
    this.persistState(sessionId, null);
  }

  getSessionState(sessionId: string): DocumentState | undefined {
    return this.lastDocumentStateBySession.get(sessionId);
  }

  loadPersistedState(sessionId: string, state: PersistedDocumentState): void {
    // Load persisted state into memory cache.
    // Note: We don't have the content, only the hash. This means:
    // - If file hasn't changed (same hash), transition will be 'none'
    // - If file has changed (different hash), transition will be 'modified' but NO diff
    //   (since we don't have old content to diff against)
    // This is acceptable - we lose diff optimization for one message after restart.
    this.lastDocumentStateBySession.set(sessionId, {
      filePath: state.filePath,
      content: '', // Empty - we can't compute diffs without previous content
      contentHash: state.contentHash,
    });
  }

  setPersistCallback(callback: PersistDocumentStateCallback): void {
    this.persistCallback = callback;
  }

  /**
   * Persist state to database via callback (fire and forget).
   */
  private persistState(sessionId: string, state: PersistedDocumentState | null): void {
    if (this.persistCallback) {
      // Don't await - persistence is best-effort and shouldn't block the main flow
      this.persistCallback(sessionId, state).catch((err) => {
        // Log but don't throw - persistence failure shouldn't break the service
        console.error('[DocumentContextService] Failed to persist state:', err);
      });
    }
  }

  /**
   * Compute the document transition between the last state and current context.
   *
   * Logic extracted from AIService.computeDocumentTransition.
   */
  private computeTransition(
    rawContext: RawDocumentContext | undefined,
    sessionId: string
  ): TransitionResult {
    const lastState = this.lastDocumentStateBySession.get(sessionId) || null;

    this.debug('computeTransition', {
      sessionId,
      hasLastState: !!lastState,
      lastFilePath: lastState?.filePath,
      lastContentHash: lastState?.contentHash,
      currentFilePath: rawContext?.filePath,
      currentContentLength: rawContext?.content?.length,
    });

    // Case 1: No document context (user not viewing any file)
    if (!rawContext || !rawContext.filePath || !rawContext.content) {
      if (lastState?.filePath) {
        // Had a document before, now none - 'closed' transition
        return {
          transition: 'closed',
          newState: null,
          previousFilePath: lastState.filePath,
        };
      }
      // No document before or now
      return { transition: 'none', newState: null };
    }

    // Compute hash of current content
    const currentHash = hashContent(rawContext.content);
    const newState: DocumentState = {
      filePath: rawContext.filePath,
      content: rawContext.content,
      contentHash: currentHash,
      // Preserve sentEditingInstructions from previous state if same session
      sentEditingInstructions: lastState?.sentEditingInstructions,
    };

    // Case 2: No previous state - 'opened' transition (first time seeing a file)
    if (!lastState) {
      return {
        transition: 'opened',
        newState,
      };
    }

    // Case 3: Different file - 'switched' transition
    if (lastState.filePath !== rawContext.filePath) {
      return {
        transition: 'switched',
        newState,
        previousFilePath: lastState.filePath,
      };
    }

    // Case 4: Same file, same content - 'none' transition (unchanged)
    if (lastState.contentHash === currentHash) {
      return {
        transition: 'none',
        newState,
      };
    }

    // Case 5: Same file, different content - 'modified' transition
    // Compute a diff to show what changed
    const diff = computeDiff(lastState.content, rawContext.content, rawContext.filePath);

    return {
      transition: 'modified',
      newState,
      documentDiff: diff, // May be undefined if diff is larger than content
    };
  }

  /**
   * Build the prepared document context, deciding whether to use full content or diff.
   */
  private buildDocumentContext(
    rawContext: RawDocumentContext | undefined,
    transitionResult: TransitionResult,
    providerType: AIProviderType,
    options?: { truncateContent?: boolean; truncateLength?: number }
  ): PreparedDocumentContext {
    // Content handling based on transition:
    // - 'none': No content or diff (nothing changed, AI already has context)
    // - 'modified' with claude-code: Use diff instead of full content
    // - 'opened', 'switched': Full content (new file for AI)
    // - 'closed': No content (document closed)

    const transition = transitionResult.transition;

    // Build base context with fields that are always present
    const baseContext: PreparedDocumentContext = {
      filePath: rawContext?.filePath,
      fileType: rawContext?.fileType,
      documentTransition: transition,
    };

    // Add previousFilePath if present
    if (transitionResult.previousFilePath) {
      baseContext.previousFilePath = transitionResult.previousFilePath;
    }

    // Add cursor position if present
    if (rawContext?.cursorPosition) {
      baseContext.cursorPosition = rawContext.cursorPosition;
    }

    // Add textSelection if present
    const textSelection = this.normalizeTextSelection(rawContext);
    if (textSelection) {
      baseContext.textSelection = textSelection;
    }

    // Add text selection timestamp for staleness detection
    if (rawContext?.textSelectionTimestamp !== undefined) {
      baseContext.textSelectionTimestamp = rawContext.textSelectionTimestamp;
    }

    // Add mockup-specific fields if present
    if (rawContext?.mockupSelection) {
      baseContext.mockupSelection = rawContext.mockupSelection;
    }
    if (rawContext?.mockupDrawing) {
      baseContext.mockupDrawing = rawContext.mockupDrawing;
    }

    // Add extension-provided selected items (node-like editors) if present
    if (rawContext?.editorContextItems && rawContext.editorContextItems.length > 0) {
      baseContext.editorContextItems = rawContext.editorContextItems;
    }

    // For 'none' transition: omit content entirely (nothing changed)
    if (transition === 'none') {
      return baseContext;
    }

    // For 'modified' transition with available diff: use diff, omit content
    // This optimization reduces context usage for all providers
    const useDiff = transition === 'modified' && !!transitionResult.documentDiff;

    if (useDiff) {
      baseContext.documentDiff = transitionResult.documentDiff;
    } else if (rawContext?.content) {
      // Truncate content if requested (claude-code uses this to reduce context usage)
      // Chat providers can optionally use truncation via options
      const shouldTruncate = options?.truncateContent ?? (providerType === 'claude-code');
      const truncateLength = options?.truncateLength ?? DocumentContextService.DEFAULT_TRUNCATE_LENGTH;

      if (shouldTruncate && rawContext.content.length > truncateLength) {
        baseContext.content = rawContext.content.slice(0, truncateLength);
        baseContext.contentTruncated = true;
        baseContext.truncateLength = truncateLength;
      } else {
        baseContext.content = rawContext.content;
      }
    }

    return baseContext;
  }

  /**
   * Build user message additions (plan mode instructions, document context, editing instructions, etc.).
   */
  private buildUserMessageAdditions(
    modeTransition: ModeTransition | undefined,
    documentContext: PreparedDocumentContext,
    sessionId: string,
    providerType: AIProviderType
  ): UserMessageAdditions {
    const additions: UserMessageAdditions = {};

    // Note: Plan mode instructions are no longer injected into user messages.
    // The SDK handles planning behavior natively via `permissionMode: 'plan'`.

    // Build document context prompt (file path, cursor, selection, content/diff, transitions)
    const documentContextPrompt = this.buildDocumentContextPrompt(documentContext, providerType);
    if (documentContextPrompt) {
      additions.documentContextPrompt = documentContextPrompt;
    }

    // Add one-time editing instructions (only on first message with a document open)
    const state = this.lastDocumentStateBySession.get(sessionId);
    const hasDocument = !!documentContext.filePath;
    if (hasDocument && state && !state.sentEditingInstructions) {
      additions.editingInstructions = documentContext.fileType === 'collab-markdown'
        ? this.getCollabEditingInstructions()
        : this.getEditingInstructions();
      // Mark that we've sent editing instructions for this session
      state.sentEditingInstructions = true;
    }

    return additions;
  }

  /**
   * Staleness threshold for text selections (60 seconds).
   */
  private static readonly SELECTION_STALENESS_MS = 60000;

  /**
   * Build the document context prompt that gets appended to the user message.
   * This includes file path, cursor position, selected text, content/diff, and transition info.
   */
  private buildDocumentContextPrompt(context: PreparedDocumentContext, providerType: AIProviderType): string | undefined {
    const hasDocument = !!context.filePath;
    const transition = context.documentTransition;

    // If no document and no transition info, nothing to add
    if (!hasDocument && transition === 'none') {
      return undefined;
    }

    let prompt = '';

    // Handle document transitions
    if (transition === 'closed' && context.previousFilePath) {
      prompt += `The user closed the document "${context.previousFilePath}". They may have switched to agent mode or are no longer editing a file.\n\n`;
      return prompt; // No more document info to add
    }

    if (transition === 'switched' && context.previousFilePath) {
      prompt += `The user switched from "${context.previousFilePath}" to "${context.filePath}".\n\n`;
    }

    // If we have a document, show its context
    if (hasDocument) {
      prompt += `The user is currently looking at this document. They are not necessarily asking you about this document, but they may be. Use your best judgement to decide if they are making a general request or asking specifically about this document.\n`;
      prompt += `<ACTIVE_DOCUMENT>${context.filePath}</ACTIVE_DOCUMENT>\n`;

      // Collaborative documents (collab:// URIs) live in Yjs/Cloudflare Workers,
      // not on disk. Filesystem Read/Edit/Write do NOT work for this URI; the
      // agent must call readCollabDoc to see content and applyCollabDocEdit to
      // change it. We deliberately do NOT inline document content here — that
      // would balloon every prompt with the full document on every turn.
      if (context.fileType === 'collab-markdown') {
        prompt += `<COLLAB_DOCUMENT_NOTE>\n`;
        prompt += `This is a shared collaborative document synced in realtime over Yjs. Other users may be editing it concurrently — prefer small, scoped edits over sweeping rewrites.\n`;
        prompt += `To READ this document, call the readCollabDoc tool with this collab:// URI. The filesystem Read tool will not work for collab:// URIs.\n`;
        prompt += `To MODIFY this document, call applyCollabDocEdit (or applyDiff) with this collab:// URI. Filesystem tools like Edit/Write will not propagate via Yjs and will not reach other collaborators.\n`;
        prompt += `Filesystem tools remain available for OTHER files in the workspace; the constraints above apply only to this active shared document.\n`;
        prompt += `</COLLAB_DOCUMENT_NOTE>\n`;
      }

      // Add cursor position if available
      if (context.cursorPosition) {
        prompt += `Cursor: Line ${context.cursorPosition.line}, Column ${context.cursorPosition.column}\n`;
      }

      // Add selected text section with staleness detection
      if (context.textSelection) {
        const isStale = context.textSelectionTimestamp
          ? (Date.now() - context.textSelectionTimestamp > DocumentContextService.SELECTION_STALENESS_MS)
          : false;

        prompt += `\nThe user currently has the following text selected in the document:\n<SELECTED_TEXT>\n${context.textSelection}\n</SELECTED_TEXT>\n`;

        if (isStale) {
          prompt += `(Note: This selection was made over a minute ago and may be outdated.)\n`;
        }

        prompt += `When the user refers to "this", "this text", "here", or similar, they mean this selected text.\n`;
      }

      // Add mockup-specific context
      if (context.mockupSelection) {
        prompt += `\nThe user has selected this element in the mockup:\n`;
        prompt += `<SELECTED_MOCKUP_ELEMENT>\n`;
        prompt += `Tag: <${context.mockupSelection.tagName}>\n`;
        prompt += `Selector: ${context.mockupSelection.selector}\n`;
        prompt += `HTML:\n${context.mockupSelection.outerHTML}\n`;
        prompt += `</SELECTED_MOCKUP_ELEMENT>\n`;
      }

      if (context.mockupDrawing) {
        prompt += `\nThe user has drawn annotations on the mockup. Use the capture_editor_screenshot tool to see their annotations.\n`;
      }

      // Add extension-provided selected items (node-like editors: diagrams, CAD,
      // electronics). Each item is a node the user selected; the renderer has
      // already excluded any the user dismissed.
      if (context.editorContextItems && context.editorContextItems.length > 0) {
        const items = context.editorContextItems;
        const noun = items.length === 1 ? 'item' : 'items';
        prompt += `\nThe user has selected the following ${items.length} ${noun} in the editor:\n`;
        prompt += `<SELECTED_ITEMS>\n`;
        for (const item of items) {
          prompt += `  <ITEM label="${escapeXml(item.label)}">\n`;
          prompt += `  ${escapeXml(item.description)}\n`;
          if (item.includeData && item.data !== undefined) {
            const data = serializeEditorContextData(item.data);
            if (data !== undefined) {
              prompt += `  <DATA>${escapeXml(data)}</DATA>\n`;
            }
          }
          prompt += `  </ITEM>\n`;
        }
        prompt += `</SELECTED_ITEMS>\n`;
        prompt += `When the user refers to "this", "these", "the selection", or names one of these by label, they mean these selected items.\n`;
      }

      // Add content or diff based on transition.
      // For collab docs on claude-code: skip everything. The agent has the
      // readCollabDoc / applyCollabDocEdit tools and the COLLAB_DOCUMENT_NOTE
      // tells it how. Inlining the doc on every turn would balloon the prompt.
      // For collab docs on chat providers: still inline (they have no MCP /
      // readCollabDoc fallback).
      // For filesystem files: original behavior (claude-code has Read tool;
      // chat providers get content inline).
      const isCollab = context.fileType === 'collab-markdown';
      const isClaudeCodeCollab = isCollab && providerType === 'claude-code';
      if (transition === 'modified' && context.documentDiff && !isClaudeCodeCollab) {
        prompt += `\nThe document has changed since your last message:\n<DOCUMENT_DIFF>\n${context.documentDiff}\n</DOCUMENT_DIFF>\n`;
      } else if (transition === 'none' && !isClaudeCodeCollab) {
        prompt += `\n(Document content unchanged since last message.)\n`;
      } else if (context.content && providerType !== 'claude-code') {
        prompt += `\n<DOCUMENT_CONTENT>\n${context.content}\n</DOCUMENT_CONTENT>\n`;
        if (context.contentTruncated) {
          const length = context.truncateLength ?? DocumentContextService.DEFAULT_TRUNCATE_LENGTH;
          prompt += `(Content truncated to first ${length} characters. Use the Read tool to see the full file.)\n`;
        }
      }

      // Disambiguation note
      prompt += `\nWhen the user says "this file", "this document", or "here", they mean "${context.filePath}", not any other files in context.\n`;
    }

    return prompt || undefined;
  }

  /**
   * Get one-time editing instructions for collaborative shared documents.
   * Sent in place of getEditingInstructions when the active doc is a
   * collab:// URI. Steers the agent to readCollabDoc / applyCollabDocEdit
   * instead of the filesystem Read/Edit/Write tools.
   */
  private getCollabEditingInstructions(): string {
    return `Editing instructions for the active shared collaborative document. These apply only to the active collab:// document, not other files in the workspace.
<COLLAB_DOC_INSTRUCTIONS>
This document lives in a Yjs CRDT synced over Cloudflare Workers. Filesystem Read/Edit/Write WILL NOT work on it and will not propagate to other connected users.

1. Use readCollabDoc(filePath) to view the document — do NOT use the Read tool on the collab:// URI
2. Use applyCollabDocEdit(filePath, replacements) to modify it (or applyDiff against the collab:// URI). Replacements are { oldText, newText } pairs that must match exactly.
3. Other users may be editing concurrently — prefer small, scoped replacements over sweeping rewrites
4. Keep responses brief (2-4 words like "Editing document..." or "Adding section...")
5. DO NOT explain what you're doing — the user sees the changes propagate live

WORKFLOW:
1. Call readCollabDoc to see the current content (REQUIRED before editing)
2. Make your edits with applyCollabDocEdit
3. Done — the change is live for all collaborators
</COLLAB_DOC_INSTRUCTIONS>`;
  }

  /**
   * Get the one-time editing instructions.
   * These are only sent once per session when a document is first opened.
   */
  private getEditingInstructions(): string {
    return `Editing instructions for open files. These instructions only apply to when you are working on the user's currently open file. If there is no currently open file, or the user's request does not apply to the currently open file, these may be ignored.
<OPEN_FILE_INSTRUCTIONS>
When editing the user's open document, follow these rules:

1. ALWAYS use the Read tool first to view the file content before editing (required by the Edit tool)
2. Use the Edit tool to modify existing content (with exact old_string and new_string)
3. Use the Write tool to create new files or completely replace file contents
4. Changes appear as visual diffs for the user to review and approve/reject
5. Keep responses brief (2-4 words like "Editing document..." or "Adding content...")
6. DO NOT explain what you're doing - the user sees the changes as diffs

WORKFLOW:
1. Read the file to see its content (REQUIRED)
2. Make your edits with the Edit tool
3. Done - the user sees the changes as a diff
</OPEN_FILE_INSTRUCTIONS>`;
  }

  /**
   * Extract text from the various selection formats.
   * Returns just the selected text string (filePath is always the open document).
   */
  private normalizeTextSelection(rawContext?: RawDocumentContext): TextSelection | undefined {
    if (!rawContext) {
      return undefined;
    }

    // Priority 1: textSelection as string (new simplified format)
    if (typeof rawContext.textSelection === 'string' && rawContext.textSelection) {
      return rawContext.textSelection;
    }

    // Priority 2: textSelection as object (legacy format)
    if (rawContext.textSelection &&
        typeof rawContext.textSelection === 'object' &&
        'text' in rawContext.textSelection) {
      return rawContext.textSelection.text;
    }

    // Priority 3: selection as object with text property
    if (rawContext.selection &&
        typeof rawContext.selection === 'object' &&
        'text' in rawContext.selection &&
        typeof rawContext.selection.text === 'string') {
      return rawContext.selection.text;
    }

    // Priority 4: selection as string (legacy format)
    if (typeof rawContext.selection === 'string') {
      return rawContext.selection;
    }

    // No valid selection found
    return undefined;
  }
}
