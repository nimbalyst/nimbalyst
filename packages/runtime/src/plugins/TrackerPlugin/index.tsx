/**
 * TrackerPlugin - Unified tracker system for inline and full-document tracking
 *
 * This plugin provides:
 * - Full-document tracking via document headers (replaces PlanStatusPlugin/DecisionStatusPlugin)
 * - Inline tracker items using # syntax
 * - Data-model driven UI components
 * - Unified storage in JSONB
 */

import type { JSX } from 'react';
import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  LexicalCommand,
  LexicalEditor,
  $insertNodes,
  $getNodeByKey,
  TextNode,
  LexicalNode,
  KEY_ENTER_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_HIGH,
  CONTROLLED_TEXT_INSERTION_COMMAND,
} from 'lexical';
import { $isListItemNode, $createListItemNode } from '@lexical/list';
import { useEffect as useReactEffect } from 'react';
import { useAtomValue } from 'jotai';
import { $createTrackerItemNode, $getTrackerItemNode, $isTrackerItemNode, TrackerItemData, TrackerItemType, TrackerItemNode, TrackerItemStatus, TrackerItemPriority } from './TrackerItemNode';
import { TRACKER_ITEM_TRANSFORMERS } from './TrackerItemTransformer';
import { defineExtension } from 'lexical';
import { TypeaheadMenuPlugin, type TypeaheadMenuOption, type UserCommand, $convertToEnhancedMarkdownString, getEditorTransformers } from '../../editor';
import { globalRegistry } from './models';
import { trackerItemsArrayAtom } from './trackerDataAtoms';
import { buildTrackerReferenceOptions, parseTypeScopedQuery, matchTrackerReferenceTrigger, $insertTrackerReference } from '../TrackerLinkPlugin/trackerReferencePicker';
import { $createTrackerReferenceNode } from '../TrackerLinkPlugin/TrackerReferenceNode';
import { DocumentHeaderRegistry } from './documentHeader/DocumentHeaderRegistry';
import { TrackerDocumentHeader, shouldRenderTrackerHeader } from './documentHeader/TrackerDocumentHeader';
import { updateTrackerInFrontmatter } from './documentHeader/frontmatterUtils';
import { generateTrackerId } from './models/IDGenerator';
import { formatLocalDateOnly } from './models/dateUtils';
import { $isHeadingNode } from '@lexical/rich-text';
import { $getRoot } from 'lexical';
import './TrackerItem.css';

interface TrackerEditorState {
  nodeKey: string;
  data: TrackerItemData;
  position: { x: number; y: number };
}

type TriggerFunction = (text: string, editor: LexicalEditor) => {
  leadOffset: number;
  matchingString: string;
  replaceableString: string;
} | null;

// Register document header provider at module load time (not in component mount)
// This ensures the provider is available before DocumentHeaderContainer tries to query it
DocumentHeaderRegistry.register({
  id: 'tracker-document-header',
  priority: 100,
  shouldRender: shouldRenderTrackerHeader,
  component: TrackerDocumentHeader,
});

export const INSERT_TRACKER_TASK_COMMAND: LexicalCommand<void> = createCommand();
export const INSERT_TRACKER_BUG_COMMAND: LexicalCommand<void> = createCommand();
export const INSERT_TRACKER_PLAN_COMMAND: LexicalCommand<void> = createCommand();
export const INSERT_TRACKER_IDEA_COMMAND: LexicalCommand<void> = createCommand();
export const CONVERT_TO_PLAN_COMMAND: LexicalCommand<void> = createCommand();
export const CONVERT_TO_DECISION_COMMAND: LexicalCommand<void> = createCommand();

