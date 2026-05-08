import React, { useRef, useEffect, KeyboardEvent, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { GenericTypeahead, TypeaheadOption } from '../Typeahead/GenericTypeahead';
import { extractTriggerMatch, getSlashTypeaheadScope, insertAtTrigger, type SlashTypeaheadScope, TriggerMatch } from '../Typeahead/typeaheadUtils';
import { buildSlashCommandOptions, fetchSlashCommandEntries, type SlashCommandEntry } from '../Typeahead/slashCommandAutocomplete';
import { readClipboard, type ChatAttachment } from '@nimbalyst/runtime';
import type { TokenUsageCategory } from '@nimbalyst/runtime/ai/server/types';
import type { EffortLevel } from '../../utils/modelUtils';
import { AttachmentPreviewList } from '../AgenticCoding/AttachmentPreviewList';
import { ModeTag, AIMode } from './ModeTag';
import { ModelSelector } from './ModelSelector';
import { EffortLevelSelector } from './EffortLevelSelector';
import { registerPendingVoiceCommandSetter } from './VoiceModeButton.tsx';
import { PendingVoiceCommand } from './PendingVoiceCommand';
import { pendingVoiceCommandAtom, voiceActiveSessionIdAtom, type PendingVoiceCommand as PendingVoiceCommandType } from '../../store/atoms/voiceModeState';
import { ContextUsageDisplay } from './ContextUsageDisplay';
import { MockupAnnotationIndicator } from './MockupAnnotationIndicator';
import { TextSelectionIndicator } from './TextSelectionIndicator';
import { EditorContextIndicator } from './EditorContextIndicator';
import {
  MemoryPromptIndicator,
  MemorySaveButton,
  useMemoryMode,
  shouldActivateMemoryMode,
  getMemoryContent,
} from './interactivePrompts';
import { HelpTooltip } from '../../help';
import {
  fileMentionOptionsAtom,
  searchFileMentionAtom,
  sessionMentionOptionsAtom,
  searchSessionMentionAtom,
  sessionRegistryAtom,
} from '../../store';
import { useAIInputUndo } from '../../hooks/useAIInputUndo';
import type { AIInputSnapshot } from '../../store/atoms/aiInputUndo';

export interface AIInputRef {
  focus: () => void;
  textarea: HTMLTextAreaElement | null;
}

interface AIInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (message?: string) => void;
  onCancel?: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  placeholder?: string;
  workspacePath?: string;
  sessionId?: string;

  // History navigation support (from ChatInput)
  onNavigateHistory?: (direction: 'up' | 'down') => void;

  // Attachment support (from AgenticInput)
  attachments?: ChatAttachment[];
  onAttachmentAdd?: (attachment: ChatAttachment) => void;
  onAttachmentRemove?: (attachmentId: string) => void;

  // Slash command support (from AgenticInput)
  enableSlashCommands?: boolean;

  // Mode support (plan vs agent)
  mode?: AIMode;
  onModeChange?: (mode: AIMode) => void;

  // Model selection support
  currentModel?: string;
  onModelChange?: (modelId: string) => void;
  sessionHasMessages?: boolean;  // Whether current session has any messages
  currentProvider?: string | null;  // Current session provider

  // Effort level support (Opus 4.6 adaptive reasoning)
  effortLevel?: EffortLevel;
  onEffortLevelChange?: (level: EffortLevel) => void;
  showEffortLevel?: boolean;

  // Token usage display support (for Claude Code)
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    contextWindow?: number;
    categories?: TokenUsageCategory[];
    currentContext?: {
      tokens: number;
      contextWindow: number;
      categories?: TokenUsageCategory[];
    };
  };
  provider?: string; // Provider ID to determine if we should show token usage

  // Queue support
  onQueue?: (message: string) => void;
  queueCount?: number;

  // Mockup annotation indicator support
  currentFilePath?: string;
  lastUserMessageTimestamp?: number | null;

  // Test ID for E2E testing
  testId?: string;
}

/**
 * Unified AI input component that merges features from AgenticInput and ChatInput.
 * Supports:
 * - File mentions (@) with typeahead
 * - Slash commands (/) with typeahead (optional)
 * - Image/file attachments via drag & drop and paste (optional)
 * - History navigation with arrow keys (optional)
 * - Auto-resize
 * - Send/Cancel buttons
 */
// Constants for prompt box resize
const MIN_PROMPT_HEIGHT = 36;
const MAX_PROMPT_HEIGHT = 600;
const DEFAULT_MAX_PROMPT_HEIGHT = 200;

