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
import type {NodeStructureValidator} from '../core/NodeStructureValidator';

/**
 * Custom handler that ignores all changes within specified element types
 * Useful for preserving certain content blocks during diff operations
 */
export class NoopDiffHandler implements DiffNodeHandler {
  readonly nodeType = 'ignore';

  private ignoredNodeTypes: Set<string>;

  constructor(nodeTypesToIgnore: string[] = []) {
    this.ignoredNodeTypes = new Set(nodeTypesToIgnore);
  }

  /**
   * Add a node type to ignore
   */
  addIgnoredType(nodeType: string): void {
    this.ignoredNodeTypes.add(nodeType);
  }

  /**
   * Remove a node type from ignore list
   */
  removeIgnoredType(nodeType: string): void {
    this.ignoredNodeTypes.delete(nodeType);
  }

  /**
   * Check if this handler should process the given context
   */
  canHandle(context: DiffHandlerContext): boolean {
    const {liveNode, sourceNode, targetNode} = context;

    // Check if any of the node types should be ignored
    return (
      this.ignoredNodeTypes.has(liveNode.getType()) ||
      this.ignoredNodeTypes.has(sourceNode.type) ||
      this.ignoredNodeTypes.has(targetNode.type)
    );
  }

  /**
   * Handle update operations - ignore all changes
   */
  handleUpdate(context: DiffHandlerContext): DiffHandlerResult {
    // Simply mark as handled without making any changes
    // This preserves the original content exactly as-is
    return {
      handled: true,
      skipChildren: true, // Don't process children either
    };
  }

  /**
   * Handle add operations - ignore new additions
   */
  handleAdd(
    targetNode: SerializedLexicalNode,
    parentNode: ElementNode,
    position: number,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    // Don't add anything for ignored node types
    return {
      handled: true,
    };
  }

  /**
   * Handle remove operations - ignore removals
   */
  handleRemove(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    // Don't remove anything for ignored node types
    return {
      handled: true,
    };
  }

  /**
   * Handle approve operations - no diff nodes to approve since we ignored changes
   */
  handleApprove?(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    // Since we ignored all changes, there should be no diff nodes to approve
    return {
      handled: true,
      skipChildren: true,
    };
  }

  /**
   * Handle reject operations - no diff nodes to reject since we ignored changes
   */
  handleReject?(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    // Since we ignored all changes, there should be no diff nodes to reject
    return {
      handled: true,
      skipChildren: true,
    };
  }
}