// Helper function to generate a ULID-style ID
function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}${random}`;
}

function insertTrackerItemNode(editor: LexicalEditor, type: TrackerItemType, existingText?: string): void {
  editor.update(() => {
    const selection = $getSelection();

    const title = existingText || `New ${type}`;

    // Generate ID prefix based on type
    let prefix = 'tsk';
    if (type === 'bug') prefix = 'bug';
    else if (type === 'plan') prefix = 'pln';
    else if (type === 'idea') prefix = 'ida';
    else if (type === 'decision') prefix = 'dec';
    else if (type === 'automation') prefix = 'aut';

    const itemData: TrackerItemData = {
      id: generateId(prefix),
      type,
      title,
      status: 'to-do',
      priority: 'medium',
      created: new Date().toISOString().split('T')[0],
    };

    const trackerItemNode = $createTrackerItemNode(itemData);

    // Add text content as children
    const textNode = $createTextNode(title);
    trackerItemNode.append(textNode);

    if ($isRangeSelection(selection)) {
      $insertNodes([trackerItemNode]);
      const nextParagraph = $createParagraphNode();
      trackerItemNode.insertAfter(nextParagraph);
      nextParagraph.select();
    } else {
      $insertNodes([trackerItemNode]);
      const nextParagraph = $createParagraphNode();
      trackerItemNode.insertAfter(nextParagraph);
      nextParagraph.select();
    }
  });
}

/**
 * Extract the first heading or a default title from the document
 */
function extractDocumentTitle(editor: LexicalEditor): string {
  let title = 'Untitled';

  editor.getEditorState().read(() => {
    const root = $getRoot();
    const children = root.getChildren();

    // Look for the first heading
    for (const child of children) {
      if ($isHeadingNode(child)) {
        title = child.getTextContent().trim();
        break;
      }
    }
  });

  return title || 'Untitled';
}

/**
 * Remove command text (starting with /) from the current selection/paragraph
 */
function removeCommandText(editor: LexicalEditor): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;

    const anchorNode = selection.anchor.getNode();
    const textContent = anchorNode.getTextContent();

    // Check if this node contains command text (starts with /)
    const match = textContent.match(/^\/[a-zA-Z]*/);
    if (match) {
      // Remove the command text
      const commandLength = match[0].length;
      if (anchorNode instanceof TextNode) {
        const newText = textContent.slice(commandLength).trimStart();
        anchorNode.setTextContent(newText);

        // Move selection to start
        if (newText.length === 0) {
          selection.removeText();
        }
      }
    }
  });
}

/**
 * Convert document to a plan by adding plan frontmatter
 */
async function convertToPlan(editor: LexicalEditor, onContentChange?: (content: string) => void): Promise<void> {
  if (!onContentChange) {
    console.warn('[TrackerPlugin] Cannot convert to plan: no content change handler');
    return;
  }

  // Remove any command text first
  removeCommandText(editor);

  // Extract title and get current content as markdown
  const title = extractDocumentTitle(editor);
  const planId = generateTrackerId('plan');
  const now = new Date();

  const planData = {
    planId,
    title,
    status: 'draft',
    planType: 'feature',
    priority: 'medium',
    progress: 0,
    created: now.toISOString().split('T')[0],
    updated: formatLocalDateOnly(now),
    owner: '',
    stakeholders: [],
    tags: [],
  };

  // Get current content as markdown (proper export)

  editor.getEditorState().read(() => {
    try {
      const transformers = getEditorTransformers();
      const markdownContent = $convertToEnhancedMarkdownString(transformers, { includeFrontmatter: false });
      const updatedContent = updateTrackerInFrontmatter('', 'plan', planData);
      const finalContent = updatedContent + '\n' + markdownContent;
      onContentChange(finalContent);
    } catch (error) {
      console.error('[TrackerPlugin] Failed to convert to plan:', error);
    }
  });
}

/**
 * Convert document to a decision by adding decision frontmatter
 */
async function convertToDecision(editor: LexicalEditor, onContentChange?: (content: string) => void): Promise<void> {
  if (!onContentChange) {
    console.warn('[TrackerPlugin] Cannot convert to decision: no content change handler');
    return;
  }

  // Remove any command text first
  removeCommandText(editor);

  // Extract title and get current content as markdown
  const title = extractDocumentTitle(editor);
  const decisionId = generateTrackerId('decision');
  const now = new Date();

  const decisionData = {
    decisionId,
    title,
    status: 'to-do',
    priority: 'medium',
    created: now.toISOString().split('T')[0],
    updated: formatLocalDateOnly(now),
    owner: '',
    stakeholders: [],
    tags: [],
    chosen: '',
  };

  // Get current content as markdown (proper export)

  editor.getEditorState().read(() => {
    try {
      const transformers = getEditorTransformers();
      const markdownContent = $convertToEnhancedMarkdownString(transformers, { includeFrontmatter: false });
      const updatedContent = updateTrackerInFrontmatter('', 'decision', decisionData);
      const finalContent = updatedContent + '\n' + markdownContent;
      onContentChange(finalContent);
    } catch (error) {
      console.error('[TrackerPlugin] Failed to convert to decision:', error);
    }
  });
}

export interface TrackerPluginProps {}

function TrackerPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const [editorState, setEditorState] = useState<TrackerEditorState | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Live tracker records for the `#` reference picker (V2). Reads the canonical
  // runtime store so the menu lists existing items to *reference*.
  const trackerItems = useAtomValue(trackerItemsArrayAtom);


  // Use node transform to enforce tracker always has at least a space
  useReactEffect(() => {
    return editor.registerNodeTransform(TrackerItemNode, (node) => {
      const children = node.getChildren();

      // If no children, add a space
      if (children.length === 0) {
        const spaceNode = $createTextNode(' ');
        node.append(spaceNode);
        spaceNode.selectStart();
        return;
      }

      // If we have a single text child that's empty, replace with space
      if (children.length === 1 && $isTextNode(children[0])) {
        const textNode = children[0];
        const text = textNode.getTextContent();

        if (text === '') {
          textNode.setTextContent(' ');
        }
      }
    });
  }, [editor]);

  // Handle text insertion to trim leading space when typing
  useReactEffect(() => {
    return editor.registerCommand(
      CONTROLLED_TEXT_INSERTION_COMMAND,
      (text: string | InputEvent) => {
        if (typeof text !== 'string') return false;
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();

        // Find if we're inside a tracker item
        let trackerNode: TrackerItemNode | null = null;
        let node: LexicalNode | null = anchorNode;
        while (node) {
          if ($isTrackerItemNode(node)) {
            trackerNode = node;
            break;
          }
          node = node.getParent();
        }

        if (!trackerNode) {
          return false;
        }

        // If tracker only has a space, replace it with the typed text
        const textContent = trackerNode.getTextContent();
        if (textContent === ' ') {
          const children = trackerNode.getChildren();
          if (children.length === 1 && $isTextNode(children[0])) {
            const textNode = children[0] as any;
            textNode.setTextContent(text);
            textNode.select(text.length, text.length);
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  // Handle Enter key in tracker items
  useReactEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();

        // Find if we're inside a tracker item
        let trackerNode: TrackerItemNode | null = null;
        let node: LexicalNode | null = anchorNode;
        while (node) {
          if ($isTrackerItemNode(node)) {
            trackerNode = node;
            break;
          }
          node = node.getParent();
        }

        if (!trackerNode) {
          return false;
        }

        // Check if we're at the end of the tracker content
        const textContent = trackerNode.getTextContent();
        const offset = selection.anchor.offset;
        const isAtEnd = offset >= textContent.length;
        const onlyWhitespaceAfter = /^\s*$/.test(textContent.slice(offset));

        // only continue if selection is at the end or if there's only whitespace after the cursor
        if (!isAtEnd && !onlyWhitespaceAfter) {
          return false;
        }

        // Find the list item containing this tracker
        let listItem: LexicalNode | null = trackerNode;
        while (listItem) {
          if ($isListItemNode(listItem)) {
            break;
          }
          listItem = listItem.getParent();
        }

        if (!listItem || !$isListItemNode(listItem)) {
          return false;
        }

        // Create a new list item after this one
        event?.preventDefault();
        editor.update(() => {
          const newListItem = $createListItemNode();
          // newListItem.append(paragraph);
          listItem!.insertAfter(newListItem);
          newListItem.select();
        });

        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor]);

  // Register inline tracker commands
  useReactEffect(() => {
    return editor.registerCommand(
      INSERT_TRACKER_TASK_COMMAND,
      () => {
        insertTrackerItemNode(editor, 'task');
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor]);

  useReactEffect(() => {
    return editor.registerCommand(
      INSERT_TRACKER_BUG_COMMAND,
      () => {
        insertTrackerItemNode(editor, 'bug');
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor]);

  useReactEffect(() => {
    return editor.registerCommand(
      INSERT_TRACKER_PLAN_COMMAND,
      () => {
        insertTrackerItemNode(editor, 'plan');
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor]);

  useReactEffect(() => {
    return editor.registerCommand(
      INSERT_TRACKER_IDEA_COMMAND,
      () => {
        insertTrackerItemNode(editor, 'idea');
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor]);

  // Register document conversion commands
  useReactEffect(() => {
    return editor.registerCommand(
      CONVERT_TO_PLAN_COMMAND,
      () => {
        // Get onContentChange from window if available (set by DocumentHeaderContainer)
        const onContentChange = (window as any).__documentContentChangeHandler;
        convertToPlan(editor, onContentChange).catch(error => {
          console.error('[TrackerPlugin] Failed to convert to plan:', error);
        });
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor]);

  useReactEffect(() => {
    return editor.registerCommand(
      CONVERT_TO_DECISION_COMMAND,
      () => {
        // Get onContentChange from window if available (set by DocumentHeaderContainer)
        const onContentChange = (window as any).__documentContentChangeHandler;
        convertToDecision(editor, onContentChange).catch(error => {
          console.error('[TrackerPlugin] Failed to convert to decision:', error);
        });
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor]);


  // Handle tracker-item-toggle and tracker-item-edit events
  useReactEffect(() => {
    const handleToggle = (event: any) => {
      const { nodeKey, checked } = event.detail;
      editor.update(() => {
        const node = $getTrackerItemNode(nodeKey);
        if (node) {
          const data = node.getData();
          node.setData({
            ...data,
            status: checked ? 'done' : 'to-do',
            updated: formatLocalDateOnly(new Date()),
          });
        }
      });
    };

    const handleEdit = (event: any) => {
      const { nodeKey, data, target } = event.detail;
      const rect = target.getBoundingClientRect();

      // Estimate popover height (adjust based on content)
      const popoverHeight = 450;
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;

      // Position above if not enough space below
      let yPosition: number;
      if (spaceBelow < popoverHeight && spaceAbove > spaceBelow) {
        // Position above the target
        yPosition = rect.top - popoverHeight - 8;
      } else {
        // Position below the target (default)
        yPosition = rect.bottom + 8;
      }

      setEditorState({
        nodeKey,
        data,
        position: { x: rect.left, y: yPosition },
      });
    };

    window.addEventListener('tracker-item-toggle', handleToggle);
    window.addEventListener('tracker-item-edit', handleEdit);

    return () => {
      window.removeEventListener('tracker-item-toggle', handleToggle);
      window.removeEventListener('tracker-item-edit', handleEdit);
    };
  }, [editor]);

  // Click outside to close popover
  useReactEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setEditorState(null);
      }
    };

    if (editorState) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
    return undefined;
  }, [editorState]);

  // Update tracker data
  const updateTrackerData = useCallback((nodeKey: string, updates: Partial<TrackerItemData>) => {
    editor.update(() => {
      const node = $getTrackerItemNode(nodeKey);
      if (node) {
        const data = node.getData();
        node.setData({
          ...data,
          ...updates,
          updated: formatLocalDateOnly(new Date()),
        });
      }
    });
  }, [editor]);

  // Convert a legacy frozen inline tracker (TrackerItemNode) into a real,
  // tracked item plus a live reference chip. Creation of the real item is
  // delegated to the host via a window hook (set by the renderer in App.tsx),
  // matching the platform-decoupling seam used elsewhere in this plugin
  // (e.g. `__documentContentChangeHandler`). On success, the inline node is
  // replaced in-place by a `TrackerReferenceNode` pointing at the new item.
  const [converting, setConverting] = useState(false);
  const handleConvertToReference = useCallback(async (nodeKey: string, data: TrackerItemData) => {
    const createFn = (window as any).__nimbalystCreateTrackerItem as
      | ((item: {
          type: string;
          title: string;
          status?: string;
          priority?: string;
          description?: string;
          owner?: string;
          tags?: string[];
        }) => Promise<{ id: string; issueKey?: string } | null>)
      | undefined;

    if (typeof createFn !== 'function') {
      console.warn('[TrackerPlugin] Cannot convert inline tracker: no host creation hook');
      return;
    }

    setConverting(true);
    try {
      const created = await createFn({
        type: data.type,
        title: data.title,
        status: data.status,
        priority: data.priority,
        description: data.description,
        owner: data.owner,
        tags: data.tags,
      });
      if (!created) {
        console.warn('[TrackerPlugin] Convert: host did not create an item');
        return;
      }

      const referenceKey = created.issueKey || created.id;
      editor.update(() => {
        const node = $getTrackerItemNode(nodeKey);
        if (node) {
          const ref = $createTrackerReferenceNode(referenceKey);
          node.replace(ref);
          const trailing = $createTextNode(' ');
          ref.insertAfter(trailing);
          trailing.select();
        }
      });
      setEditorState(null);
    } catch (error) {
      console.error('[TrackerPlugin] Convert to reference failed:', error);
    } finally {
      setConverting(false);
    }
  }, [editor]);

  // Typeahead trigger function.
  //
  // The document editor runs Lexical's HashtagPlugin, so typing `#bug` becomes a
  // HashtagNode and any following `-` (issue keys) or `:` (the `type:` scope)
  // spills into a SEPARATE sibling text node. The shared `getTextUpToAnchor`
  // only reads the anchor node, so it would miss the `#` and close the menu the
  // instant you type `-`/`:`. We instead accumulate text backwards across
  // same-level siblings up to the caret so the `#…` trigger is seen whole.
  const trackerTriggerFn: TriggerFunction = useCallback((_text: string, editor: LexicalEditor) => {
    let result: { leadOffset: number; matchingString: string; replaceableString: string } | null = null;

    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;

      const anchor = selection.anchor;
      if (anchor.type !== 'text') return;

      const anchorNode = anchor.getNode();
      const anchorOffset = anchor.offset;

      const anchorUpToCaret = anchorNode.getTextContent().slice(0, anchorOffset);
      let acc = anchorUpToCaret;
      let prev: LexicalNode | null = anchorNode.getPreviousSibling();
      while (prev) {
        acc = prev.getTextContent() + acc;
        prev = prev.getPreviousSibling();
      }

      const match = matchTrackerReferenceTrigger(acc);
      if (!match) return;

      // leadOffset is a DOM offset within the anchor node; clamp the matched
      // span to the part that actually lives in the anchor node (the rest is in
      // the preceding hashtag/sibling node).
      const inAnchor = Math.min(match.replaceableString.length, anchorUpToCaret.length);
      result = {
        leadOffset: anchorOffset - inAnchor,
        matchingString: match.matchingString,
        replaceableString: match.replaceableString,
      };
    });

    return result;
  }, []);

  // Set of known tracker types (registered models + types present in the data)
  // used to recognize a `type:` scope prefix in the query.
  const knownTrackerTypes = useMemo(() => {
    const set = new Set<string>();
    for (const model of globalRegistry.getAll()) set.add(model.type.toLowerCase());
    for (const item of trackerItems) {
      if (item.primaryType) set.add(item.primaryType.toLowerCase());
      for (const tag of item.typeTags ?? []) set.add(tag.toLowerCase());
    }
    return set;
  }, [trackerItems]);

  // A leading `type:` prefix (e.g. `#bug:login`) scopes the picker to that type.
  const { typeFilter, searchQuery } = parseTypeScopedQuery(query, knownTrackerTypes);

  // Typeahead options (V2) — search EXISTING tracker items to reference.
  // Selecting one inserts a TrackerReferenceNode pointer (live chip), instead
  // of creating a frozen inline TrackerItemNode. The icon comes from the item's
  // registered tracker model; `option.id` carries the reference key to insert.
  const referenceOptions = buildTrackerReferenceOptions(trackerItems, searchQuery, { typeFilter });

  const filteredOptions: TypeaheadMenuOption[] = referenceOptions.map((item) => {
    const model = globalRegistry.get(item.type);
    const icon = model?.icon ?? 'sell';
    const keyLabel = item.issueKey ?? item.referenceKey;
    const meta = [keyLabel, item.type, item.status].filter(Boolean).join(' · ');
    return {
      id: item.referenceKey,
      label: item.title || keyLabel,
      description: meta,
      icon: <span className="material-symbols-outlined">{icon}</span>,
      keywords: [item.referenceKey, keyLabel, item.title, item.type].filter(Boolean) as string[],
      onSelect: () => {}, // Required by TypeaheadMenuOption but handled in handleSelectOption
    };
  });

  // When the user has typed a query that matches nothing, show a disabled hint
  // rather than an empty floating box.
  const noMatchLabel = typeFilter
    ? (searchQuery ? `No ${typeFilter} items match “${searchQuery}”` : `No ${typeFilter} items`)
    : (searchQuery ? `No tracker items match “${searchQuery}”` : 'No tracker items yet');
  const menuOptions: TypeaheadMenuOption[] = filteredOptions.length > 0
    ? filteredOptions
    : [{
        id: '__no-tracker-matches__',
        label: noMatchLabel,
        onSelect: () => {},
        disabled: true,
      }];

  // Small header confirming an active type scope.
  const typeaheadHeader = typeFilter ? (
    <div className="tracker-typeahead-filter-hint">
      <span className="material-symbols-outlined">filter_list</span>
      Filtering by type: <strong>{typeFilter}</strong>
    </div>
  ) : undefined;

  const handleSelectOption = useCallback(
    (option: TypeaheadMenuOption, _textNode: TextNode | null, closeMenu: () => void, matchingString: string) => {
      // The "no matches" hint is non-actionable.
      if (option.disabled) {
        closeMenu();
        return;
      }

      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          // Remove the `#query` trigger text ourselves (TypeaheadMenuPlugin's
          // single-node split can't, because the trigger may span a HashtagNode
          // plus a sibling text node). Delete backward over `#` + the query.
          const removeCount = (matchingString?.length ?? 0) + 1; // +1 for '#'
          for (let i = 0; i < removeCount; i++) {
            selection.deleteCharacter(true);
          }
        }
        // option.id is the reference key (issue key or record id). Insert an
        // inline TrackerReferenceNode pointer at the caret.
        $insertTrackerReference(option.id);
      });
      closeMenu();
    },
    [editor],
  );

  // Get model config for the tracker type being edited
  const model = useMemo(() =>
    editorState ? globalRegistry.get(editorState.data.type) : null,
    [editorState?.data.type]
  );

  // Helper to render a field based on model definition
  const renderField = useCallback((field: any, fieldName: string) => {
    if (!editorState) return null;

    const value = (editorState.data as any)[fieldName] || '';
    const label = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);

    const handleChange = (newValue: any) => {
      updateTrackerData(editorState.nodeKey, { [fieldName]: newValue || undefined });
      setEditorState({ ...editorState, data: { ...editorState.data, [fieldName]: newValue || undefined } });
    };

    switch (field.type) {
      case 'text':
        return (
          <div key={fieldName} className="tracker-item-popover-field tracker-item-popover-description">
            <label>{label}</label>
            <textarea
              value={value}
              onChange={(e) => handleChange(e.target.value)}
              placeholder={`Add ${label.toLowerCase()}...`}
              rows={4}
            />
          </div>
        );

      case 'select':
        return (
          <div key={fieldName} className="tracker-item-popover-field">
            <label>{label}</label>
            <select
              value={value}
              onChange={(e) => handleChange(e.target.value)}
            >
              {!field.required && <option value="">None</option>}
              {field.options?.map((option: any) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        );

      default: // string, number, etc.
        return (
          <div key={fieldName} className="tracker-item-popover-field">
            <label>{label}</label>
            <input
              type={field.type === 'number' ? 'number' : 'text'}
              value={value}
              onChange={(e) => handleChange(e.target.value)}
              placeholder={`Enter ${label.toLowerCase()}...`}
            />
          </div>
        );
    }
  }, [editorState, updateTrackerData]);

  // Group fields for layout
  const fields = model?.fields || [];
  const titleFieldName = model?.roles?.title ?? 'title';
  const statusFieldName = model?.roles?.workflowStatus ?? 'status';
  const priorityFieldName = model?.roles?.priority ?? 'priority';
  const titleField = fields.find(f => f.name === titleFieldName);
  const statusField = fields.find(f => f.name === statusFieldName);
  const priorityField = fields.find(f => f.name === priorityFieldName);
  const otherFields = fields.filter(f =>
    f.name !== titleFieldName && f.name !== statusFieldName && f.name !== priorityFieldName
  );

  return (
    <>
      <TypeaheadMenuPlugin
        options={menuOptions}
        triggerFn={trackerTriggerFn}
        onQueryChange={setQuery}
        onSelectOption={handleSelectOption}
        header={typeaheadHeader}
        shouldSplitNodeWithQuery={false}
      />

      {editorState && model && (
        <div
          ref={popoverRef}
          className="tracker-item-popover"
          style={{
            position: 'fixed',
            left: `${editorState.position.x}px`,
            top: `${editorState.position.y}px`,
            zIndex: 10000,
          }}
        >
          <div className="tracker-item-popover-header">
            <span className="material-symbols-outlined">{model.icon}</span>
            <span>{model.displayName}</span>
          </div>

          {/* Title field - always first */}
          {titleField && (
            <div className="tracker-item-popover-field">
              <label>Title</label>
              <input
                type="text"
                value={editorState.data.title}
                onChange={(e) => {
                  updateTrackerData(editorState.nodeKey, { title: e.target.value });
                  setEditorState({ ...editorState, data: { ...editorState.data, title: e.target.value } });
                }}
                placeholder="Enter title"
              />
            </div>
          )}

          {/* Status and Priority in a row */}
          {(statusField || priorityField) && (
            <div className="tracker-item-popover-row">
              {statusField && renderField(statusField, 'status')}
              {priorityField && renderField(priorityField, 'priority')}
            </div>
          )}

          {/* Other fields */}
          {otherFields.map((field) => renderField(field, field.name))}

          {/* Convert a legacy frozen inline embed into a real tracked item +
              live reference chip. This retires the local-only snapshot in
              favor of the canonical synced item. */}
          <div className="tracker-item-popover-convert">
            <button
              type="button"
              className="tracker-item-convert-button"
              disabled={converting}
              onClick={() => handleConvertToReference(editorState.nodeKey, editorState.data)}
              title="Create a real tracked item from this inline note and replace it with a live reference chip"
            >
              <span className="material-symbols-outlined">sync_alt</span>
              {converting ? 'Converting…' : 'Convert to tracked reference'}
            </button>
          </div>

          <div className="tracker-item-popover-footer">
            <span className="tracker-item-date">Created: {editorState.data.created ? new Date(editorState.data.created).toLocaleString() : 'N/A'}</span>
            <span className="tracker-item-date">Updated: {editorState.data.updated ? new Date(editorState.data.updated).toLocaleString() : 'N/A'}</span>
            <span className="tracker-item-id">ID: {editorState.data.id}</span>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * React component exposed to the renderer so it can register through
 * `registerExtensionEditorComponent`.
 */
export { TrackerPlugin };

/**
 * Lexical extension that registers `TrackerItemNode`. The actual command
 * handlers and typeahead lifecycle live in the React component; this
 * extension is intentionally narrow because the renderer publishes it
 * via `setExtensionLexicalExtension('tracker', ...)`.
 */
export const TrackerLexicalExtension = defineExtension({
  name: '@nimbalyst/tracker',
  nodes: [TrackerItemNode],
});

/**
 * Slash-picker entries published into the extension contributions store
 * by the renderer-side `registerTrackerPlugin` call.
 */
export const TRACKER_USER_COMMANDS: ReadonlyArray<UserCommand> = [
    {
      title: 'Task Item',
      description: 'Add a task item to track work',
      icon: 'check_box',
      keywords: ['task', 'todo', 'item', 'tracker'],
      command: INSERT_TRACKER_TASK_COMMAND,
    },
    {
      title: 'Bug Item',
      description: 'Add a bug item to track issues',
      icon: 'bug_report',
      keywords: ['bug', 'issue', 'defect', 'tracker'],
      command: INSERT_TRACKER_BUG_COMMAND,
    },
    {
      title: 'Plan Item',
      description: 'Add a plan item to track features',
      icon: 'flag',
      keywords: ['plan', 'feature', 'tracker'],
      command: INSERT_TRACKER_PLAN_COMMAND,
    },
    {
      title: 'Idea Item',
      description: 'Add an idea item',
      icon: 'lightbulb',
      keywords: ['idea', 'suggestion', 'tracker'],
      command: INSERT_TRACKER_IDEA_COMMAND,
    },
    {
      title: 'Convert to Plan',
      description: 'Convert this document to a plan document',
      icon: 'flag',
      keywords: ['convert', 'plan', 'document'],
      command: CONVERT_TO_PLAN_COMMAND,
    },
    {
      title: 'Convert to Decision',
      description: 'Convert this document to a decision document',
      icon: 'gavel',
      keywords: ['convert', 'decision', 'document'],
      command: CONVERT_TO_DECISION_COMMAND,
    },
];

/**
 * Re-export the markdown transformers under a name that callers can use
 * without going through the legacy plugin-package shape.
 */
export { TRACKER_ITEM_TRANSFORMERS };

// Export document header system for external use
export { DocumentHeaderRegistry } from './documentHeader/DocumentHeaderRegistry';
export type { DocumentHeaderProvider, DocumentHeaderComponentProps } from './documentHeader/DocumentHeaderRegistry';
export { DocumentHeaderContainer } from './documentHeader/DocumentHeaderContainer';
export { TrackerDocumentHeader, shouldRenderTrackerHeader } from './documentHeader/TrackerDocumentHeader';

// Export data models
export { ModelLoader, loadBuiltinTrackers } from './models/ModelLoader';
export type { TrackerDataModel, FieldDefinition, TrackerSyncPolicy, TrackerSyncMode, TrackerSchemaRole } from './models/TrackerDataModel';
export { parseTrackerYAML } from './models/YAMLParser';
export { globalRegistry, getRoleField, getFieldByRole } from './models/TrackerDataModel';

// Export components
export { StatusBar } from './components/StatusBar';
export { TrackerTable, convertFullDocumentToTrackerItems, resolveTrackerFrontmatter, renderCell, ContextSubmenu } from './components/TrackerTable';
export type { SortColumn, SortDirection } from './components/TrackerTable';
export { TrackerTableGrid } from './components/TrackerTableGrid';
export { TrackerFavoriteStar } from './components/TrackerFavoriteStar';
export { useTrackerRows } from './components/useTrackerRows';
export type { UseTrackerRowsOptions, UseTrackerRowsResult, EditingCellRef, EditingField } from './components/useTrackerRows';
export { TrackerFieldEditor } from './components/TrackerFieldEditor';
export { UserAvatar } from './components/UserAvatar';
export { DisplayOptionsPanel } from './components/DisplayOptionsPanel';
export { getDefaultColumnConfig, resolveColumnsForType, BUILTIN_COLUMNS, DEFAULT_VISIBLE_COLUMNS } from './components/trackerColumns';
export type { TrackerColumnDef, TypeColumnConfig, ColumnRenderType } from './components/trackerColumns';
export type { TrackerFieldEditorProps } from './components/TrackerFieldEditor';

// Export tracker data atoms (cross-platform reactive state)
export {
  trackerItemsMapAtom,
  trackerDataLoadedAtom,
  trackerItemsArrayAtom,
  trackerItemsByTypeAtom,
  archivedTrackerItemsAtom,
  trackerItemByReferenceKeyAtom,
  trackerItemCountByTypeAtom,
  upsertTrackerItemAtom,
  removeTrackerItemAtom,
  replaceAllTrackerItemsAtom,
} from './trackerDataAtoms';

// Export tracker node and types
export { TrackerItemNode, $createTrackerItemNode, $getTrackerItemNode, $isTrackerItemNode } from './TrackerItemNode';
export type { TrackerItemData, TrackerItemType, TrackerItemStatus, TrackerItemPriority } from './TrackerItemNode';
