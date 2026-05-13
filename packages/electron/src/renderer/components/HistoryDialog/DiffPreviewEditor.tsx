import React, { useEffect, useRef, useState, useCallback } from 'react';
import { NimbalystEditor } from '@nimbalyst/runtime';
import {
  APPLY_MARKDOWN_REPLACE_COMMAND,
  groupDiffChanges,
  scrollToChangeGroup,
  $getDiffState,
  $hasDiffNodes,
  type DiffChangeGroup
} from '@nimbalyst/runtime';
import type { LexicalEditor } from 'lexical';

const HIGHLIGHT_CLASS_REMOVED = 'diff-group-highlight-removed';
const HIGHLIGHT_CLASS_ADDED = 'diff-group-highlight-added';
const HIGHLIGHT_CLASS_MODIFIED = 'diff-group-highlight-modified';

export interface DiffNavigationState {
  currentIndex: number;
  totalGroups: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
}

interface DiffPreviewEditorProps {
  oldMarkdown: string;
  newMarkdown: string;
  onNavigationStateChange?: (state: DiffNavigationState) => void;
  onNavigatePrevious?: () => void;
  onNavigateNext?: () => void;
  theme?: string;
}

export function DiffPreviewEditor({
  oldMarkdown,
  newMarkdown,
  onNavigationStateChange,
  onNavigatePrevious,
  onNavigateNext,
  theme = 'light'
}: DiffPreviewEditorProps) {
  const editorRef = useRef<LexicalEditor | null>(null);
  const appliedRef = useRef(false);
  const [isReady, setIsReady] = useState(false);
  const [changeGroups, setChangeGroups] = useState<DiffChangeGroup[]>([]);
  const [currentGroupIndex, setCurrentGroupIndex] = useState(0);
  const isNavigatingRef = useRef(false);
  const currentGroupIndexRef = useRef(0);
  const changeGroupsRef = useRef<DiffChangeGroup[]>([]);

  // Keep refs in sync with state
  useEffect(() => {
    currentGroupIndexRef.current = currentGroupIndex;
  }, [currentGroupIndex]);

  useEffect(() => {
    changeGroupsRef.current = changeGroups;
  }, [changeGroups]);

  // Handle clicks on diff nodes to update navigation index
  const handleEditorClick = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    editor.getEditorState().read(() => {
      const selection = editor._editorState._selection;
      if (!selection || !('anchor' in selection)) return;

      const anchor = (selection as any).anchor;
      const node = anchor.getNode();
      if (!node) return;

      // Find which change group contains this node
      const groups = changeGroupsRef.current;
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        // Check if any node in this group matches or is an ancestor
        for (const groupNode of group.nodes) {
          try {
            let currentNode = node;
            // Walk up the tree to see if we're inside this group node
            while (currentNode) {
              if (currentNode.getKey() === groupNode.getKey()) {
                // Found the group!
                if (i !== currentGroupIndexRef.current) {
                  setCurrentGroupIndex(i);
                  scrollToChangeGroup(editor, i, groups);

                  // Update parent state immediately
                  if (onNavigationStateChange) {
                    onNavigationStateChange({
                      currentIndex: i,
                      totalGroups: groups.length,
                      canGoPrevious: i > 0,
                      canGoNext: i < groups.length - 1
                    });
                  }
                }
                return;
              }
              currentNode = currentNode.getParent();
            }
          } catch (e) {
            // Node might not be attached
          }
        }
      }
    });
  }, [onNavigationStateChange]);

  // Update groups whenever editor changes
  const updateGroups = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const groups = groupDiffChanges(editor);
    setChangeGroups(groups);

    // Update navigation state
    if (onNavigationStateChange) {
      onNavigationStateChange({
        currentIndex: groups.length > 0 ? currentGroupIndex : -1,
        totalGroups: groups.length,
        canGoPrevious: currentGroupIndex > 0,
        canGoNext: currentGroupIndex < groups.length - 1
      });
    }

    // Adjust current index if out of bounds
    setCurrentGroupIndex(prev => {
      if (groups.length === 0) return 0;
      if (prev >= groups.length) return Math.max(0, groups.length - 1);
      return prev;
    });
  }, [currentGroupIndex, onNavigationStateChange]);

  // Apply/remove highlighting based on current group
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || changeGroups.length === 0) return;

    // Remove old highlights
    const removeHighlights = () => {
      editor.update(() => {
        const root = editor.getRootElement();
        if (!root) return;

        root.querySelectorAll(`.${HIGHLIGHT_CLASS_REMOVED}`).forEach(el =>
          el.classList.remove(HIGHLIGHT_CLASS_REMOVED));
        root.querySelectorAll(`.${HIGHLIGHT_CLASS_ADDED}`).forEach(el =>
          el.classList.remove(HIGHLIGHT_CLASS_ADDED));
        root.querySelectorAll(`.${HIGHLIGHT_CLASS_MODIFIED}`).forEach(el =>
          el.classList.remove(HIGHLIGHT_CLASS_MODIFIED));
      });
    };

    // Add highlight to current group
    const addHighlight = () => {
      if (currentGroupIndex < 0 || currentGroupIndex >= changeGroups.length) return;

      const currentGroup = changeGroups[currentGroupIndex];

      // Collect node keys and their diff states
      const nodeInfo: Array<{ key: string; highlightClass: string }> = [];

      editor.getEditorState().read(() => {
        for (const node of currentGroup.nodes) {
          try {
            const nodeType = node.getType();
            const diffState = $getDiffState(node);

            let highlightClass = HIGHLIGHT_CLASS_MODIFIED;
            if (diffState === 'removed' || nodeType === 'remove') {
              highlightClass = HIGHLIGHT_CLASS_REMOVED;
            } else if (diffState === 'added' || nodeType === 'add') {
              highlightClass = HIGHLIGHT_CLASS_ADDED;
            }

            nodeInfo.push({
              key: node.getKey(),
              highlightClass,
            });
          } catch (e) {
            // Node might not be attached anymore
          }
        }
      });

      // Apply highlights to DOM elements
      editor.update(() => {
        for (const info of nodeInfo) {
          try {
            const element = editor.getElementByKey(info.key);
            if (element) {
              element.classList.add(info.highlightClass);
            }
          } catch (e) {
            // Element might not exist
          }
        }
      });
    };

    removeHighlights();
    addHighlight();

    return () => {
      removeHighlights();
    };
  }, [changeGroups, currentGroupIndex]);

  // Listen for editor updates and clicks
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const removeUpdateListener = editor.registerUpdateListener(() => {
      updateGroups();
    });

    // Add click listener to detect when user selects a diff node
    const rootElement = editor.getRootElement();
    if (rootElement) {
      rootElement.addEventListener('click', handleEditorClick);
    }

    return () => {
      removeUpdateListener();
      if (rootElement) {
        rootElement.removeEventListener('click', handleEditorClick);
      }
    };
  }, [updateGroups, handleEditorClick]);

  // Handle navigation callbacks from parent
  useEffect(() => {
    if (!onNavigatePrevious || !onNavigateNext) return;

    // Store navigation handlers on window so parent can call them
    (window as any).__richDiffNavigatePrevious = () => {
      const currentIndex = currentGroupIndexRef.current;
      const groups = changeGroupsRef.current;

      if (currentIndex > 0) {
        const newIndex = currentIndex - 1;
        setCurrentGroupIndex(newIndex);

        if (editorRef.current && groups.length > 0) {
          scrollToChangeGroup(editorRef.current, newIndex, groups);
        }

        // Update parent state immediately
        if (onNavigationStateChange) {
          onNavigationStateChange({
            currentIndex: newIndex,
            totalGroups: groups.length,
            canGoPrevious: newIndex > 0,
            canGoNext: newIndex < groups.length - 1
          });
        }
      }
    };

    (window as any).__richDiffNavigateNext = () => {
      const currentIndex = currentGroupIndexRef.current;
      const groups = changeGroupsRef.current;

      if (currentIndex < groups.length - 1) {
        const newIndex = currentIndex + 1;
        setCurrentGroupIndex(newIndex);

        if (editorRef.current && groups.length > 0) {
          scrollToChangeGroup(editorRef.current, newIndex, groups);
        }

        // Update parent state immediately
        if (onNavigationStateChange) {
          onNavigationStateChange({
            currentIndex: newIndex,
            totalGroups: groups.length,
            canGoPrevious: newIndex > 0,
            canGoNext: newIndex < groups.length - 1
          });
        }
      }
    };
  }, [onNavigatePrevious, onNavigateNext, onNavigationStateChange]);

  const handleEditorReady = (editor: LexicalEditor) => {
    editorRef.current = editor;

    if (appliedRef.current) return;
    appliedRef.current = true;

    // Check if markdown is actually different
    if (oldMarkdown === newMarkdown) {
      setIsReady(true);
      return;
    }

    // Wait for DiffPlugin to register its command handler
    // We need to wait for React to complete the render cycle and run all useEffect hooks
    // Use multiple animation frames to ensure all plugins have initialized
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // console.log('[DiffPreviewEditor] Applying diff:', {
          //   oldLength: oldMarkdown.length,
          //   newLength: newMarkdown.length,
          //   oldStart: oldMarkdown.substring(0, 100),
          //   newStart: newMarkdown.substring(0, 100),
          // });

          // Don't pass oldText - let the command handler extract it from the editor
          // This handles normalization differences (tables, spacing, etc.)
          // oldText is optional - the command handler will extract it from the editor
          const replacements = [{ newText: newMarkdown }] as any;

          try {
            // LiveNodeKeyState is set automatically by applyMarkdownReplace via parallel traversal
            const result = editor.dispatchCommand(APPLY_MARKDOWN_REPLACE_COMMAND, replacements);

            if (!result) {
              console.error('[DiffPreviewEditor] Failed to apply diff - command not handled');
            }

            // Show the editor after diff is applied
            requestAnimationFrame(() => {
              setIsReady(true);
              // Initial groups update after diff is applied
              updateGroups();
            });
          } catch (error) {
            console.error('[DiffPreviewEditor] Failed to apply diff in preview:', error);
            setIsReady(true); // Show anyway if there's an error
          }
        });
      });
    });
  };

  const isDarkTheme = theme === 'dark' || theme === 'crystal-dark';

  return (
    <div className={`diff-preview-editor w-full h-full flex flex-col ${!isReady ? 'opacity-0' : ''}`}>
      <div className="diff-preview-editor-container flex-1 flex flex-col overflow-auto transition-opacity duration-150">
        <NimbalystEditor
          config={{
            initialContent: oldMarkdown,
            isRichText: true,
            editable: false,
            onEditorReady: handleEditorReady,
            theme: theme,
          }}
        />
      </div>
    </div>
  );
}
