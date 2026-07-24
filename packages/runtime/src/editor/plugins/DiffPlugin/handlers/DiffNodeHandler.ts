/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {NodeStructureValidator} from '../core/NodeStructureValidator';
import type {
  ElementNode,
  LexicalEditor,
  LexicalNode,
  SerializedLexicalNode,
} from 'lexical';
import type {Transformer} from '@lexical/markdown';
import type {WindowedTreeMatcher} from '../core/TreeMatcher';

/**
 * Result of a diff handler operation
 */
export type DiffHandlerResult = {
  /** Whether the handler processed the node */
  handled: boolean;
  /** Whether children should be skipped (for complex diff operations) */
  skipChildren?: boolean;
  /** Any error that occurred during handling */
  error?: string;
};

/**
 * Context provided to diff handlers
 */
export type DiffHandlerContext = {
  /** The live node being updated */
  liveNode: LexicalNode;
  /** The source serialized node */
  sourceNode: SerializedLexicalNode;
  /** The target serialized node */
  targetNode: SerializedLexicalNode;
  /** Structure validator for maintaining node relationships */
  validator: NodeStructureValidator;
  /** The type of change being applied */
  changeType: 'update' | 'add' | 'remove';
  /** Source editor for recursive sub-tree diffing (optional) */
  sourceEditor?: LexicalEditor;
  /** Target editor for recursive sub-tree diffing (optional) */
  targetEditor?: LexicalEditor;
  /** Transformers for markdown conversion in recursive diffing (optional) */
  transformers?: Array<Transformer>;
  /** TreeMatcher with pre-cached node data (optional) */
  treeMatcher?: WindowedTreeMatcher;
};

/**
 * Base interface for node-specific diff handlers
 */
export interface DiffNodeHandler {
  /**
   * The node type this handler supports
   */
  readonly nodeType: string;

  /**
   * Check if this handler can process the given context
   */
  canHandle(context: DiffHandlerContext): boolean;

  /**
   * Apply an update to an existing node
   */
  handleUpdate(context: DiffHandlerContext): DiffHandlerResult;

  /**
   * Handle adding a new node
   */
  handleAdd(
    targetNode: SerializedLexicalNode,
    parentNode: ElementNode,
    position: number,
    validator: NodeStructureValidator,
  ): DiffHandlerResult;

  /**
   * Handle removing a node
   */
  handleRemove(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult;

  /**
   * Handle approving diffs in a node (convert diff nodes to regular nodes)
   */
  handleApprove?(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult;

  /**
   * Handle rejecting diffs in a node (revert diff nodes to original state)
   */
  handleReject?(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult;
}

/**
 * Registry for diff node handlers
 */
export class DiffHandlerRegistry {
  private handlers = new Map<string, DiffNodeHandler>();

  /**
   * Register a handler for a specific node type
   */
  register(handler: DiffNodeHandler): void {
    this.handlers.set(handler.nodeType, handler);
  }

  /**
   * Get a handler for a specific node type
   */
  getHandler(nodeType: string): DiffNodeHandler | undefined {
    return this.handlers.get(nodeType);
  }

  /**
   * Get all registered handlers
   */
  getAllHandlers(): DiffNodeHandler[] {
    return Array.from(this.handlers.values());
  }

  /**
   * Check if a handler exists for a node type
   */
  hasHandler(nodeType: string): boolean {
    return this.handlers.has(nodeType);
  }

  /**
   * Find a handler that can process the given context
   */
  findHandler(context: DiffHandlerContext): DiffNodeHandler | undefined {
    // First try exact node type match
    const exactHandler = this.handlers.get(context.liveNode.getType());
    if (exactHandler && exactHandler.canHandle(context)) {
      return exactHandler;
    }

    // Then try all handlers to see if any can handle this context
    let foundHandler: DiffNodeHandler | undefined = undefined;
    this.handlers.forEach((handler) => {
      if (!foundHandler && handler.canHandle(context)) {
        foundHandler = handler;
      }
    });

    return foundHandler;
  }
}

/**
 * Global registry instance
 */
export const diffHandlerRegistry = new DiffHandlerRegistry();
