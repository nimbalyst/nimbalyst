/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import type {
  ElementNode,
  LexicalNode,
  SerializedLexicalNode,
  SerializedTextNode,
} from 'lexical';

import {$createListItemNode} from '@lexical/list';
import {$createTextNode, $isElementNode} from 'lexical';

import {getNodeType} from './calculateNodeSimilarity';

/**
 * Update node content based on serialized node
 */
export function $updateNodeContent(
  node: ElementNode,
  serializedNode: SerializedLexicalNode,
): void {
  if (!$isElementNode(node)) {
    return;
  }

  // Check if types match - if not, don't update
  if (node.getType() !== getNodeType(serializedNode)) {
    return;
  }

  // Clear existing content
  node.clear();

  // Handle based on node type
  if (node.getType() === 'paragraph') {
    // Update paragraph content
    if (
      'children' in serializedNode &&
      Array.isArray(serializedNode.children)
    ) {
      for (const child of serializedNode.children) {
        if (child.type === 'text') {
          node.append($createTextNode((child as SerializedTextNode).text));
        }
      }
    }
  } else if (
    node.getType() === 'list' &&
    'children' in serializedNode &&
    Array.isArray(serializedNode.children)
  ) {
    // Update list content
    for (const item of serializedNode.children) {
      if (
        item.type === 'listitem' &&
        'children' in item &&
        Array.isArray(item.children) &&
        item.children.length > 0
      ) {
        const listItem = $createListItemNode();
        // Add all text nodes from the list item
        for (const child of item.children) {
          if (child.type === 'text') {
            listItem.append(
              $createTextNode((child as SerializedTextNode).text),
            );
          }
        }
        node.append(listItem);
      }
    }
  } else if (
    'children' in serializedNode &&
    Array.isArray(serializedNode.children)
  ) {
    // Generic handling for other element types
    for (const child of serializedNode.children) {
      if (child.type === 'text') {
        node.append($createTextNode((child as SerializedTextNode).text));
      }
    }
  }
}
/** @deprecated renamed to {@link $updateNodeContent} by @lexical/eslint-plugin rules-of-lexical */
export const updateNodeContent = $updateNodeContent;
