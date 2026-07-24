/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type {NodeStructureValidator} from '../core/NodeStructureValidator';
import type {
  DiffHandlerContext,
  DiffHandlerResult,
  DiffNodeHandler,
} from './DiffNodeHandler';

import {$isListItemNode, $isListNode} from '@lexical/list';
import {
  $createTextNode,
  $isElementNode,
  $isTextNode,
  ElementNode,
  LexicalNode,
  SerializedLexicalNode,
} from 'lexical';

import {createNodeFromSerialized} from '../core/createNodeFromSerialized';
import {$setDiffState, $getDiffState, $clearDiffState, $getOriginalChecked, $setOriginalChecked, $clearOriginalChecked} from '../core/DiffState';
import {$applyInlineTextDiff} from '../core/inlineTextDiff';
import {$applySubTreeDiff} from '../core/diffUtils';

/**
 * Handler for list node types using DiffState-based approach with recursive sub-tree matching
 * Supports both bullet and numbered lists with proper diff visualization
 * Now includes recursive sub-tree diffing for fine-grained list item changes
 */
export class ListDiffHandler implements DiffNodeHandler {
  readonly nodeType = 'list';

  canHandle(context: DiffHandlerContext): boolean {
    return $isListNode(context.liveNode) || $isListItemNode(context.liveNode);
  }

  handleUpdate(context: DiffHandlerContext): DiffHandlerResult {
    const {liveNode, sourceNode, targetNode} = context;

    if ($isListNode(liveNode)) {
      return this.handleListNodeUpdate(
        liveNode,
        sourceNode,
        targetNode,
        context,
      );
    }

    if ($isListItemNode(liveNode)) {
      return this.handleListItemUpdate(
        liveNode,
        sourceNode,
        targetNode,
        context,
      );
    }

    return {handled: false};
  }

  handleAdd(
    targetNode: SerializedLexicalNode,
    parentNode: ElementNode,
    position: number,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    try {
      const newNode = createNodeFromSerialized(targetNode);
      if (!$isElementNode(newNode)) {
        return {handled: false};
      }

      // Mark as added using DiffState
      $setDiffState(newNode, 'added');

      // Insert at the correct position
      const children = parentNode.getChildren();
      if (position < children.length) {
        children[position].insertBefore(newNode);
      } else {
        parentNode.append(newNode);
      }

      return {handled: true};
    } catch (error) {
      return {error: String(error), handled: false};
    }
  }

  handleRemove(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    try {
      if ($isElementNode(liveNode)) {
        // Mark as removed using DiffState
        $setDiffState(liveNode, 'removed');
        return {handled: true};
      }
      return {handled: false};
    } catch (error) {
      return {error: String(error), handled: false};
    }
  }

  /**
   * Handle approval for list nodes
   */
  handleApprove(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    if ($isElementNode(liveNode)) {
      this.processListApproval(liveNode);
      return {handled: true, skipChildren: true};
    }
    return {handled: false};
  }

  /**
   * Handle rejection for list nodes
   */
  handleReject(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    if ($isElementNode(liveNode)) {
      this.processListRejection(liveNode);
      return {handled: true, skipChildren: true};
    }
    return {handled: false};
  }

