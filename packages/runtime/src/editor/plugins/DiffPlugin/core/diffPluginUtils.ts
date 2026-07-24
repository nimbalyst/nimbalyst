/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {$isListItemNode, $isListNode} from '@lexical/list';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  createCommand,
  ElementNode,
  LexicalCommand,
  LexicalEditor,
  LexicalNode,
  SerializedLexicalNode,
} from 'lexical';

import {initializeHandlers} from './diffUtils';
import {diffHandlerRegistry, DiffHandlerContext} from '../handlers';
import {$getDiffState, $clearDiffState} from './DiffState';

// Commands
export const APPLY_DIFF_COMMAND: LexicalCommand<Change> =
  createCommand('APPLY_DIFF_COMMAND');
export const APPROVE_DIFF_COMMAND: LexicalCommand<void> = createCommand(
  'APPROVE_DIFF_COMMAND',
);
export const REJECT_DIFF_COMMAND: LexicalCommand<void> = createCommand(
  'REJECT_DIFF_COMMAND',
);
export const CLEAR_DIFF_TAG_COMMAND: LexicalCommand<void> = createCommand(
  'CLEAR_DIFF_TAG_COMMAND',
);
export const INCREMENTAL_APPROVAL_COMMAND: LexicalCommand<void> = createCommand(
  'INCREMENTAL_APPROVAL_COMMAND',
);

// Types
export type Change = {
  type: 'add' | 'remove' | 'change';
  oldText?: string;
  newText?: string;
};

/**
 * Approves all diff changes in the editor.
 * This is a $ function - must be called from within an update context (e.g., command handlers).
 *
 * - Nodes with 'added' DiffState: keep them and clear the diff state
 * - Nodes with 'removed' DiffState: remove them entirely
 * - Nodes with 'modified' DiffState: keep them and clear the diff state
 * - AddNode/RemoveNode instances: handle them for backward compatibility
 */
export function $approveDiffs(): void {
  // Initialize handlers if not already done
  initializeHandlers();

  const root = $getRoot();

  const processElementNode = (element: ElementNode): void => {
        const children = [...element.getChildren()];

        for (const child of children) {
          // Check DiffState first (our new approach)
          const diffState = $getDiffState(child);

          if (diffState === 'added') {
            // Approve addition - clear the diff state (keep the node)
            $clearDiffState(child);
            // Recursively process if it's an element
            if ($isElementNode(child)) {
              processElementNode(child);
            }
            continue;
          }

          if (diffState === 'removed') {
            // Approve removal - remove the node entirely
            child.remove();
            continue;
          }

          if (diffState === 'modified') {
            // Approve modification - clear the diff state and process any nested diff nodes
            $clearDiffState(child);

            // Try to use a handler for this node type to handle nested changes
            const context: DiffHandlerContext = {
              liveNode: child,
              sourceNode: {} as SerializedLexicalNode, // Not used in approve context
              targetNode: {} as SerializedLexicalNode, // Not used in approve context
              changeType: 'update',
              validator: undefined as any,
            };

            const handler = diffHandlerRegistry.findHandler(context);
            if (handler && handler.handleApprove) {
              handler.handleApprove(child, undefined as any);
            } else if ($isElementNode(child)) {
              // Recursively process child elements for nested diff nodes
              processElementNode(child);
            }
            continue;
          }

          // Handle legacy AddNode/RemoveNode instances (for backward compatibility)
          const nodeType = child.getType();
          if (nodeType === 'add') {
            // Accept additions - replace with regular text node, preserving formatting
            const textNode = $createTextNode(child.getTextContent());
            if ('getFormat' in child)
              textNode.setFormat((child as any).getFormat());
            if ('getDetail' in child)
              textNode.setDetail((child as any).getDetail());
            if ('getMode' in child) textNode.setMode((child as any).getMode());
            if ('getStyle' in child)
              textNode.setStyle((child as any).getStyle());
            child.replace(textNode);
            continue;
          }

          if (nodeType === 'remove') {
            // Accept deletions - just remove the node
            const parent = child.getParent();
            if (
              parent &&
              $isListItemNode(parent) &&
              parent.getChildrenSize() === 1
            ) {
              parent.remove();
            } else {
              child.remove();
            }
            continue;
          }

          // Handle special list cases
          if ($isListNode(child)) {
            // Handle list type changes - for approval, keep the current list type
            if ((child as any).__originalListType) {
              delete (child as any).__originalListType;
            }
            // Recursively process child elements
            processElementNode(child);
          } else if ($isElementNode(child)) {
            // Recursively process child elements
            processElementNode(child);
          }
        }
      };

  // Start processing from the root
  processElementNode(root);
}

