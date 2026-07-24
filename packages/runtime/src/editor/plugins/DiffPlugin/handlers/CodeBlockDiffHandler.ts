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
import {$isElementNode} from 'lexical';
import {$isCodeNode} from '@lexical/code';
import {$setDiffState, $clearDiffState, $getDiffState} from '../core/DiffState';
import {createNodeFromSerialized} from '../core/createNodeFromSerialized';

/**
 * Handler for code block diffs.
 * Code blocks are treated as atomic units - if the content differs,
 * we show the whole block as removed and add a new one.
 * This avoids complexity with syntax highlighting nodes.
 */
export class CodeBlockDiffHandler implements DiffNodeHandler {
  readonly nodeType = 'code';

  canHandle(context: DiffHandlerContext): boolean {
    return $isCodeNode(context.liveNode);
  }

  handleUpdate(context: DiffHandlerContext): DiffHandlerResult {
    const {liveNode, sourceNode, targetNode} = context;

    if (!$isCodeNode(liveNode)) {
      return {handled: false};
    }

    // Get the text content of source and target code blocks
    const sourceText = this.getCodeBlockText(sourceNode);
    const targetText = this.getCodeBlockText(targetNode);

    // Also check if language changed
    const sourceLang = (sourceNode as any).language || '';
    const targetLang = (targetNode as any).language || '';

    // If content or language is different, treat as full replacement
    if (sourceText !== targetText || sourceLang !== targetLang) {
      // console.log(`Code block change detected - replacing entire block`);
      // console.log(`  Source (${sourceLang}): ${sourceText.substring(0, 50)}...`);
      // console.log(`  Target (${targetLang}): ${targetText.substring(0, 50)}...`);

      // Mark the existing code block as removed
      $setDiffState(liveNode, 'removed');

      // Create a new code block with the target content
      const newCodeBlock = createNodeFromSerialized(targetNode);
      if ($isElementNode(newCodeBlock)) {
        // Mark the new code block as added
        $setDiffState(newCodeBlock, 'added');

        // Insert the new code block after the old one
        liveNode.insertAfter(newCodeBlock);

        // Both blocks will be visible in the diff view:
        // - Old block (removed) with red background/strike-through
        // - New block (added) with green background

        return {handled: true, skipChildren: true};
      }
    }

    // Content is identical - no changes needed
    // console.log('Code block content identical - no diff needed');
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
      if (!$isElementNode(newNode)) {
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
      if ($isCodeNode(liveNode)) {
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
    if ($isElementNode(liveNode)) {
      this.processCodeBlockApproval(liveNode);
      return {handled: true, skipChildren: true};
    }
    return {handled: false};
  }

  handleReject(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    if ($isElementNode(liveNode)) {
      this.processCodeBlockRejection(liveNode);
      return {handled: true, skipChildren: true};
    }
    return {handled: false};
  }

  /**
   * Process approval for code blocks
   */
  private processCodeBlockApproval(element: ElementNode): void {
    const diffState = $getDiffState(element);

    if (diffState === 'added') {
      // Approve addition - clear diff state
      $clearDiffState(element);
    } else if (diffState === 'removed') {
      // Approve removal - remove the node
      element.remove();
    } else {
      // No diff or modified - just clear state
      $clearDiffState(element);
    }
  }

  /**
   * Process rejection for code blocks
   */
  private processCodeBlockRejection(element: ElementNode): void {
    const diffState = $getDiffState(element);

    if (diffState === 'added') {
      // Reject addition - remove the node
      element.remove();
    } else if (diffState === 'removed') {
      // Reject removal - clear diff state
      $clearDiffState(element);
    } else {
      // No diff or modified - just clear state
      $clearDiffState(element);
    }
  }

  /**
   * Extract text content from a serialized code node
   */
  private getCodeBlockText(node: SerializedLexicalNode): string {
    // Code blocks store their text in different ways depending on structure
    // They might have text directly or in child nodes

    // First check for direct text content
    if ('text' in node && typeof node.text === 'string') {
      return node.text;
    }

    // If not, recursively collect text from children
    if ('children' in node && Array.isArray(node.children)) {
      return this.collectTextFromChildren(node.children);
    }

    return '';
  }

  /**
   * Recursively collect text from child nodes
   */
  private collectTextFromChildren(children: SerializedLexicalNode[]): string {
    let text = '';

    for (const child of children) {
      // Handle text nodes
      if (child.type === 'text' && 'text' in child) {
        text += child.text;
      }
      // Handle code-highlight nodes (used for syntax highlighting)
      else if (child.type === 'code-highlight' && 'text' in child) {
        text += child.text;
      }
      // Handle line break nodes
      else if (child.type === 'linebreak') {
        text += '\n';
      }
      // Recursively handle any other nodes with children
      else if ('children' in child && Array.isArray(child.children)) {
        text += this.collectTextFromChildren(child.children);
      }
    }

    return text;
  }
}
