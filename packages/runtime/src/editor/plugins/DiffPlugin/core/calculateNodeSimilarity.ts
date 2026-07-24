/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type {
  LexicalNode,
  SerializedLexicalNode,
  SerializedTextNode,
} from 'lexical';

import { $convertToEnhancedMarkdownString, getEditorTransformers } from '../../../markdown';
import {$isElementNode} from 'lexical';
import { $convertNodeToEnhancedMarkdownString } from "../../../markdown";

/**
 * Calculate similarity between two nodes based on content and structure
 */
export function $calculateNodeSimilarity(
  sourceNode: SerializedLexicalNode,
  targetNode: SerializedLexicalNode,
): number {
  // Different types can never match - this is critical for preserving structure
  if (getNodeType(sourceNode) !== getNodeType(targetNode)) {
    return 0;
  }

  // Get markdown content for comparison (this preserves structure like links, formatting, etc.)
  const sourceMarkdown = $getNodeMarkdown(sourceNode);
  const targetMarkdown = $getNodeMarkdown(targetNode);

  // Empty nodes have special handling
  if (sourceMarkdown.trim() === '' && targetMarkdown.trim() === '') {
    return 1.0; // Empty nodes of same type are considered identical
  }

  // For list items, check for identical list marker types to preserve structure
  if (sourceNode.type === 'listitem' && targetNode.type === 'listitem') {
    // If we can access list marker type, compare it
    const sourceListType =
      'listType' in sourceNode ? sourceNode.listType : null;
    const targetListType =
      'listType' in targetNode ? targetNode.listType : null;

    if (sourceListType && targetListType && sourceListType !== targetListType) {
      // Different list types should have lower similarity
      return contentSimilarity(sourceMarkdown, targetMarkdown) * 0.7;
    }
  }

  // Compute markdown similarity score
  return contentSimilarity(sourceMarkdown, targetMarkdown);
}
/** @deprecated renamed to {@link $calculateNodeSimilarity} by @lexical/eslint-plugin rules-of-lexical */
export const calculateNodeSimilarity = $calculateNodeSimilarity;

/**
 * Helper to get node type regardless of whether it's a live or serialized node
 */
export function getNodeType(node: LexicalNode | SerializedLexicalNode): string {
  if ('type' in node) {
    return node.type;
  } else {
    return node.getType();
  }
}

/**
 * Helper to get node content regardless of whether it's a live or serialized node
 * Recursively extracts text from all nested elements
 */
export function getNodeContent(
  node: LexicalNode | SerializedLexicalNode,
): string {
  if ('getTextContent' in node && typeof node.getTextContent === 'function') {
    return node.getTextContent();
  } else if ('type' in node) {
    if (node.type === 'text' && 'text' in node) {
      return (node as SerializedTextNode).text;
    } else if ('children' in node && Array.isArray(node.children)) {
      // Include checkbox state for list items so similarity computation
      // detects check/uncheck changes (otherwise [ ] and [x] both produce
      // identical text content and the diff system considers them "exact")
      let prefix = '';
      if (node.type === 'listitem' && typeof (node as any).checked === 'boolean') {
        prefix = (node as any).checked ? 'checked ' : 'unchecked ';
      }
      // Recursively extract text from all children, including nested elements
      return prefix + node.children.map((child) => getNodeContent(child)).join('');
    }
  }
  return '';
}

/**
 * Get markdown representation of a node (preserves structure like links, formatting, etc.)
 * For live nodes, this should be called within an editor context
 * For serialized nodes, falls back to enhanced text content with special handling for links
 */
export function $getNodeMarkdown(
  node: LexicalNode | SerializedLexicalNode,
): string {
  // For live nodes, use $convertToMarkdownString on the node directly
  if ('getTextContent' in node && typeof node.getTextContent === 'function') {
    if ($isElementNode(node)) {
      return $convertNodeToEnhancedMarkdownString(getEditorTransformers(), node);
    } else {
      // For text nodes, we need to check if parent has special formatting like links
      // Since we can't access parent from here, return text content
      // The TreeMatcher handles this case by converting parent instead
      return node.getTextContent();
    }
  }

  // For serialized nodes, use enhanced text content with special cases
  if ('type' in node) {
    // For simple text nodes, return the text directly
    if (node.type === 'text' && 'text' in node) {
      return (node as SerializedTextNode).text;
    }

    // For link nodes, include the URL in the content for better matching
    if (node.type === 'link' && 'url' in node) {
      const textContent = getNodeContent(node);
      const url = (node as any).url;
      return `[${textContent}](${url})`;
    }

    // For all other element nodes, just return text content
    // Don't try to reimplement markdown transform logic here
    return getNodeContent(node);
  }

  return '';
}
/** @deprecated renamed to {@link $getNodeMarkdown} by @lexical/eslint-plugin rules-of-lexical */
export const getNodeMarkdown = $getNodeMarkdown;

/**
 * Calculate simple content similarity between texts
 */
export function contentSimilarity(text1: string, text2: string): number {
  if (text1 === text2) {
    return 1;
  }
  if (text1.length === 0 || text2.length === 0) {
    return 0;
  }

  // Split into words and count matches
  const words1 = text1.split(/\s+/).filter((w) => w.length > 0);
  const words2 = text2.split(/\s+/).filter((w) => w.length > 0);

  if (words1.length === 0 || words2.length === 0) {
    return 0;
  }

  let matches = 0;
  for (const word of words1) {
    if (words2.includes(word)) {
      matches++;
    }
  }

  return matches / Math.max(words1.length, words2.length);
}