export const AIInput = forwardRef<AIInputRef, AIInputProps>(
  ({
    value,
    onChange,
    onSend,
    onCancel,
    disabled,
    isLoading,
    placeholder = "Type your message... (Enter to send, Shift+Enter for new line, @ for files, @@ for sessions, / for commands)",
    workspacePath,
    sessionId,
    onNavigateHistory,
    attachments = [],
    onAttachmentAdd,
    onAttachmentRemove,
    enableSlashCommands = false,
    mode = 'planning' as AIMode,
    onModeChange,
    currentModel,
    onModelChange,
    sessionHasMessages,
    currentProvider,
    effortLevel,
    onEffortLevelChange,
    showEffortLevel,
    tokenUsage,
    provider,
    onQueue,
    queueCount = 0,
    currentFilePath,
    lastUserMessageTimestamp,
    testId,
  }, ref) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [typeaheadMatch, setTypeaheadMatch] = useState<TriggerMatch | null>(null);
    const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
    const [selectedOption, setSelectedOption] = useState<TypeaheadOption | null>(null);
    const [cursorPosition, setCursorPosition] = useState(0);
    const [slashCommandOptions, setSlashCommandOptions] = useState<TypeaheadOption[]>([]);
    const [allSlashCommands, setAllSlashCommands] = useState<SlashCommandEntry[]>([]);
    const [dragActive, setDragActive] = useState(false);
    const [isFocused, setIsFocused] = useState(false);

    // Track attachments that are being processed (e.g., compressed)
    const [processingAttachments, setProcessingAttachments] = useState<Array<{ id: string; filename: string }>>([]);

    // Track if content starting with '#' came from a paste (to prevent memory mode activation)
    const pastedHashContentRef = useRef(false);

    // Suppress typeahead re-trigger after a selection (prevents menu from reopening)
    const justSelectedRef = useRef(false);
    const lastSlashValueRef = useRef<string | null>(null);

    // Voice mode state - derived from centralized atom
    const voiceActiveSessionId = useAtomValue(voiceActiveSessionIdAtom);
    const isVoiceActive = voiceActiveSessionId === sessionId;

    // Undo/redo stack for the input. Snapshots include text, attachments, and
    // cursor; boundary events (paste, drop, typeahead, attachment add/remove,
    // history navigation) always create a new entry, while typing coalesces.
    const { pushSnapshot, undo, redo, clear: clearUndo, getUndoCount } = useAIInputUndo(sessionId);

    // Track the undoCount captured at the start of each in-flight attachment
    // processing IPC. If undo() has advanced the count by the time the IPC
    // resolves, the user undid past the paste -- drop the result instead of
    // silently re-adding the attachment.
    const pasteUndoCountRef = useRef<Map<string, number>>(new Map());

    // Skip undo pushes during IME composition; commit a single snapshot on
    // compositionend so multi-keystroke kanji etc. count as one undo unit.
    const isComposingRef = useRef(false);
    const preCompositionSnapshotRef = useRef<AIInputSnapshot | null>(null);

    // Build the snapshot we'd want to undo *back to* if the next mutation
    // happened right now. Pushed BEFORE applying any change.
    const captureSnapshot = useCallback((): AIInputSnapshot => {
      const ta = textareaRef.current;
      return {
        value,
        attachments,
        cursorStart: ta?.selectionStart ?? value.length,
        cursorEnd: ta?.selectionEnd ?? value.length,
      };
    }, [value, attachments]);

    // Apply a restored snapshot to the live draft atoms and the textarea
    // cursor. Used by both undo and redo.
    const applySnapshot = useCallback((snap: AIInputSnapshot) => {
      onChange(snap.value);
      // Reconcile attachments to the snapshot. Reference equality is enough
      // because both add and remove paths allocate fresh arrays upstream.
      if (snap.attachments !== attachments) {
        // Compute add/remove diff so we drive the existing prop callbacks.
        const currentIds = new Set(attachments.map(a => a.id));
        const targetIds = new Set(snap.attachments.map(a => a.id));
        for (const a of attachments) {
          if (!targetIds.has(a.id) && onAttachmentRemove) {
            onAttachmentRemove(a.id);
          }
        }
        for (const a of snap.attachments) {
          if (!currentIds.has(a.id) && onAttachmentAdd) {
            onAttachmentAdd(a);
          }
        }
      }
      // Restore cursor on next paint after onChange propagates.
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        try {
          ta.setSelectionRange(snap.cursorStart, snap.cursorEnd);
        } catch {
          // setSelectionRange can throw if value hasn't been applied yet --
          // best-effort, nothing actionable.
        }
      });
    }, [onChange, attachments, onAttachmentAdd, onAttachmentRemove]);

    // File mention state via Jotai atoms
    // Subscribes directly to atoms instead of receiving props (no prop drilling)
    const fileMentionOptions = useAtomValue(
      fileMentionOptionsAtom(workspacePath || '')
    );
    const searchFileMention = useSetAtom(searchFileMentionAtom);

    // Session mention state via Jotai atoms (for @@ trigger)
    const sessionMentionOptions = useAtomValue(
      sessionMentionOptionsAtom(workspacePath || '')
    );
    const searchSessionMention = useSetAtom(searchSessionMentionAtom);

    // Session registry for drag-and-drop session mention insertion
    const sessionRegistry = useAtomValue(sessionRegistryAtom);

    // Pending voice command atom
    const setPendingVoiceCommand = useSetAtom(pendingVoiceCommandAtom);

    // Register the pending voice command setter with VoiceModeButton's global listener
    // Only register if we have a sessionId
    useEffect(() => {
      if (!sessionId) return;
      return registerPendingVoiceCommandSetter(sessionId, setPendingVoiceCommand);
    }, [sessionId, setPendingVoiceCommand]);

    // Prompt box resize state
    // userSetHeight: null means auto-size to content, number means user manually resized
    const [userSetHeight, setUserSetHeight] = useState<number | null>(null);
    const [isLoadingHeight, setIsLoadingHeight] = useState(true);
    const [isResizing, setIsResizing] = useState(false);
    const isResizingRef = useRef(false);
    const resizeStartY = useRef<number>(0);
    const resizeStartHeight = useRef<number>(DEFAULT_MAX_PROMPT_HEIGHT);

    // Memory mode hook
    const {
      isMemoryMode,
      memoryTarget,
      isSaving,
      enterMemoryMode,
      exitMemoryMode,
      toggleMemoryTarget,
      setMemoryTarget,
      saveToMemory,
    } = useMemoryMode(workspacePath);

    // Load prompt box height from workspace state on mount
    useEffect(() => {
      if (!workspacePath) {
        setIsLoadingHeight(false);
        return;
      }

      const loadHeight = async () => {
        try {
          const workspaceState = await window.electronAPI.invoke('workspace:get-state', workspacePath);
          const savedHeight = workspaceState?.aiPanel?.promptBoxHeight;
          if (savedHeight !== undefined) {
            setUserSetHeight(savedHeight);
          }
        } catch (err) {
          console.error('[AIInput] Failed to load prompt box height:', err);
        } finally {
          setIsLoadingHeight(false);
        }
      };
      loadHeight();
    }, [workspacePath]);

    // Save prompt box height to workspace state when it changes
    useEffect(() => {
      if (!workspacePath || isLoadingHeight) return;

      const saveHeight = async () => {
        try {
          await window.electronAPI.invoke('workspace:update-state', workspacePath, {
            aiPanel: {
              promptBoxHeight: userSetHeight,
            }
          });
        } catch (err) {
          console.error('[AIInput] Failed to save prompt box height:', err);
        }
      };
      saveHeight();
    }, [userSetHeight, workspacePath, isLoadingHeight]);

    // Prompt box resize handlers
    const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      isResizingRef.current = true;
      setIsResizing(true);
      resizeStartY.current = e.clientY;
      // Start from current textarea height or default
      const currentHeight = textareaRef.current?.offsetHeight || DEFAULT_MAX_PROMPT_HEIGHT;
      resizeStartHeight.current = currentHeight;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    }, []);

    useEffect(() => {
      const handleMouseMove = (e: MouseEvent) => {
        if (!isResizingRef.current) return;

        // Dragging up increases height (negative deltaY = larger height)
        const deltaY = resizeStartY.current - e.clientY;
        const newHeight = Math.max(
          MIN_PROMPT_HEIGHT,
          Math.min(MAX_PROMPT_HEIGHT, resizeStartHeight.current + deltaY)
        );
        setUserSetHeight(newHeight);
      };

      const handleMouseUp = () => {
        if (!isResizingRef.current) return;

        isResizingRef.current = false;
        setIsResizing(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        // Cleanup: reset cursor and user-select if component unmounts during drag
        if (isResizingRef.current) {
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      };
    }, []);

    // Expose focus method and textarea element through the ref
    useImperativeHandle(ref, () => ({
      focus: () => {
        textareaRef.current?.focus();
      },
      get textarea() {
        return textareaRef.current;
      }
    }));

    // Auto-resize textarea (use RAF to batch DOM operations)
    // If user has manually resized (userSetHeight is set), use that height
    // Otherwise, auto-size based on content up to DEFAULT_MAX_PROMPT_HEIGHT
    useEffect(() => {
      if (!textareaRef.current) return;

      const textarea = textareaRef.current;
      const rafId = requestAnimationFrame(() => {
        if (userSetHeight !== null) {
          // User has manually set the height - use it directly
          textarea.style.height = `${userSetHeight}px`;
        } else {
          // Auto-size based on content
          textarea.style.height = 'auto';
          textarea.style.height = `${Math.min(textarea.scrollHeight, DEFAULT_MAX_PROMPT_HEIGHT)}px`;
        }
      });

      return () => cancelAnimationFrame(rafId);
    }, [value, userSetHeight]);

    // Fetch slash commands from IPC (SDK commands + local commands)
    const fetchSlashCommands = useCallback(async () => {
      if (!enableSlashCommands || !workspacePath) return;
      try {
        const commands = await fetchSlashCommandEntries({
          workspacePath,
          sessionId,
          provider: currentProvider ?? provider ?? null,
        });
        setAllSlashCommands(commands);
      } catch (error) {
        console.error('[AIInput] Failed to load slash commands:', error);
        setAllSlashCommands([]);
      }
    }, [workspacePath, sessionId, enableSlashCommands, currentProvider, provider]);

    // Fetch on mount and when workspace/session changes
    useEffect(() => {
      fetchSlashCommands();
    }, [fetchSlashCommands]);

    // Filter and sort slash commands based on query
    const filterSlashCommands = useCallback((query: string, scope: SlashTypeaheadScope) => {
      setSlashCommandOptions(buildSlashCommandOptions(allSlashCommands, query, scope));
    }, [allSlashCommands]);

    // Check for typeahead trigger when value changes (debounced for performance)
    // NOTE: cursorPosition and fileMentionOptions.length are intentionally excluded
    // from the dependency array to prevent re-triggering loops:
    // - cursorPosition is updated inside this effect via setCursorPosition, which would
    //   cause immediate re-runs and clear the debounce timer before it fires
    // - fileMentionOptions.length changes when async search results arrive, which would
    //   re-run the effect and restart the debounce timer unnecessarily
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => {
      // Skip trigger detection if we just completed a typeahead selection.
      // The value change from insertion would otherwise immediately re-open the menu.
      if (justSelectedRef.current) {
        justSelectedRef.current = false;
        return;
      }

      if (!textareaRef.current) return;

      const textarea = textareaRef.current;
      const pos = textarea.selectionStart;

      // Build trigger list based on enabled features
      // File mentions are enabled when workspacePath is provided
      // @@ (session mentions) must be checked alongside @ (file mentions)
      const triggers: string[] = [];
      if (workspacePath) triggers.push('@@');
      if (workspacePath) triggers.push('@');
      if (enableSlashCommands) triggers.push('/');

      if (triggers.length === 0) {
        setTypeaheadMatch(null);
        return;
      }

      // Debounce expensive typeahead operations (but allow immediate trigger detection)
      const match = extractTriggerMatch(value, pos, triggers);

      if (match) {
        setTypeaheadMatch(match);
        // Update cursor position for GenericTypeahead dropdown positioning
        setCursorPosition(pos);

        if (match.trigger === '/' && enableSlashCommands) {
          const slashScope = getSlashTypeaheadScope(match);
          if (slashScope) {
            filterSlashCommands(match.query, slashScope);
          } else {
            setSlashCommandOptions([]);
          }
          // Only reset selection when the input value changed (user typed),
          // not when allSlashCommands updated from an async re-fetch
          if (lastSlashValueRef.current !== value) {
            lastSlashValueRef.current = value;
            setSelectedIndex(0);
          }
          return undefined;
        }

        // Debounce the expensive filtering operations
        const timerId = setTimeout(() => {
          if (match.trigger === '@@' && workspacePath) {
            searchSessionMention({ workspacePath, query: match.query, excludeSessionId: sessionId });
          } else if (match.trigger === '@' && workspacePath) {
            searchFileMention({ workspacePath, query: match.query });
          }
        }, 150); // 150ms debounce - fast enough to feel instant, slow enough to skip intermediate keystrokes

        return () => clearTimeout(timerId);
      } else {
        lastSlashValueRef.current = null;
        setTypeaheadMatch(null);
        setSelectedIndex(null);
        setSelectedOption(null);
        setSlashCommandOptions([]);
      }
      return undefined;
    }, [value, workspacePath, searchFileMention, searchSessionMention, sessionId, filterSlashCommands, enableSlashCommands]);

    // Re-fetch slash commands when the / typeahead opens to pick up SDK skills
    // that arrive after the session initializes. Uses a separate effect to avoid
    // resetting selectedIndex when the fetch resolves.
    useEffect(() => {
      if (typeaheadMatch?.trigger === '/' && enableSlashCommands) {
        fetchSlashCommands();
      }
    }, [typeaheadMatch?.trigger, enableSlashCommands, fetchSlashCommands]);

    // Auto-select first option when file/session mention results arrive
    useEffect(() => {
      if (typeaheadMatch?.trigger === '@' && fileMentionOptions.length > 0) {
        setSelectedIndex(0);
      }
      if (typeaheadMatch?.trigger === '@@' && sessionMentionOptions.length > 0) {
        setSelectedIndex(0);
      }
    }, [fileMentionOptions.length, sessionMentionOptions.length, typeaheadMatch]);

    // Update cursor position on selection change (click/select)
    // This triggers re-evaluation of typeahead trigger for cursor repositioning
    const handleSelectionChange = useCallback(() => {
      if (textareaRef.current) {
        const pos = textareaRef.current.selectionStart;
        setCursorPosition(pos);

        // Re-evaluate typeahead trigger when cursor moves via click/select
        // (The main typeahead effect only triggers on value changes)
        const triggers: string[] = [];
        if (workspacePath) triggers.push('@');
        if (enableSlashCommands) triggers.push('/');
        if (triggers.length > 0) {
          const match = extractTriggerMatch(value, pos, triggers);
          if (match) {
            setTypeaheadMatch(match);
            if (match.trigger === '/' && enableSlashCommands) {
              const slashScope = getSlashTypeaheadScope(match);
              if (slashScope) {
                filterSlashCommands(match.query, slashScope);
              } else {
                setSlashCommandOptions([]);
              }
            }
          } else {
            setTypeaheadMatch(null);
            setSelectedIndex(null);
            setSelectedOption(null);
            setSlashCommandOptions([]);
          }
        }
      }
    }, [value, workspacePath, enableSlashCommands, filterSlashCommands]);

    useEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      textarea.addEventListener('select', handleSelectionChange);
      textarea.addEventListener('click', handleSelectionChange);

      return () => {
        textarea.removeEventListener('select', handleSelectionChange);
        textarea.removeEventListener('click', handleSelectionChange);
      };
    }, [handleSelectionChange]);

    // Detect memory mode trigger (# as first character, Claude Code provider only)
    useEffect(() => {
      // If content starts with '#', check if it came from a paste operation
      if (shouldActivateMemoryMode(value, provider)) {
        // Don't activate memory mode if this '#' content was pasted
        if (pastedHashContentRef.current) {
          return;
        }
        if (!isMemoryMode) {
          enterMemoryMode();
        }
      } else {
        // Content no longer starts with '#', reset the paste flag
        pastedHashContentRef.current = false;
        if (isMemoryMode) {
          exitMemoryMode();
        }
      }
    }, [value, provider, isMemoryMode, enterMemoryMode, exitMemoryMode]);

    // Detect /plan command trigger - immediately switch to planning mode when user types "/plan"
    useEffect(() => {
      // Match "/plan" at start, followed by end of string or whitespace (not "/planning" or "/planify")
      const planCommandMatch = value.match(/^\/plan(?:\s|$)/);
      if (planCommandMatch && mode !== 'planning' && onModeChange) {
        // Switch to planning mode immediately
        onModeChange('planning');
        // Remove the /plan prefix, keeping any text after it
        const remainingText = value.slice(planCommandMatch[0].length);
        onChange(remainingText);
      }
    }, [value, mode, onModeChange, onChange]);

    // Detect /implement command trigger - switch to agent mode when user types "/implement"
    // This allows the implement command to work even if user was in planning mode
    useEffect(() => {
      // Match "/implement" or "/nimbalyst-planning:implement" at start, followed by end of string or whitespace
      const implementCommandMatch = value.match(/^\/(nimbalyst-planning:)?implement(?:\s|$)/);
      if (implementCommandMatch && mode === 'planning' && onModeChange) {
        // Switch to agent mode immediately - implementing requires coding
        onModeChange('agent');
      }
    }, [value, mode, onModeChange]);

    // Handle typeahead option selection
    const handleTypeaheadSelect = useCallback((option: TypeaheadOption) => {
      if (!typeaheadMatch || !textareaRef.current) return;

      let insertText: string;

      if (typeaheadMatch.trigger === '@@') {
        const session = option.data;
        insertText = `@@[${session.title}](${session.shortId})`;
      } else if (typeaheadMatch.trigger === '@') {
        const doc = option.data;
        const isDirectory = doc?.type === 'directory';
        const mentionPath = doc?.path || option.label;
        insertText = `@${mentionPath}${isDirectory && !mentionPath.endsWith('/') ? '/' : ''}`;
      } else if (typeaheadMatch.trigger === '/') {
        const commandName = option.data?.name || option.id;
        insertText = `/${commandName}`;
      } else {
        return;
      }

      const { value: newValue, cursorPos } = insertAtTrigger(
        value,
        typeaheadMatch,
        insertText
      );

      // Suppress typeahead re-trigger from the value change caused by this selection
      justSelectedRef.current = true;

      pushSnapshot(captureSnapshot(), { boundary: true });
      onChange(newValue);

      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.setSelectionRange(cursorPos, cursorPos);
          textareaRef.current.focus();
        }
      }, 0);

      setTypeaheadMatch(null);
      setSelectedIndex(null);
      setSelectedOption(null);
    }, [typeaheadMatch, value, onChange, pushSnapshot, captureSnapshot]);

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const currentOptions = typeaheadMatch?.trigger === '@@' ? sessionMentionOptions
        : typeaheadMatch?.trigger === '@' ? fileMentionOptions
        : slashCommandOptions;

      // Handle typeahead navigation
      if (typeaheadMatch && currentOptions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex(prev => {
            if (prev === null) return 0;
            return Math.min(prev + 1, currentOptions.length - 1);
          });
          return;
        }

        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex(prev => {
            if (prev === null || prev === 0) return 0;
            return prev - 1;
          });
          return;
        }

        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          // Use selectedOption which is kept in sync with visual order by GenericTypeahead
          if (selectedOption) {
            handleTypeaheadSelect(selectedOption);
          }
          return;
        }

        if (e.key === 'Escape') {
          e.preventDefault();
          setTypeaheadMatch(null);
          setSelectedIndex(null);
          setSelectedOption(null);
          return;
        }
      }

      // Handle undo/redo (Cmd+Z, Cmd+Shift+Z, Ctrl+Y on Windows). Runs after
      // typeahead navigation so Tab/Enter inside the typeahead still wins.
      // Skip while IME composition is active so we don't interrupt kanji input.
      const isModUndo = (e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey && !e.nativeEvent.isComposing;
      const isModRedo =
        ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey && !e.nativeEvent.isComposing) ||
        ((e.metaKey || e.ctrlKey) && e.key === 'y' && !e.nativeEvent.isComposing);
      if (isModUndo) {
        e.preventDefault();
        const restored = undo(captureSnapshot());
        if (restored) applySnapshot(restored);
        return;
      }
      if (isModRedo) {
        e.preventDefault();
        const restored = redo(captureSnapshot());
        if (restored) applySnapshot(restored);
        return;
      }

      // Handle Shift+Tab to toggle plan mode (only for Claude Code provider)
      if (e.key === 'Tab' && e.shiftKey && provider === 'claude-code' && onModeChange && mode) {
        e.preventDefault();
        onModeChange(mode === 'planning' ? 'agent' : 'planning');
        return;
      }

      // Handle memory mode keyboard shortcuts
      if (isMemoryMode && !typeaheadMatch) {
        // Arrow keys toggle between user/project memory target
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          toggleMemoryTarget();
          return;
        }

        // Enter saves to memory
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const content = getMemoryContent(value);
          if (content.trim()) {
            saveToMemory(content).then((success) => {
              if (success) {
                onChange(''); // Clear input on success
              }
            });
          }
          return;
        }

        // Escape exits memory mode
        if (e.key === 'Escape') {
          e.preventDefault();
          onChange(''); // Clear input to exit memory mode
          return;
        }
      }

      // Handle Escape to cancel (only if typeahead is not open)
      if (e.key === 'Escape' && isLoading && onCancel) {
        e.preventDefault();
        onCancel();
        return;
      }

      // Handle Cmd+Shift+V for force-paste (bypass large paste → attachment conversion)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        readClipboard().then(text => {
          if (!text || !textareaRef.current) return;
          const textarea = textareaRef.current;
          const start = textarea.selectionStart;
          const end = textarea.selectionEnd;
          const before = value.substring(0, start);
          const after = value.substring(end);
          // Prevent '#' at start from triggering memory mode when force-pasting
          if (provider === 'claude-code' && (before + text).trimStart().startsWith('#') && before.trim() === '') {
            pastedHashContentRef.current = true;
          }
          pushSnapshot(captureSnapshot(), { boundary: true });
          onChange(before + text + after);
          setTimeout(() => {
            if (textareaRef.current) {
              const newCursorPos = start + text.length;
              textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
            }
          }, 0);
        });
        return;
      }

      // Handle Cmd+A / Ctrl+A for select all
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !e.shiftKey) {
        e.stopPropagation();
        const textarea = e.currentTarget;
        setTimeout(() => {
          textarea.select();
        }, 0);
        return;
      }

      // Handle arrow keys for history navigation (only when at start/end of input and no typeahead)
      if (onNavigateHistory && !typeaheadMatch) {
        const textarea = e.currentTarget;
        const cursorPos = textarea.selectionStart;
        const isAtStart = cursorPos === 0;
        const isAtEnd = cursorPos === value.length;

        if (e.key === 'ArrowUp' && isAtStart) {
          e.preventDefault();
          pushSnapshot(captureSnapshot(), { boundary: true });
          onNavigateHistory('up');
          setTimeout(() => {
            textarea.setSelectionRange(0, 0);
          }, 0);
          return;
        }

        if (e.key === 'ArrowDown' && isAtEnd) {
          e.preventDefault();
          pushSnapshot(captureSnapshot(), { boundary: true });
          onNavigateHistory('down');
          return;
        }
      }

      // Queue on Cmd+Shift+Enter (if loading and queue handler exists)
      // Allow queueing when typeahead has no matching options (dropdown not visible)
      const isTypeaheadVisible = typeaheadMatch && currentOptions.length > 0;
      if (e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey) && !isTypeaheadVisible) {
        e.preventDefault();
        if (value.trim() && !disabled && isLoading && onQueue) {
          handleQueue();
        }
        return;
      }

      // Handle Enter to send (Shift+Enter for new line, but not when typeahead is open)
      // Allow sending when typeahead has no matching options (dropdown not visible)
      // Skip if IME composition is in progress (e.g., Japanese kanji conversion)
      // Skip if attachments are still being processed (e.g., image compression)
      if (e.key === 'Enter' && !e.shiftKey && !isTypeaheadVisible && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (value.trim() && !disabled && processingAttachments.length === 0) {
          onSend(value);
        }
      }
    };

    // Handle file attachment
    const handleFileAttachment = useCallback(async (file: File) => {
      if (!onAttachmentAdd || !sessionId) return;

      // Generate a temporary ID for tracking processing state
      const processingId = `processing-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Capture undoCount at the START of the IPC. If undo() advances the
      // counter while the attachment:save IPC is in flight, the user undid
      // past this paste/drop -- we drop the result on resolve.
      const undoCountAtStart = getUndoCount();
      pasteUndoCountRef.current.set(processingId, undoCountAtStart);

      try {
        const validation = await window.electronAPI.invoke('attachment:validate', {
          fileSize: file.size,
          mimeType: file.type,
          filename: file.name
        });

        if (!validation.valid) {
          pasteUndoCountRef.current.delete(processingId);
          console.error('[AIInput] File validation failed:', validation.error);
          alert(validation.error || 'Invalid file');
          return;
        }

        // Add to processing state before starting compression
        setProcessingAttachments(prev => [...prev, { id: processingId, filename: file.name }]);

        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        const result = await window.electronAPI.invoke('attachment:save', {
          fileBuffer: Array.from(uint8Array),
          filename: file.name,
          mimeType: file.type,
          sessionId
        });

        // Remove from processing state
        setProcessingAttachments(prev => prev.filter(p => p.id !== processingId));

        // If the user undid past this paste/drop while the IPC was running,
        // drop the result -- they don't want this attachment back.
        const stillRelevant = pasteUndoCountRef.current.get(processingId) === undoCountAtStart
          && getUndoCount() === undoCountAtStart;
        pasteUndoCountRef.current.delete(processingId);
        if (!stillRelevant) {
          return;
        }

        if (result.success && result.attachment) {
          onAttachmentAdd(result.attachment);
          const reference = `@${file.name} `;
          onChange(value + (value ? ' ' : '') + reference);
        } else {
          console.error('[AIInput] Failed to save attachment:', result.error);
          alert(result.error || 'Failed to save attachment');
        }
      } catch (error) {
        // Remove from processing state on error
        setProcessingAttachments(prev => prev.filter(p => p.id !== processingId));
        pasteUndoCountRef.current.delete(processingId);
        console.error('[AIInput] Error handling file attachment:', error);
        alert('Failed to attach file');
      }
    }, [onAttachmentAdd, sessionId, value, onChange, getUndoCount]);

    // Drag and drop handlers
    const handleDragOver = useCallback((e: React.DragEvent) => {
      // Accept file mention and session mention drags even without attachment support
      const hasFileMention = e.dataTransfer.types.includes('application/x-nimbalyst-file-mention');
      const hasSessionMention = e.dataTransfer.types.includes('application/x-nimbalyst-session');
      if (!onAttachmentAdd && !hasFileMention && !hasSessionMention) return;
      e.preventDefault();
      e.stopPropagation();
      setDragActive(true);
    }, [onAttachmentAdd]);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
    }, []);

    const handleDrop = useCallback(async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);

      // Handle session mention drops from session history list
      const sessionDataStr = e.dataTransfer.getData('application/x-nimbalyst-session');
      if (sessionDataStr) {
        try {
          const dragData = JSON.parse(sessionDataStr);
          const session = sessionRegistry.get(dragData.sessionId);
          const title = session?.title || 'Untitled';
          const shortId = dragData.sessionId.substring(0, 5);
          const mention = `@@[${title}](${shortId})`;

          const textarea = textareaRef.current;
          const cursorPos = textarea?.selectionStart ?? value.length;
          const before = value.substring(0, cursorPos);
          const after = value.substring(cursorPos);
          const needsSpaceBefore = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n');
          const newValue = before + (needsSpaceBefore ? ' ' : '') + mention + ' ' + after;
          pushSnapshot(captureSnapshot(), { boundary: true });
          onChange(newValue);

          const newCursorPos = cursorPos + (needsSpaceBefore ? 1 : 0) + mention.length + 1;
          setTimeout(() => {
            if (textareaRef.current) {
              textareaRef.current.focus();
              textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
            }
          }, 0);
        } catch (err) {
          console.error('[AIInput] Failed to parse session drag data:', err);
        }
        return;
      }

      // Handle file mention drops from file tree or files-edited sidebar
      const fileMentionPath = e.dataTransfer.getData('application/x-nimbalyst-file-mention');
      if (fileMentionPath) {
        // Convert absolute paths to relative (file tree uses absolute, files-edited uses relative)
        let relativePath = fileMentionPath;
        if (workspacePath && fileMentionPath.startsWith(workspacePath)) {
          relativePath = fileMentionPath.slice(workspacePath.length);
          if (relativePath.startsWith('/')) relativePath = relativePath.slice(1);
        }
        const mention = `@${relativePath}`;
        // Insert at cursor position, or append with space separator
        const textarea = textareaRef.current;
        const cursorPos = textarea?.selectionStart ?? value.length;
        const before = value.substring(0, cursorPos);
        const after = value.substring(cursorPos);
        // Add space before if needed (not at start and no trailing space)
        const needsSpaceBefore = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n');
        const newValue = before + (needsSpaceBefore ? ' ' : '') + mention + ' ' + after;
        pushSnapshot(captureSnapshot(), { boundary: true });
        onChange(newValue);
        // Focus textarea and set cursor after the inserted mention
        const newCursorPos = cursorPos + (needsSpaceBefore ? 1 : 0) + mention.length + 1;
        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
            textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
          }
        }, 0);
        return;
      }

      // Handle OS file drops as attachments. Push one boundary snapshot for
      // the drop -- handleFileAttachment owns the in-flight drop logic via
      // pasteUndoCountRef so undo correctly removes pending attachments.
      if (!onAttachmentAdd) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        pushSnapshot(captureSnapshot(), { boundary: true });
      }
      for (const file of files) {
        await handleFileAttachment(file);
      }
    }, [onAttachmentAdd, handleFileAttachment, value, onChange, workspacePath, sessionRegistry, pushSnapshot, captureSnapshot]);

    // Threshold for converting large text pastes to attachments (25 lines or 2000 characters)
    const LARGE_PASTE_LINE_THRESHOLD = 25;
    const LARGE_PASTE_CHAR_THRESHOLD = 2000;

    // Paste handler for images and text
    const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items);

      // Handle image attachments
      if (onAttachmentAdd) {
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            e.preventDefault();
            const file = item.getAsFile();
            if (file) {
              // Generate unique filename for pasted images (clipboard gives generic "image.png")
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
              const ext = file.type.split('/')[1] || 'png';
              const uniqueName = `pasted-image-${timestamp}.${ext}`;
              const renamedFile = new File([file], uniqueName, { type: file.type });
              pushSnapshot(captureSnapshot(), { boundary: true });
              await handleFileAttachment(renamedFile);
            }
            return; // Exit early after handling image
          }
        }
      }

      // Get pasted text for further processing
      const pastedText = e.clipboardData.getData('text');
      if (!pastedText) return;

      // Handle large text pastes as attachments (keeps transcript clean)
      if (onAttachmentAdd && sessionId) {
        const lineCount = pastedText.split('\n').length;
        const isLargePaste = lineCount >= LARGE_PASTE_LINE_THRESHOLD ||
                            pastedText.length >= LARGE_PASTE_CHAR_THRESHOLD;

        if (isLargePaste) {
          e.preventDefault();
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const textFile = new File([pastedText], `pasted-text-${timestamp}.txt`, { type: 'text/plain' });
          pushSnapshot(captureSnapshot(), { boundary: true });
          await handleFileAttachment(textFile);
          return;
        }
      }

      // For Claude Code provider: prevent pasted text starting with '#' from triggering memory mode
      if (provider === 'claude-code' && pastedText.trimStart().startsWith('#')) {
        e.preventDefault();
        // Set flag to prevent memory mode activation for this pasted content
        pastedHashContentRef.current = true;
        // When pasting into empty input, prepend newline to avoid '#' being first character
        // When pasting into non-empty input, use normal paste behavior
        const newValue = value.trim() === '' ? '\n' + pastedText : value + pastedText;
        pushSnapshot(captureSnapshot(), { boundary: true });
        onChange(newValue);
      }
      // Note: ordinary in-line text pastes fall through to the textarea's
      // native paste, which fires onChange and is recorded by the typing
      // path (with coalescing).
    }, [onAttachmentAdd, handleFileAttachment, provider, value, onChange, sessionId, pushSnapshot, captureSnapshot]);

    // Handle attachment removal
    const handleRemoveAttachment = useCallback((attachmentId: string) => {
      if (onAttachmentRemove) {
        pushSnapshot(captureSnapshot(), { boundary: true });
        onAttachmentRemove(attachmentId);
      }
    }, [onAttachmentRemove, pushSnapshot, captureSnapshot]);

    // Handle converting a text attachment back to prompt text
    const handleConvertToText = useCallback(async (attachment: ChatAttachment) => {
      try {
        const result = await window.electronAPI.invoke('attachment:readAsText', {
          filepath: attachment.filepath
        }) as { success: boolean; data?: string; error?: string };

        if (result.success && result.data) {
          // Append the text to the current input value
          const newValue = value ? `${value}\n${result.data}` : result.data;
          // Single boundary covers both the value change and the attachment
          // removal so undo restores the attachment AND clears the appended
          // text in one step.
          pushSnapshot(captureSnapshot(), { boundary: true });
          onChange(newValue);

          // Remove the attachment
          if (onAttachmentRemove) {
            onAttachmentRemove(attachment.id);
          }
        } else {
          console.error('[AIInput] Failed to read attachment as text:', result.error);
        }
      } catch (error) {
        console.error('[AIInput] Failed to convert attachment to text:', error);
      }
    }, [value, onChange, onAttachmentRemove, pushSnapshot, captureSnapshot]);

    const handleSend = () => {
      if (value.trim() && !disabled && processingAttachments.length === 0) {
        onSend(value);
      }
    };

    const handleQueue = () => {
      if (value.trim() && !disabled && onQueue) {
        onQueue(value);
      }
    };

    // Handle memory save button click
    const handleMemorySave = useCallback(() => {
      const content = getMemoryContent(value);
      if (content.trim()) {
        saveToMemory(content).then((success) => {
          if (success) {
            onChange(''); // Clear input on success
          }
        });
      }
    }, [value, saveToMemory, onChange]);

    // Handle pending voice command submission
    const handlePendingVoiceCommandSubmit = useCallback(async (
      prompt: string,
      cmdSessionId: string,
      cmdWorkspacePath: string,
      codingAgentPrompt?: { prepend?: string; append?: string }
    ) => {
      try {
        await window.electronAPI.invoke(
          'ai:createQueuedPrompt',
          cmdSessionId,
          prompt,
          undefined, // attachments
          {
            isVoiceMode: true,
            voiceModeCodingAgentPrompt: codingAgentPrompt,
          }
        );
      } catch (error) {
        console.error('[AIInput] Failed to submit pending voice command:', error);
      }
    }, []);

    return (
      <div className={`ai-chat-input flex flex-col gap-1.5 px-3 py-1.5 border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shrink-0 relative ${isMemoryMode ? 'memory-mode' : ''}`}>
        {/* Vertical resize handle at top of input area */}
        <div
          className={`ai-chat-input-resize-handle absolute -top-[3px] left-0 right-0 h-1.5 cursor-row-resize z-10 before:content-[''] before:absolute before:top-0.5 before:left-0 before:right-0 before:h-0.5 before:transition-colors before:duration-150 ${isResizing ? 'before:bg-[var(--nim-primary)]' : ''} hover:before:bg-[var(--nim-primary)]`}
          onMouseDown={handleResizeMouseDown}
          title="Drag to resize prompt box"
        />

        {/* Pending voice command with countdown */}
        {sessionId && <PendingVoiceCommand sessionId={sessionId} onSubmit={handlePendingVoiceCommandSubmit} />}

        {/* Memory mode indicator */}
        {isMemoryMode && (
          <MemoryPromptIndicator
            target={memoryTarget}
            onTargetChange={setMemoryTarget}
            isSaving={isSaving}
            workspacePath={workspacePath}
          />
        )}

        {/* Attachment preview list */}
        {((attachments && attachments.length > 0) || processingAttachments.length > 0) && (
          <AttachmentPreviewList
            attachments={attachments}
            onRemove={handleRemoveAttachment}
            onConvertToText={handleConvertToText}
            processingAttachments={processingAttachments}
          />
        )}

        {/* Mockup annotation indicator - shown when there are new annotations */}
        <MockupAnnotationIndicator
          currentFilePath={currentFilePath}
          lastUserMessageTimestamp={lastUserMessageTimestamp ?? null}
        />

        {/* Text selection indicator - shown when text is selected in the editor */}
        <TextSelectionIndicator
          currentFilePath={currentFilePath}
          lastUserMessageTimestamp={lastUserMessageTimestamp ?? null}
        />

        {/* Editor context indicator - shown when extension pushes context */}
        <EditorContextIndicator
          currentFilePath={currentFilePath}
          lastUserMessageTimestamp={lastUserMessageTimestamp ?? null}
        />

        {/* Inline controls row - hidden in memory mode */}
        {!isMemoryMode && (onModeChange || onModelChange || (tokenUsage && provider === 'claude-code')) && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
{onModeChange && provider === 'claude-code' && mode && <ModeTag mode={mode} onModeChange={onModeChange} />}

            {onModelChange && (
              <HelpTooltip testId="model-picker">
                <span style={{ display: 'inline-flex' }}>
                  <ModelSelector
                    currentModel={currentModel || ''}
                    onModelChange={onModelChange}
                    sessionHasMessages={sessionHasMessages}
                    currentProvider={currentProvider}
                  />
                </span>
              </HelpTooltip>
            )}
            {showEffortLevel && onEffortLevelChange && effortLevel && (
              <EffortLevelSelector
                level={effortLevel}
                onLevelChange={onEffortLevelChange}
              />
            )}
            {/* Show token usage for all providers - displays "--" if no data yet */}
            <ContextUsageDisplay
              inputTokens={tokenUsage?.inputTokens || 0}
              outputTokens={tokenUsage?.outputTokens || 0}
              totalTokens={tokenUsage?.totalTokens || 0}
              contextWindow={tokenUsage?.contextWindow || 0}
              categories={tokenUsage?.categories}
              currentContext={tokenUsage?.currentContext}
            />
          </div>
        )}

        {/* Input container with drag/drop support */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'row',
            gap: '8px',
            position: 'relative',
            border: dragActive ? '2px dashed var(--nim-primary)' : 'none',
            borderRadius: dragActive ? '4px' : '0',
            backgroundColor: dragActive ? 'var(--nim-bg-hover)' : 'transparent',
            transition: 'all 0.2s ease',
            padding: dragActive ? '4px' : '0'
          }}
        >
          <textarea
            ref={textareaRef}
            data-testid={testId}
            className="ai-chat-input-field nim-scrollbar-hidden flex-1 min-h-9 py-2 px-3 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] text-[13px] font-[inherit] resize-none outline-none transition-colors duration-200 focus:border-[var(--nim-primary)] disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-[var(--nim-text-faint)]"
            value={value}
            onChange={(e) => {
              // textarea onChange only fires from real user input events
              // (typing, native paste, drag-into-text). Programmatic value
              // changes from the parent do not trigger this. Push the
              // pre-edit snapshot so undo can roll back the typing burst.
              if (!isComposingRef.current) {
                pushSnapshot(captureSnapshot());
              }
              onChange(e.target.value);
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
              // Capture pre-composition state once; any keystrokes during
              // composition are skipped, then a single boundary snapshot is
              // pushed on compositionend.
              preCompositionSnapshotRef.current = captureSnapshot();
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              if (preCompositionSnapshotRef.current) {
                pushSnapshot(preCompositionSnapshotRef.current, { boundary: true });
                preCompositionSnapshotRef.current = null;
              }
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            style={{
              minHeight: `${MIN_PROMPT_HEIGHT}px`,
              maxHeight: `${userSetHeight ?? DEFAULT_MAX_PROMPT_HEIGHT}px`,
            }}
          />
          {isMemoryMode ? (
            // Memory mode: show save button
            <MemorySaveButton
              onSave={handleMemorySave}
              disabled={disabled || !getMemoryContent(value).trim()}
              isSaving={isSaving}
            />
          ) : isLoading ? (
            onCancel && (
              <button
                className="ai-chat-cancel-button w-9 h-9 flex items-center justify-center bg-red-600 border-none rounded-md text-white cursor-pointer transition-all duration-200 animate-pulse hover:bg-red-700 hover:scale-105 hover:animate-none"
                onClick={() => {
                  console.log('[AIInput] Cancel button clicked, onCancel:', !!onCancel);
                  onCancel();
                }}
                title="Cancel request (Esc)"
                aria-label="Cancel request"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 4L4 12M4 4L12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )
          ) : (
            <button
              className="ai-chat-send-button w-9 h-9 flex items-center justify-center bg-[var(--nim-primary)] border-none rounded-md text-white cursor-pointer transition-all duration-200 shrink-0 hover:enabled:bg-[var(--nim-primary-hover)] hover:enabled:scale-105 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleSend}
              disabled={disabled || !value.trim() || processingAttachments.length > 0}
              title={processingAttachments.length > 0 ? "Processing attachments..." : "Send message (Enter)"}
              aria-label="Send message"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 8L14 2L11 14L8 9L2 8Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
        </div>

        {/* Typeahead for session mentions, file mentions, and slash commands - only show if focused */}
        {isFocused && typeaheadMatch && (
          (typeaheadMatch.trigger === '@@' && sessionMentionOptions.length > 0) ||
          (typeaheadMatch.trigger === '@' && fileMentionOptions.length > 0) ||
          (typeaheadMatch.trigger === '/' && slashCommandOptions.length > 0)
        ) && (
          <GenericTypeahead
            anchorElement={textareaRef.current}
            options={typeaheadMatch.trigger === '@@' ? sessionMentionOptions
              : typeaheadMatch.trigger === '@' ? fileMentionOptions
              : slashCommandOptions}
            selectedIndex={selectedIndex}
            onSelectedIndexChange={setSelectedIndex}
            onSelectedOptionChange={setSelectedOption}
            onSelect={handleTypeaheadSelect}
            onClose={() => {
              setTypeaheadMatch(null);
              setSelectedIndex(null);
              setSelectedOption(null);
            }}
            cursorPosition={cursorPosition}
            maxHeight={500}
            minWidth={typeaheadMatch.trigger === '@@' ? 360 : undefined}
            sectionOrder={typeaheadMatch.trigger === '/'
              ? ['Built-in Commands', 'Project Commands', 'User Commands', 'Extension Commands',
                 'Project Skills', 'User Skills', 'Plugin Skills']
              : undefined}
          />
        )}

      </div>
    );
  }
);

AIInput.displayName = 'AIInput';