  /**
   * Handle list node updates with recursive sub-tree matching
   */
  private handleListNodeUpdate(
    liveNode: ElementNode,
    sourceNode: SerializedLexicalNode,
    targetNode: SerializedLexicalNode,
    context: DiffHandlerContext,
  ): DiffHandlerResult {
    // Check for list type changes
    if ($isListNode(liveNode)) {
      const sourceListType = (sourceNode as any).listType;
      const targetListType = (targetNode as any).listType;

      if (sourceListType !== targetListType) {
        // console.log(`List type change detected: ${sourceListType} -> ${targetListType}`);

        // Instead of modifying the existing list, we need to:
        // 1. Mark the old list as removed
        // 2. Create a new list with the new type and mark it as added

        // Mark the existing list (with old type) as removed
        $setDiffState(liveNode, 'removed');

        // Create a new list with the target type
        const newList = createNodeFromSerialized(targetNode);
        if ($isElementNode(newList)) {
          // Mark the new list as added
          $setDiffState(newList, 'added');

          // Insert the new list after the old one
          liveNode.insertAfter(newList);

          // The new list now has all the content from targetNode
          // Both lists will be visible in the diff view:
          // - Old list (removed) with strike-through
          // - New list (added) in green

          return {handled: true, skipChildren: true};
        }
      }
    }

    // Extract children from source and target nodes
    const sourceChildren =
      'children' in sourceNode && Array.isArray(sourceNode.children)
        ? sourceNode.children
        : [];
    const targetChildren =
      'children' in targetNode && Array.isArray(targetNode.children)
        ? targetNode.children
        : [];

    // Check if we need to apply recursive sub-tree diffing
    if (sourceChildren.length > 0 || targetChildren.length > 0) {
      // DON'T mark the list itself as modified - only the children that changed will be marked
      // This prevents the entire list from being highlighted when only individual items changed
      // $setDiffState(liveNode, 'modified');

      // Skip sub-tree diff if source and target are exact matches
      // This prevents false matches in nested content when parent is unchanged
      const isExactMatch = this.areNodesExactMatch(sourceNode, targetNode);

      if (isExactMatch) {
        // console.log('[ListDiffHandler] Skipping sub-tree diff - nodes are exact match');
        // No diff state needed - node is unchanged
        return {handled: true, skipChildren: true};
      }

      // Use recursive sub-tree diffing for better insertion positioning and index alignment
      if (
        context.sourceEditor &&
        context.targetEditor &&
        context.transformers
      ) {
        // console.log(
        //   '\n🔄 [ListDiffHandler] Applying recursive sub-tree diff to list for better insertion positioning...',
        // );

        try {
          // Apply recursive sub-tree diffing to the list children
          $applySubTreeDiff(
            liveNode,
            sourceNode,
            targetNode,
            context.sourceEditor,
            context.targetEditor,
            context.transformers,
          );

          // console.log('✅ [ListDiffHandler] Recursive sub-tree diff completed successfully');
          return {handled: true, skipChildren: true};
        } catch (error) {
          console.warn(
            'Sub-tree diff failed, falling back to traditional approach:',
            error,
          );
          // Fall through to traditional approach
        }
      } else {
        console.log(
          '⚠️  Editor references not available, using traditional approach',
        );
      }

      // Traditional approach (fallback)
      // Process each list item individually
      const liveChildren = liveNode.getChildren();
      const maxLength = Math.max(
        sourceChildren.length,
        targetChildren.length,
        liveChildren.length,
      );

      for (let i = 0; i < maxLength; i++) {
        const sourceChild =
          i < sourceChildren.length ? sourceChildren[i] : null;
        const targetChild =
          i < targetChildren.length ? targetChildren[i] : null;
        const liveChild = i < liveChildren.length ? liveChildren[i] : null;

        if (
          sourceChild &&
          targetChild &&
          liveChild &&
          $isElementNode(liveChild)
        ) {
          // Update existing list item
          this.handleListItemUpdate(
            liveChild,
            sourceChild,
            targetChild,
            context,
          );
        } else if (targetChild && !sourceChild) {
          // Add new list item
          const newItem = createNodeFromSerialized(targetChild);
          if ($isElementNode(newItem)) {
            $setDiffState(newItem, 'added');
            liveNode.append(newItem);
          }
        } else if (sourceChild && !targetChild && liveChild) {
          // Remove list item
          $setDiffState(liveChild, 'removed');
        }
      }
    }

    // Skip children since we handled them manually
    return {handled: true, skipChildren: true};
  }

