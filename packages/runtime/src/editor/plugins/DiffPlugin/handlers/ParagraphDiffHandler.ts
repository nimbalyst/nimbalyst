/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  DiffHandlerContext,
  DiffHandlerResult,
  DiffNodeHandler,
} from './DiffNodeHandler';
import type {ElementNode, LexicalNode, SerializedLexicalNode} from 'lexical';

import {$isElementNode} from 'lexical';

import {$applyInlineTextDiff} from '../core/inlineTextDiff';

/**
 * Handler specifically for paragraph nodes that preserves formatting
 */
export class ParagraphDiffHandler implements DiffNodeHandler {
  readonly nodeType = 'paragraph';

  canHandle(context: DiffHandlerContext): boolean {
    return context.liveNode.getType() === 'paragraph';
  }

  handleUpdate(context: DiffHandlerContext): DiffHandlerResult {
    const {liveNode, sourceNode, targetNode} = context;

    if (!$isElementNode(liveNode)) {
      return {handled: false};
    }

    const sourceChildren =
      'children' in sourceNode && Array.isArray(sourceNode.children)
        ? sourceNode.children
        : [];

    const targetChildren =
      'children' in targetNode && Array.isArray(targetNode.children)
        ? targetNode.children
        : [];

    // Use the unified inline text diff system
    $applyInlineTextDiff(liveNode, sourceChildren, targetChildren);

    return {handled: true, skipChildren: true};
  }

  handleAdd(
    targetNode: SerializedLexicalNode,
    parentNode: ElementNode,
    position: number,
  ): DiffHandlerResult {
    // For adds, we can use the default behavior
    return {handled: false};
  }

  handleRemove(liveNode: LexicalNode): DiffHandlerResult {
    // For removes, we can use the default behavior
    return {handled: false};
  }
}
