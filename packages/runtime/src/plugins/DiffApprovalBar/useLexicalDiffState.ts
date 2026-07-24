/**
 * useLexicalDiffState hook
 *
 * Exposes Lexical diff state and operations for use with UnifiedDiffHeader.
 * This hook encapsulates all the diff management logic that was previously
 * part of DiffApprovalBar.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import type { LexicalEditor } from 'lexical';
import { $getSelection, $isRangeSelection } from 'lexical';
import {
  APPROVE_DIFF_COMMAND,
  REJECT_DIFF_COMMAND,
  CLEAR_DIFF_TAG_COMMAND,
  INCREMENTAL_APPROVAL_COMMAND,
  $approveChangeGroup,
  $rejectChangeGroup,
  groupDiffChanges,
  scrollToChangeGroup,
  type DiffChangeGroup,
  $getDiffState,
  $hasDiffNodes
} from '../../editor';

const HIGHLIGHT_CLASS_REMOVED = 'diff-group-highlight-removed';
const HIGHLIGHT_CLASS_ADDED = 'diff-group-highlight-added';
const HIGHLIGHT_CLASS_MODIFIED = 'diff-group-highlight-modified';

export interface LexicalDiffState {
  /** Whether there are any diff nodes in the editor */
  hasDiffs: boolean;
  /** Total number of change groups */
  changeGroupCount: number;
  /** Currently selected change group index (0-based), or null if none */
  currentGroupIndex: number | null;
  /** Navigate to previous change group */
  navigatePrevious: () => void;
  /** Navigate to next change group */
  navigateNext: () => void;
  /** Accept all changes */
  acceptAll: () => void;
  /** Reject all changes */
  rejectAll: () => void;
  /** Accept the currently selected change group */
  acceptCurrent: () => void;
  /** Reject the currently selected change group */
  rejectCurrent: () => void;
}

