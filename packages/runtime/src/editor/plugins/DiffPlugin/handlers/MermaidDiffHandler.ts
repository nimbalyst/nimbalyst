/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {DiffNodeHandler, DiffHandlerContext, DiffHandlerResult} from './DiffNodeHandler';
import type {NodeStructureValidator} from '../core/NodeStructureValidator';
import type {ElementNode, LexicalNode} from 'lexical';
import type {SerializedLexicalNode} from 'lexical';
import {$setDiffState, $clearDiffState, $getDiffState} from '../core/DiffState';
import {createNodeFromSerialized} from '../core/createNodeFromSerialized';
import {$isMermaidNode} from '../../MermaidPlugin/MermaidNode';

/**
 * Handler for mermaid diagram diffs.
 * Mermaid diagrams are treated as atomic units - if the content differs,
 * we show the whole diagram as removed and add a new one.
 * This is similar to how code blocks are handled.
 */
export class MermaidDiffHandler implements DiffNodeHandler {
  readonly nodeType = 'mermaid';

  canHandle(context: DiffHandlerContext): boolean {
    return $isMermaidNode(context.liveNode);
  }

  handleUpdate(context: DiffHandlerContext): DiffHandlerResult {
    const {liveNode, sourceNode, targetNode} = context;

    if (!$isMermaidNode(liveNode)) {
      return {handled: false};
    }

    // Get the content of source and target mermaid nodes
    const sourceContent = (sourceNode as any).content || '';
    const targetContent = (targetNode as any).content || '';

    // If content is different, treat as full replacement
    if (sourceContent !== targetContent) {
      // Mark the existing mermaid node as removed
      $setDiffState(liveNode, 'removed');

      // Create a new mermaid node with the target content
      const newMermaidNode = createNodeFromSerialized(targetNode);
      if (newMermaidNode) {
        // Mark the new mermaid node as added
        $setDiffState(newMermaidNode, 'added');

        // Insert the new mermaid node after the old one
        liveNode.insertAfter(newMermaidNode);

        // Both nodes will be visible in the diff view:
        // - Old node (removed) with red background/strike-through
        // - New node (added) with green background

        return {handled: true, skipChildren: true};
      }
    }

    // Content is identical - no changes needed
    return {handled: true, skipChildren: true};
  }

  handleAdd(
    targetNode: SerializedLexicalNode,
    parentNode: ElementNode,
    position: number,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    try {
      const newNode = createNodeFromSerialized(targetNode);
      if (!newNode) {
        return {handled: false};
      }

      // Mark as added
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
      if ($isMermaidNode(liveNode)) {
        // Mark as removed
        $setDiffState(liveNode, 'removed');
        return {handled: true};
      }
      return {handled: false};
    } catch (error) {
      return {error: String(error), handled: false};
    }
  }

  handleApprove(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    if ($isMermaidNode(liveNode)) {
      this.processMermaidApproval(liveNode);
      return {handled: true, skipChildren: true};
    }
    return {handled: false};
  }

  handleReject(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    if ($isMermaidNode(liveNode)) {
      this.processMermaidRejection(liveNode);
      return {handled: true, skipChildren: true};
    }
    return {handled: false};
  }

  /**
   * Process approval for mermaid nodes
   */
  private processMermaidApproval(node: LexicalNode): void {
    const diffState = $getDiffState(node);

    if (diffState === 'added') {
      // Approve addition - clear diff state
      $clearDiffState(node);
    } else if (diffState === 'removed') {
      // Approve removal - remove the node
      node.remove();
    } else {
      // No diff or modified - just clear state
      $clearDiffState(node);
    }
  }

  /**
   * Process rejection for mermaid nodes
   */
  private processMermaidRejection(node: LexicalNode): void {
    const diffState = $getDiffState(node);

    if (diffState === 'added') {
      // Reject addition - remove the node
      node.remove();
    } else if (diffState === 'removed') {
      // Reject removal - clear diff state
      $clearDiffState(node);
    } else {
      // No diff or modified - just clear state
      $clearDiffState(node);
    }
  }
}
