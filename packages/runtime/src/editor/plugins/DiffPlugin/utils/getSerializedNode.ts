/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalNode, SerializedLexicalNode} from 'lexical';
import {$isElementNode} from 'lexical';
import type {SerializedElementNode} from 'lexical';

/**
 * Properly serialize a node including all its children
 * Based on exportNodeToJSON from LexicalEditorState
 */
export function $getSerializedNode<
  SerializedNode extends SerializedLexicalNode,
>(node: LexicalNode): SerializedNode {
  const serializedNode = node.exportJSON();

  if ($isElementNode(node)) {
    const serializedChildren = (serializedNode as SerializedElementNode)
      .children;

    if (!Array.isArray(serializedChildren)) {
      throw new Error(
        `Node ${node.getType()} is an element but .exportJSON() does not have a children array.`,
      );
    }

    const children = node.getChildren();

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const serializedChildNode = $getSerializedNode(child);
      serializedChildren.push(serializedChildNode);
    }
  }

  // @ts-expect-error Same as in exportNodeToJSON
  return serializedNode;
}