export function useLexicalDiffState(editor: LexicalEditor | undefined): LexicalDiffState {
  const [changeGroups, setChangeGroups] = useState<DiffChangeGroup[]>([]);
  const [currentGroupIndex, setCurrentGroupIndex] = useState(-1);
  const isNavigatingRef = useRef(false);

  // Update groups whenever editor changes
  const updateGroups = useCallback(() => {
    if (!editor) return;

    // Guard against non-Lexical editors (e.g., Monaco editor passed by mistake during view mode switch)
    if (typeof editor.getEditorState !== 'function') return;

    const groups = groupDiffChanges(editor);
    setChangeGroups(groups);

    setCurrentGroupIndex(prev => {
      if (groups.length === 0) {
        return -1;
      }
      if (prev >= groups.length) {
        return Math.max(0, groups.length - 1);
      }
      if (prev === -1 && groups.length > 0) {
        return 0;
      }
      return prev;
    });
  }, [editor]);

  // Apply/remove highlighting based on current group
  useEffect(() => {
    if (!editor || changeGroups.length === 0) return;

    // Guard against non-Lexical editors
    if (typeof editor.getEditorState !== 'function') return;

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

    const addHighlight = () => {
      if (currentGroupIndex < 0 || currentGroupIndex >= changeGroups.length) return;

      const currentGroup = changeGroups[currentGroupIndex];
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
  }, [editor, changeGroups, currentGroupIndex]);

  // Listen for editor updates
  useEffect(() => {
    if (!editor) return;

    // Guard against non-Lexical editors
    if (typeof editor.registerUpdateListener !== 'function') return;

    updateGroups();

    const removeUpdateListener = editor.registerUpdateListener(() => {
      updateGroups();
    });

    return () => {
      removeUpdateListener();
    };
  }, [editor, updateGroups]);

  // Selection detection to update current group
  useEffect(() => {
    if (!editor || changeGroups.length === 0) return;

    // Guard against non-Lexical editors
    if (typeof editor.getEditorState !== 'function') return;

    const handleSelectionChange = () => {
      if (isNavigatingRef.current) return;

      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return;
        }

        const selectedNodes = selection.getNodes();

        let foundGroupIndex = -1;
        for (let i = 0; i < changeGroups.length; i++) {
          const group = changeGroups[i];

          for (const selectedNode of selectedNodes) {
            for (const groupNode of group.nodes) {
              if (selectedNode.getKey() === groupNode.getKey()) {
                foundGroupIndex = i;
                break;
              }

              let parent = selectedNode.getParent();
              while (parent) {
                if (parent.getKey() === groupNode.getKey()) {
                  foundGroupIndex = i;
                  break;
                }
                parent = parent.getParent();
              }

              if (foundGroupIndex !== -1) break;
            }
            if (foundGroupIndex !== -1) break;
          }
          if (foundGroupIndex !== -1) break;
        }

        if (foundGroupIndex !== -1) {
          setCurrentGroupIndex(foundGroupIndex);
        }
      });
    };

    const removeSelectionListener = editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        handleSelectionChange();
      });
    });

    handleSelectionChange();

    return () => {
      removeSelectionListener();
    };
  }, [editor, changeGroups]);

  const navigatePrevious = useCallback(() => {
    if (!editor || changeGroups.length === 0) return;

    const newIndex = currentGroupIndex <= 0 ? 0 : currentGroupIndex - 1;
    const targetGroup = changeGroups[newIndex];

    isNavigatingRef.current = true;
    setCurrentGroupIndex(newIndex);
    scrollToChangeGroup(editor, newIndex, changeGroups);

    editor.update(() => {
      try {
        for (const node of targetGroup.nodes) {
          try {
            node.selectStart();
            break;
          } catch (e) {
            continue;
          }
        }
      } catch (e) {
        console.warn('Failed to move selection to previous group:', e);
      }
    });

    setTimeout(() => {
      isNavigatingRef.current = false;
    }, 100);
  }, [editor, changeGroups, currentGroupIndex]);

  const navigateNext = useCallback(() => {
    if (!editor || changeGroups.length === 0) return;

    const newIndex = currentGroupIndex >= changeGroups.length - 1
      ? changeGroups.length - 1
      : currentGroupIndex + 1;

    const targetGroup = changeGroups[newIndex];

    isNavigatingRef.current = true;
    setCurrentGroupIndex(newIndex);
    scrollToChangeGroup(editor, newIndex, changeGroups);

    editor.update(() => {
      try {
        for (const node of targetGroup.nodes) {
          try {
            node.selectStart();
            break;
          } catch (e) {
            continue;
          }
        }
      } catch (e) {
        console.warn('Failed to move selection to next group:', e);
      }
    });

    setTimeout(() => {
      isNavigatingRef.current = false;
    }, 100);
  }, [editor, changeGroups, currentGroupIndex]);

  const acceptAll = useCallback(() => {
    if (editor) {
      editor.dispatchCommand(APPROVE_DIFF_COMMAND, undefined);
    }
  }, [editor]);

  const rejectAll = useCallback(() => {
    if (editor) {
      editor.dispatchCommand(REJECT_DIFF_COMMAND, undefined);
    }
  }, [editor]);

  const acceptCurrent = useCallback(() => {
    if (!editor || currentGroupIndex < 0 || currentGroupIndex >= changeGroups.length) return;

    const indexBeforeApproval = currentGroupIndex;
    const currentGroup = changeGroups[indexBeforeApproval];

    $approveChangeGroup(editor, currentGroup.nodes);

    setTimeout(() => {
      const updatedGroups = groupDiffChanges(editor);
      const hasDiff = $hasDiffNodes(editor);

      if (updatedGroups.length === 0 || !hasDiff) {
        editor.dispatchCommand(CLEAR_DIFF_TAG_COMMAND, undefined);
        return;
      }

      editor.dispatchCommand(INCREMENTAL_APPROVAL_COMMAND, undefined);

      const newIndex = Math.min(indexBeforeApproval, updatedGroups.length - 1);
      const nextGroup = updatedGroups[newIndex];

      editor.update(() => {
        try {
          for (const node of nextGroup.nodes) {
            try {
              node.selectStart();
              break;
            } catch (e) {
              continue;
            }
          }
        } catch (e) {
          console.warn('Failed to move selection to next group:', e);
        }
      });
    }, 100);
  }, [editor, changeGroups, currentGroupIndex]);

  const rejectCurrent = useCallback(() => {
    if (!editor || currentGroupIndex < 0 || currentGroupIndex >= changeGroups.length) return;

    const indexBeforeRejection = currentGroupIndex;
    const currentGroup = changeGroups[indexBeforeRejection];

    $rejectChangeGroup(editor, currentGroup.nodes);

    setTimeout(() => {
      const updatedGroups = groupDiffChanges(editor);
      const hasDiff = $hasDiffNodes(editor);

      if (updatedGroups.length === 0 || !hasDiff) {
        editor.dispatchCommand(CLEAR_DIFF_TAG_COMMAND, undefined);
        return;
      }

      editor.dispatchCommand(INCREMENTAL_APPROVAL_COMMAND, undefined);

      const newIndex = Math.min(indexBeforeRejection, updatedGroups.length - 1);
      const nextGroup = updatedGroups[newIndex];

      editor.update(() => {
        try {
          for (const node of nextGroup.nodes) {
            try {
              node.selectStart();
              break;
            } catch (e) {
              continue;
            }
          }
        } catch (e) {
          console.warn('Failed to move selection to next group:', e);
        }
      });
    }, 100);
  }, [editor, changeGroups, currentGroupIndex]);

  return {
    hasDiffs: changeGroups.length > 0,
    changeGroupCount: changeGroups.length,
    currentGroupIndex: currentGroupIndex >= 0 ? currentGroupIndex : null,
    navigatePrevious,
    navigateNext,
    acceptAll,
    rejectAll,
    acceptCurrent,
    rejectCurrent,
  };
}