  /**
   * Handle list item updates
   */
  private handleListItemUpdate(
    liveNode: ElementNode,
    sourceNode: SerializedLexicalNode,
    targetNode: SerializedLexicalNode,
    context: DiffHandlerContext,
  ): DiffHandlerResult {
    // Handle checkbox state changes (e.g., [ ] -> [x])
    // The checked property is on the listitem node itself, not in children,
    // so the inline text diff system won't detect it.
    // We use Lexical's NodeState API ($setOriginalChecked) instead of direct
    // property assignment because setChecked() calls getWritable() which clones
    // the node -- direct properties on the original reference would be lost.
    if ($isListItemNode(liveNode)) {
      const sourceChecked = (sourceNode as any).checked;
      const targetChecked = (targetNode as any).checked;

      if (sourceChecked !== targetChecked && typeof targetChecked === 'boolean') {
        // Store original value for rejection FIRST (before setChecked clones)
        $setOriginalChecked(liveNode, sourceChecked ?? false);
        // Apply the new checked state so it's visible in diff mode
        liveNode.setChecked(targetChecked);
      }
    }

    const sourceChildren =
      'children' in sourceNode && Array.isArray(sourceNode.children)
        ? sourceNode.children
        : [];
    const targetChildren =
      'children' in targetNode && Array.isArray(targetNode.children)
        ? targetNode.children
        : [];

    // Check if this list item has nested lists (ListNode children)
    const hasNestedList =
      sourceChildren.some((child) => child.type === 'list') ||
      targetChildren.some((child) => child.type === 'list');

    if (hasNestedList) {
      // For list items with nested lists, don't use inline text diff
      // as it would destroy the nested list structure with clear()
      // Instead, just mark as modified and let the recursive system handle the rest
      // console.log(
      //   '🏗️ List item contains nested list - preserving structure, letting recursive system handle nested content',
      // );
      $setDiffState(liveNode, 'modified');
      return {handled: true, skipChildren: false}; // Let the system recurse into children
    } else {
      // For regular list items (text, links, formatting), use the inline
      // text diff system. The caller already marked liveNode as 'modified';
      // we don't reapply it here because $applyInlineTextDiff may
      // legitimately downgrade the state to 'removed' when it splits the
      // list item into a removed-source / added-target sibling pair for
      // near-complete rewrites.
      $applyInlineTextDiff(liveNode, sourceChildren, targetChildren);
      return {handled: true, skipChildren: true};
    }
  }

