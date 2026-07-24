/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable no-case-declarations, @typescript-eslint/no-explicit-any */

import type {LexicalNode, SerializedLexicalNode} from 'lexical';

import {$parseSerializedNode} from 'lexical';

/**
 * Factory to create a LexicalNode from a SerializedLexicalNode
 */
export function createNodeFromSerialized(
  serializedNode: SerializedLexicalNode,
): LexicalNode {
  // shim for debugging
  const node = $parseSerializedNode(serializedNode);

  return node;
}