/**
 * Rejects all diff changes in the editor.
 * This is a $ function - must be called from within an update context (e.g., command handlers).
 *
 * - Nodes with 'added' DiffState: remove them entirely
 * - Nodes with 'removed' DiffState: keep them and clear the diff state
 * - Nodes with 'modified' DiffState: keep them and clear the diff state (preserving original content)
 * - AddNode/RemoveNode instances: handle them for backward compatibility
 */
export function $rejectDiffs(): void {
  // Initialize handlers if not already done
  initializeHandlers();

  const root = $getRoot();

      const processElementNode = (element: ElementNode): void => {
        const children = [...element.getChildren()];

        for (const child of children) {
          // Check DiffState first (our new approach)
          const diffState = $getDiffState(child);

          if (diffState === 'added') {
            // Reject addition - remove the node entirely
            child.remove();
            continue;
          }

          if (diffState === 'removed') {
            // Reject removal - clear the diff state (keep the node)
            $clearDiffState(child);
            // Recursively process if it's an element
            if ($isElementNode(child)) {
              processElementNode(child);
            }
            continue;
          }

          if (diffState === 'modified') {
            // Try to use a handler for this node type to handle rejection
            const context: DiffHandlerContext = {
              liveNode: child,
              sourceNode: {} as SerializedLexicalNode, // Not used in reject context
              targetNode: {} as SerializedLexicalNode, // Not used in reject context
              changeType: 'update',
              validator: undefined as any,
            };

            const handler = diffHandlerRegistry.findHandler(context);
            if (handler && handler.handleReject) {
              // Let the handler handle the rejection (including clearing diff state)
              handler.handleReject(child, undefined as any);
            } else {
              // No handler, just clear the diff state and process nested nodes
              $clearDiffState(child);
              if ($isElementNode(child)) {
                // Recursively process child elements for nested diff nodes
                processElementNode(child);
              }
            }
            continue;
          }

          // Handle legacy AddNode/RemoveNode instances (for backward compatibility)
          const nodeType = child.getType();
          if (nodeType === 'add') {
            // Reject additions - remove the node
            const parent = child.getParent();
            if (
              parent &&
              $isListItemNode(parent) &&
              parent.getChildrenSize() === 1
            ) {
              parent.remove();
            } else {
              child.remove();
            }
            continue;
          }

          if (nodeType === 'remove') {
            // Reject deletions - keep the content by converting to a regular text node
            const textNode = $createTextNode(child.getTextContent());
            if ('getFormat' in child)
              textNode.setFormat((child as any).getFormat());
            if ('getDetail' in child)
              textNode.setDetail((child as any).getDetail());
            if ('getMode' in child) textNode.setMode((child as any).getMode());
            if ('getStyle' in child)
              textNode.setStyle((child as any).getStyle());
            child.replace(textNode);
            continue;
          }

          // Handle special list cases
          if ($isListNode(child)) {
            // Handle list type changes - for rejection, restore the original list type
            if ((child as any).__originalListType) {
              const originalListType = (child as any).__originalListType;
              child.setListType(originalListType as 'bullet' | 'number');
              delete (child as any).__originalListType;
            }
            // Recursively process child elements
            processElementNode(child);
          } else if ($isElementNode(child)) {
            // Recursively process child elements
            processElementNode(child);
          }
        }
      };

  // Start processing from the root
  processElementNode(root);
}

/**
 * Checks if the editor contains any diff markers.
 * Uses DiffState and legacy AddNode/RemoveNode detection.
 */