  /**
   * Process approval for lists and list items.
   *
   * Children are scanned twice: first non-removal updates (clear-state +
   * recursion) in original order, then nodes-to-remove in REVERSE order.
   *
   * The reverse order matters because @lexical/list's ListItemNode.remove()
   * auto-merges when BOTH neighbors are nested-list-wrapper listitems --
   * see `mergeLists` in @lexical/list. AI edits that append a new outer
   * bullet plus its nested URL bullet (e.g. "- California\n  - URL: ...")
   * land as two adjacent added listitems: a text wrapper and a nested-list
   * wrapper. If we remove them left-to-right, removing the text listitem
   * triggers the merge between its left wrapper neighbor (which we still
   * need) and its right wrapper neighbor (the added one we're about to
   * remove). The merge moves the added wrapper's nested children into the
   * surviving wrapper, leaving stray content after the rejection completes.
   * Removing right-to-left removes the rightmost added wrapper first, so by
   * the time we touch the text listitem its right neighbor is gone (or no
   * longer a wrapper) and the merge condition doesn't fire.
   */
  private processListApproval(element: ElementNode): void {
    // Clear any diff state on the element itself
    $clearDiffState(element);

    const children = [...element.getChildren()];
    const toRemove: LexicalNode[] = [];

    for (const child of children) {
      const diffState = $getDiffState(child);

      if (diffState === 'added') {
        // Approve addition - clear diff state
        $clearDiffState(child);
      } else if (diffState === 'removed') {
        // Approve removal - defer the remove to a reverse-order pass below
        toRemove.push(child);
        continue;
      } else if (diffState === 'modified') {
        // Approve modification - clear diff state and handle text nodes
        $clearDiffState(child);

        // Clean up stored original checkbox state (checked state already applied)
        $clearOriginalChecked(child);

        if ($isElementNode(child)) {
          // Process list item children for inline diff markers
          this.approveTextDiffMarkers(child);
        }
      }

      // Recursively process if it's an element (kept-alive children only)
      if ($isElementNode(child)) {
        this.processListApproval(child);
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      toRemove[i].remove();
    }
  }

  /**
   * Process rejection for lists and list items. See {@link processListApproval}
   * for why removals run in reverse order.
   */
  private processListRejection(element: ElementNode): void {
    // Clear any diff state on the element itself
    $clearDiffState(element);

    const children = [...element.getChildren()];
    const toRemove: LexicalNode[] = [];

    for (const child of children) {
      const diffState = $getDiffState(child);

      if (diffState === 'added') {
        // Reject addition - defer the remove to a reverse-order pass below
        toRemove.push(child);
        continue;
      } else if (diffState === 'removed') {
        // Reject removal - clear diff state
        $clearDiffState(child);
      } else if (diffState === 'modified') {
        // Reject modification - clear diff state and handle text nodes
        $clearDiffState(child);

        // Restore original checkbox state on rejection
        const originalChecked = $getOriginalChecked(child);
        if (originalChecked !== null && $isListItemNode(child)) {
          child.setChecked(originalChecked);
          $clearOriginalChecked(child);
        }

        if ($isElementNode(child)) {
          // Process list item children for inline diff markers
          this.rejectTextDiffMarkers(child);
        }
      }

      // Recursively process if it's an element (kept-alive children only)
      if ($isElementNode(child)) {
        this.processListRejection(child);
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      toRemove[i].remove();
    }
  }

  /**
   * Approve text diff markers within a list item
   */
  private approveTextDiffMarkers(element: ElementNode): void {
    const children = [...element.getChildren()];

    for (const child of children) {
      if ($isTextNode(child)) {
        const diffState = $getDiffState(child);

        if (diffState === 'removed') {
          // Approve removal - remove the text node
          child.remove();
        } else if (diffState === 'added') {
          // Approve addition - clear the diff state (keep the text)
          $clearDiffState(child);
        }
        // Note: nodes without diff state are unchanged and should remain
      } else if ($isElementNode(child)) {
        this.approveTextDiffMarkers(child);
      }
    }
  }

  /**
   * Reject text diff markers within a list item
   */
  private rejectTextDiffMarkers(element: ElementNode): void {
    const children = [...element.getChildren()];

    for (const child of children) {
      if ($isTextNode(child)) {
        const diffState = $getDiffState(child);

        if (diffState === 'added') {
          // Reject addition - remove the text node
          child.remove();
        } else if (diffState === 'removed') {
          // Reject removal - clear the diff state (keep the text)
          $clearDiffState(child);
        }
        // Note: nodes without diff state are unchanged and should remain
      } else if ($isElementNode(child)) {
        this.rejectTextDiffMarkers(child);
      }
    }
  }

  /**
   * Check if two serialized nodes are exact matches
   * Compares the JSON representation recursively
   */
  private areNodesExactMatch(
    node1: SerializedLexicalNode,
    node2: SerializedLexicalNode,
  ): boolean {
    // Compare JSON strings for deep equality
    // This includes type, text, children, and all other properties
    try {
      const json1 = JSON.stringify(node1, this.sortKeys);
      const json2 = JSON.stringify(node2, this.sortKeys);
      return json1 === json2;
    } catch (error) {
      // If serialization fails, assume not equal
      return false;
    }
  }

  /**
   * Helper to sort object keys for stable JSON comparison
   */
  private sortKeys(key: string, value: any): any {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value)
        .sort()
        .reduce((sorted: any, k: string) => {
          sorted[k] = value[k];
          return sorted;
        }, {});
    }
    return value;
  }
}
