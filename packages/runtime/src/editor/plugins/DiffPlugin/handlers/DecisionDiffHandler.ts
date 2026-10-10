import type { ElementNode, LexicalNode, SerializedLexicalNode } from 'lexical';
import { $isDecisionNode } from '../../DecisionPlugin/DecisionNodeCore';
import type {
  DiffHandlerContext,
  DiffHandlerResult,
  DiffNodeHandler,
} from './DiffNodeHandler';
import { createNodeFromSerialized } from '../core/createNodeFromSerialized';
import {
  $clearDiffState,
  $clearOriginalMarkdown,
  $getOriginalMarkdown,
  $setDiffState,
  $setOriginalMarkdown,
} from '../core/DiffState';

/** Update a decision in place: two pending copies with one ID would share votes. */
export class DecisionDiffHandler implements DiffNodeHandler {
  readonly nodeType = 'decision';

  canHandle({ liveNode }: DiffHandlerContext): boolean {
    return $isDecisionNode(liveNode);
  }

  handleUpdate({
    liveNode,
    targetNode,
  }: DiffHandlerContext): DiffHandlerResult {
    if (
      !$isDecisionNode(liveNode) ||
      !('content' in targetNode) ||
      typeof targetNode.content !== 'string'
    ) {
      return { handled: false };
    }
    if (liveNode.getContent() !== targetNode.content) {
      // Repeated edits retain the first pre-review value for rejection.
      if ($getOriginalMarkdown(liveNode) === null) {
        $setOriginalMarkdown(liveNode, liveNode.getContent());
      }
      liveNode.setContent(targetNode.content);
      $setDiffState(liveNode, 'modified');
    }
    return { handled: true, skipChildren: true };
  }

  handleAdd(
    targetNode: SerializedLexicalNode,
    parentNode: ElementNode,
    position: number
  ): DiffHandlerResult {
    const node = createNodeFromSerialized(targetNode);
    if (!$isDecisionNode(node)) return { handled: false };
    $setDiffState(node, 'added');
    const next = parentNode.getChildAtIndex(position);
    if (next) next.insertBefore(node);
    else parentNode.append(node);
    return { handled: true, skipChildren: true };
  }

  handleRemove(node: LexicalNode): DiffHandlerResult {
    if (!$isDecisionNode(node)) return { handled: false };
    $setDiffState(node, 'removed');
    return { handled: true, skipChildren: true };
  }

  handleApprove(node: LexicalNode): DiffHandlerResult {
    if (!$isDecisionNode(node)) return { handled: false };
    $clearOriginalMarkdown(node);
    $clearDiffState(node);
    return { handled: true, skipChildren: true };
  }

  handleReject(node: LexicalNode): DiffHandlerResult {
    if (!$isDecisionNode(node)) return { handled: false };
    const original = $getOriginalMarkdown(node);
    if (original !== null) node.setContent(original);
    $clearOriginalMarkdown(node);
    $clearDiffState(node);
    return { handled: true, skipChildren: true };
  }
}