export function $hasDiffNodes(editor: LexicalEditor): boolean {
  let hasDiffNodes = false;
  let diffNodesFound: string[] = [];

  editor.getEditorState().read(() => {
    const root = $getRoot();

    const checkForDiffNodes = (element: ElementNode) => {
      const children = element.getChildren();

      for (const child of children) {
        // Check DiffState (our new approach)
        const diffState = $getDiffState(child);
        if (
          diffState === 'added' ||
          diffState === 'removed' ||
          diffState === 'modified'
        ) {
          hasDiffNodes = true;
          diffNodesFound.push(`${child.getType()}:${diffState} "${child.getTextContent().substring(0, 20)}"`);
          return;
        }

        // Check legacy AddNode/RemoveNode instances (for backward compatibility)
        const nodeType = child.getType();
        if (nodeType === 'add' || nodeType === 'remove') {
          hasDiffNodes = true;
          diffNodesFound.push(`legacy:${nodeType} "${child.getTextContent().substring(0, 20)}"`);
          return;
        }

        if ($isElementNode(child)) {
          checkForDiffNodes(child);
          if (hasDiffNodes) {
            return;
          }
        }
      }
    };

    checkForDiffNodes(root);
  });

  if (diffNodesFound.length > 0) {
    // console.log('🔍 $hasDiffNodes found diff nodes:', diffNodesFound);
  } else {
    // console.log('❌ $hasDiffNodes: NO diff nodes found');
  }

  return hasDiffNodes;
}

/**
 * Helper function to wrap text in appropriate diff nodes
 */
export function applyTextDiff(editor: LexicalEditor, change: Change): void {
  editor.dispatchCommand(APPLY_DIFF_COMMAND, change);
}

/**
 * Get all nodes with diff state from the editor
 */
export function getDiffNodesFromEditor(
  editor: LexicalEditor,
): Array<LexicalNode> {
  const diffNodes: Array<LexicalNode> = [];

  editor.getEditorState().read(() => {
    const root = $getRoot();

    const collectDiffNodes = (element: ElementNode) => {
      const children = element.getChildren();

      for (const child of children) {
        // Check DiffState (our new approach)
        const diffState = $getDiffState(child);
        if (
          diffState === 'added' ||
          diffState === 'removed' ||
          diffState === 'modified'
        ) {
          diffNodes.push(child);
        }

        // Check legacy AddNode/RemoveNode instances (for backward compatibility)
        const nodeType = child.getType();
        if (nodeType === 'add' || nodeType === 'remove') {
          diffNodes.push(child);
        }

        if ($isElementNode(child)) {
          collectDiffNodes(child);
        }
      }
    };

    collectDiffNodes(root);
  });

  return diffNodes;
}

/**
 * Approve a specific change group (specific nodes only)
 */
export function $approveChangeGroup(editor: LexicalEditor, nodes: LexicalNode[]): void {
  initializeHandlers();

  editor.update(() => {
    for (const node of nodes) {
      if (!node || !node.isAttached()) continue;

      const diffState = $getDiffState(node);

      if (diffState === 'added') {
        $clearDiffState(node);

        // Also clear diff state from parent nodes
        // This is necessary because grouping collects child nodes (text nodes)
        // but their parent containers (paragraphs) also have diff state
        let parent = node.getParent();
        while (parent) {
          const parentDiffState = $getDiffState(parent);
          if (parentDiffState) {
            $clearDiffState(parent);
          }
          parent = parent.getParent();
        }
      } else if (diffState === 'removed') {
        node.remove();
      } else if (diffState === 'modified') {
        $clearDiffState(node);

        // Also clear diff state from parent nodes
        let parent = node.getParent();
        while (parent) {
          const parentDiffState = $getDiffState(parent);
          if (parentDiffState) {
            $clearDiffState(parent);
          }
          parent = parent.getParent();
        }
      } else {
        // Handle legacy nodes
        const nodeType = node.getType();
        if (nodeType === 'add') {
          const textContent = node.getTextContent();
          const textNode = $createTextNode(textContent);
          node.replace(textNode);
        } else if (nodeType === 'remove') {
          node.remove();
        }
      }
    }
  }, { discrete: true });
}

/**
 * Reject a specific change group (specific nodes only)
 */
export function $rejectChangeGroup(editor: LexicalEditor, nodes: LexicalNode[]): void {
  initializeHandlers();

  editor.update(() => {
    for (const node of nodes) {
      if (!node || !node.isAttached()) continue;

      const diffState = $getDiffState(node);

      if (diffState === 'added') {
        node.remove();
      } else if (diffState === 'removed') {
        $clearDiffState(node);
      } else if (diffState === 'modified') {
        $clearDiffState(node);
      } else {
        // Handle legacy nodes
        const nodeType = node.getType();
        if (nodeType === 'add') {
          node.remove();
        } else if (nodeType === 'remove') {
          const textContent = node.getTextContent();
          const textNode = $createTextNode(textContent);
          node.replace(textNode);
        }
      }
    }
  }, { discrete: true });
}
