/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any, no-shadow */

import type {NodeStructureValidator} from '../core/NodeStructureValidator';
import type {
  DiffHandlerContext,
  DiffHandlerResult,
  DiffNodeHandler,
} from './DiffNodeHandler';
import type {ElementNode, LexicalNode, SerializedLexicalNode} from 'lexical';
import {$isElementNode, $isTextNode} from 'lexical';

import {getNodeContent} from '../core/calculateNodeSimilarity';
import {createNodeFromSerialized} from '../core/createNodeFromSerialized';
import {$setDiffState} from '../core/DiffState';

/**
 * Default handler for basic node types (paragraph, heading, text, etc.)
 * Uses DiffState to track changes instead of creating special diff nodes
 */
export class DefaultDiffHandler implements DiffNodeHandler {
  readonly nodeType = 'default';

  canHandle(context: DiffHandlerContext): boolean {
    // This is the fallback handler, so it can handle anything
    // that doesn't have a specialized handler
    return true;
  }

  handleUpdate(context: DiffHandlerContext): DiffHandlerResult {
    const {liveNode, sourceNode, targetNode} = context;

    if ($isElementNode(liveNode) && sourceNode.type === targetNode.type) {
      // Handle element node updates (paragraph, heading, etc.)
      return this.handleElementNodeUpdate(liveNode, sourceNode, targetNode);
    }

    if (
      $isTextNode(liveNode) &&
      sourceNode.type === 'text' &&
      targetNode.type === 'text'
    ) {
      // Handle text node updates
      return this.handleTextNodeUpdate(liveNode, sourceNode, targetNode);
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
      // Create the new node
      const newNode = createNodeFromSerialized(targetNode);
      if (!$isElementNode(newNode)) {
        return {handled: false};
      }

      // Mark it as added using DiffState
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
        // Mark as removed using DiffState - preserves original content
        $setDiffState(liveNode, 'removed');
        return {handled: true};
      } else {
        return {handled: false};
      }
    } catch (error) {
      return {error: String(error), handled: false};
    }
  }

  /**
   * Handle approving diffs in basic nodes
   * With DiffState, approval is handled externally - no special processing needed here
   */
  handleApprove(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    // DiffState-based approach: approval is handled by external systems
    // that read the diff state and apply changes accordingly
    return {handled: true, skipChildren: false};
  }

  /**
   * Handle rejecting diffs in basic nodes
   * With DiffState, rejection is handled externally - no special processing needed here
   */
  handleReject(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    // DiffState-based approach: rejection is handled by external systems
    // that read the diff state and revert changes accordingly
    return {handled: true, skipChildren: false};
  }

  /**
   * Handle updates to text nodes - simplified with DiffState
   */
  private handleTextNodeUpdate(
    liveTextNode: LexicalNode,
    sourceNode: SerializedLexicalNode,
    targetNode: SerializedLexicalNode,
  ): DiffHandlerResult {
    const sourceText = 'text' in sourceNode ? (sourceNode.text as string) : '';
    const targetText = 'text' in targetNode ? (targetNode.text as string) : '';

    if (sourceText === targetText) {
      // No change needed
      return {handled: true};
    }

    // For text nodes, we mark the parent element as modified
    // The parent element's DiffState will indicate this contains changes
    const parent = liveTextNode.getParent();
    if (parent && $isElementNode(parent)) {
      $setDiffState(parent, 'modified');
      return {handled: true, skipChildren: true};
    }

    return {handled: false};
  }

  /**
   * Handle element node updates - simplified with DiffState
   */
  private handleElementNodeUpdate(
    liveNode: ElementNode,
    sourceNode: SerializedLexicalNode,
    targetNode: SerializedLexicalNode,
  ): DiffHandlerResult {
    const sourceText = getNodeContent(sourceNode);
    const targetText = getNodeContent(targetNode);

    if (sourceText === targetText) {
      // Content is the same, no change needed - don't process children
      return {handled: true, skipChildren: true};
    }

    // Content has changed - mark as modified
    // The DiffState tracks that this node has changes, and external systems
    // can decide how to visualize or handle the changes
    $setDiffState(liveNode, 'modified');

    return {handled: true, skipChildren: false};
  }
}
