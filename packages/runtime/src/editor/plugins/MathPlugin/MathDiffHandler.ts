/**
 * MathDiffHandler - Handles diffs for math nodes (block and inline).
 * Math nodes are treated as atomic units - if the equation differs,
 * we show the whole node as removed and add a new one.
 */

import type { DiffNodeHandler, DiffHandlerContext, DiffHandlerResult } from '../DiffPlugin/handlers/DiffNodeHandler';
import type { NodeStructureValidator } from '../DiffPlugin/core/NodeStructureValidator';
import type { ElementNode, LexicalNode } from 'lexical';
import type { SerializedLexicalNode } from 'lexical';
import { $setDiffState, $clearDiffState, $getDiffState } from '../DiffPlugin/core/DiffState';
import { createNodeFromSerialized } from '../DiffPlugin/core/createNodeFromSerialized';
import { $isMathNode } from './MathNode';
import { $isInlineMathNode } from './InlineMathNode';

function $isMathLikeNode(node: LexicalNode | null | undefined): boolean {
  return $isMathNode(node) || $isInlineMathNode(node);
}

function getEquation(node: any): string {
  return node?.equation || node?.__equation || '';
}

export class MathDiffHandler implements DiffNodeHandler {
  readonly nodeType = 'math';

  canHandle(context: DiffHandlerContext): boolean {
    return $isMathLikeNode(context.liveNode);
  }

  handleUpdate(context: DiffHandlerContext): DiffHandlerResult {
    const { liveNode, sourceNode, targetNode } = context;

    if (!$isMathLikeNode(liveNode)) {
      return { handled: false };
    }

    const sourceEquation = getEquation(sourceNode);
    const targetEquation = getEquation(targetNode);

    if (sourceEquation !== targetEquation) {
      $setDiffState(liveNode, 'removed');

      const newNode = createNodeFromSerialized(targetNode);
      if (newNode) {
        $setDiffState(newNode, 'added');
        liveNode.insertAfter(newNode);
        return { handled: true, skipChildren: true };
      }
    }

    return { handled: true, skipChildren: true };
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
        return { handled: false };
      }

      $setDiffState(newNode, 'added');

      const children = parentNode.getChildren();
      if (position < children.length) {
        children[position].insertBefore(newNode);
      } else {
        parentNode.append(newNode);
      }

      return { handled: true };
    } catch (error) {
      return { error: String(error), handled: false };
    }
  }

  handleRemove(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    try {
      if ($isMathLikeNode(liveNode)) {
        $setDiffState(liveNode, 'removed');
        return { handled: true };
      }
      return { handled: false };
    } catch (error) {
      return { error: String(error), handled: false };
    }
  }

  handleApprove(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    if ($isMathLikeNode(liveNode)) {
      const diffState = $getDiffState(liveNode);
      if (diffState === 'added') {
        $clearDiffState(liveNode);
      } else if (diffState === 'removed') {
        liveNode.remove();
      } else {
        $clearDiffState(liveNode);
      }
      return { handled: true, skipChildren: true };
    }
    return { handled: false };
  }

  handleReject(
    liveNode: LexicalNode,
    validator: NodeStructureValidator,
  ): DiffHandlerResult {
    if ($isMathLikeNode(liveNode)) {
      const diffState = $getDiffState(liveNode);
      if (diffState === 'added') {
        liveNode.remove();
      } else if (diffState === 'removed') {
        $clearDiffState(liveNode);
      } else {
        $clearDiffState(liveNode);
      }
      return { handled: true, skipChildren: true };
    }
    return { handled: false };
  }
}
