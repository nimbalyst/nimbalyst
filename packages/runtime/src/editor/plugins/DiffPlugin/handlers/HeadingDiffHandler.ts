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

import {$isHeadingNode} from '@lexical/rich-text';
import {
  $createTextNode,
  $isElementNode,
  $isTextNode,
  ElementNode,
  LexicalNode,
  SerializedLexicalNode,
} from 'lexical';

import {createNodeFromSerialized} from '../core/createNodeFromSerialized';
import {$setDiffState, $getDiffState, $clearDiffState} from '../core/DiffState';
import {$applyInlineTextDiff} from '../core/inlineTextDiff';

/**
 * Handler for heading node types using DiffState-based approach
 * Supports all heading levels (h1-h6) with proper diff visualization
 */
export class HeadingDiffHandler implements DiffNodeHandler {
  readonly nodeType = 'heading';

  canHandle(context: DiffHandlerContext): boolean {
    return $isHeadingNode(context.liveNode);
  }

  handleUpdate(context: DiffHandlerContext): DiffHandlerResult {
    const {liveNode, sourceNode, targetNode} = context;

    if ($isHeadingNode(liveNode)) {
      return this.handleHeadingUpdate(liveNode, sourceNode, targetNode);
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
   * Handle approval for heading nodes
   */
  handleApprove(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    if ($isElementNode(liveNode)) {
      this.processHeadingApproval(liveNode);
      return {handled: true, skipChildren: true};
    }
    return {handled: false};
  }

  /**
   * Handle rejection for heading nodes
   */
  handleReject(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    if ($isElementNode(liveNode)) {
      this.processHeadingRejection(liveNode);
      return {handled: true, skipChildren: true};
    }
    return {handled: false};
  }

  /**
   * Handle heading node updates
   */
  private handleHeadingUpdate(
    liveNode: ElementNode,
    sourceNode: SerializedLexicalNode,
    targetNode: SerializedLexicalNode,
  ): DiffHandlerResult {
    // Check for heading level changes
    const sourceTag = (sourceNode as any).tag;
    const targetTag = (targetNode as any).tag;

    if (sourceTag !== targetTag) {
      // Update to the target tag
      if ($isHeadingNode(liveNode)) {
        // Create a writable version of the node first
        const writableNode = liveNode.getWritable();
        // Store the original tag for rejection purposes
        (writableNode as any).__originalTag = sourceTag;
        // Update to the target tag
        (writableNode as any).setTag(targetTag);
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

    // Use the unified inline text diff system. The caller already marked
    // liveNode as 'modified' before invoking this handler; we don't reapply
    // it here because $applyInlineTextDiff may legitimately downgrade the
    // state to 'removed' when it splits the heading into a removed-source /
    // added-target sibling pair for near-complete rewrites.
    $applyInlineTextDiff(liveNode, sourceChildren, targetChildren);

    return {handled: true, skipChildren: true};
  }

  /**
   * Process approval for headings
   */
  private processHeadingApproval(element: ElementNode): void {
    // Clear any diff state on the element itself
    $clearDiffState(element);

    // Handle tag changes
    if ((element as any).__originalTag) {
      // Keep the new tag (approval)
      // Get writable node to delete property
      const writableElement = element.getWritable();
      delete (writableElement as any).__originalTag;
    }

    // Process text diff markers
    this.approveTextDiffMarkers(element);
  }

  /**
   * Process rejection for headings
   */
  private processHeadingRejection(element: ElementNode): void {
    // Clear any diff state on the element itself
    $clearDiffState(element);

    // Handle tag changes
    if ((element as any).__originalTag) {
      // Restore the original tag (rejection)
      const originalTag = (element as any).__originalTag;
      if ($isHeadingNode(element)) {
        // Get writable node to modify
        const writableElement = element.getWritable();
        (writableElement as any).setTag(originalTag);
        delete (writableElement as any).__originalTag;
      }
    }

    // Process text diff markers
    this.rejectTextDiffMarkers(element);
  }

  /**
   * Approve text diff markers within a heading
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
      } else if ($isElementNode(child)) {
        this.approveTextDiffMarkers(child);
      }
    }
  }

  /**
   * Reject text diff markers within a heading
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
      } else if ($isElementNode(child)) {
        this.rejectTextDiffMarkers(child);
      }
    }
  }
}
