import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import { $isListNode, $isListItemNode } from '@lexical/list';
import { $getDiffState } from './DiffState';

export interface DiffChangeGroup {
  id: string;
  startNode: LexicalNode;
  endNode: LexicalNode;
  nodes: LexicalNode[];
  types: Set<'added' | 'removed' | 'modified'>;
}

/**
 * Groups diff changes intelligently:
 * - Consecutive removed+added nodes are grouped together (replacements)
 * - Adjacent nodes with the same state are grouped if any is whitespace-only
 * - Whitespace nodes (empty paragraphs) are grouped with adjacent content changes
 * - Content nodes with the same state but no whitespace between them are separate groups
 *
 * This matches user intent where:
 * - A replacement (remove old + add new) is one change
 * - Whitespace around content changes is part of the same logical change
 * - Multiple distinct content changes remain separate even if they're the same type
 */
export function groupDiffChanges(editor: LexicalEditor): DiffChangeGroup[] {
  const groups: DiffChangeGroup[] = [];
  let groupId = 0;

  editor.getEditorState().read(() => {
    const root = $getRoot();

    // Collect all nodes that have diff state in document order
    const allDiffNodes: Array<{ node: LexicalNode; state: 'added' | 'removed' | 'modified' }> = [];

    const collectDiffNodes = (node: LexicalNode) => {
      const diffState = $getDiffState(node);
      const nodeType = node.getType();
      const isLegacyDiff = nodeType === 'add' || nodeType === 'remove';

      // Check if this node has diff state
      const hasDiffState = diffState || isLegacyDiff;

      // Check if any children have diff state
      let childHasDiffState = false;
      if ($isElementNode(node)) {
        const children = node.getChildren();
        for (const child of children) {
          const childDiffState = $getDiffState(child);
          const childNodeType = child.getType();
          if (childDiffState || childNodeType === 'add' || childNodeType === 'remove') {
            childHasDiffState = true;
            break;
          }
        }
      }

      // Only collect this node if it has diff state AND no children have diff state
      // This prevents collecting parent containers when their children are the actual changes
      // IMPORTANT: Exclude 'modified' nodes - they are just metadata markers on parent containers
      if (hasDiffState && !childHasDiffState) {
        if (diffState && diffState !== 'modified') {
          allDiffNodes.push({ node, state: diffState });
        } else if (isLegacyDiff) {
          // Legacy support
          allDiffNodes.push({
            node,
            state: nodeType === 'add' ? 'added' : 'removed'
          });
        }
      }

      // Recurse into children regardless
      if ($isElementNode(node)) {
        const children = node.getChildren();
        for (const child of children) {
          collectDiffNodes(child);
        }
      }
    };

    const children = root.getChildren();
    for (const child of children) {
      collectDiffNodes(child);
    }

    // Helper to check if a node is whitespace-only (empty paragraph)
    const isWhitespaceNode = (node: LexicalNode): boolean => {
      const text = node.getTextContent();
      return text.trim().length === 0;
    };

    // Helper: are node1 and node2 siblings whose only intermediate sibling is a
    // single equal-state text node containing whitespace? This is the cosmetic
    // bridge that lets a phrase like "first paragraph" -> "FIRST PARAGRAPH"
    // (which the LCS diff splits into two remove+add pairs around the equal
    // " ") collapse into one change group. We require pure whitespace and
    // length <= 1 so longer equal middles (e.g., the unchanged interior of a
    // bullet whose bold prefix and trailing text both change) stay granular.
    const areNodesBridgedByShortWhitespace = (
      node1: LexicalNode,
      node2: LexicalNode,
    ): boolean => {
      const parent = node1.getParent();
      if (!parent || parent.getKey() !== node2.getParent()?.getKey()) {
        return false;
      }
      const between = node1.getNextSibling();
      if (!between || between.getKey() === node2.getKey()) return false;
      if (between.getNextSibling()?.getKey() !== node2.getKey()) return false;
      if (!$isTextNode(between)) return false;
      if ($getDiffState(between)) return false;
      const text = between.getTextContent();
      return text.length === 1 && /\s/.test(text);
    };

    // Helper to check if two nodes are adjacent in the document
    // Uses sibling relationships to determine visual proximity
    const areNodesAdjacent = (node1: LexicalNode, node2: LexicalNode): boolean => {
      // Direct siblings are always adjacent
      const nextSibling = node1.getNextSibling();
      if (nextSibling && nextSibling.getKey() === node2.getKey()) {
        return true;
      }

      // Check if they're consecutive children of the same parent
      const parent1 = node1.getParent();
      const parent2 = node2.getParent();

      if (!parent1 || !parent2) return false;

      // Same parent means they're siblings
      if (parent1.getKey() === parent2.getKey()) {
        // Already checked direct sibling above, so if we're here
        // they have the same parent but aren't direct siblings
        // Check if there's anything between them
        const children = parent1.getChildren();
        const idx1 = children.findIndex(c => c.getKey() === node1.getKey());
        const idx2 = children.findIndex(c => c.getKey() === node2.getKey());

        if (idx1 === -1 || idx2 === -1) return false;

        // Adjacent if they're consecutive in the children array
        return idx2 === idx1 + 1;
      }

      // Different parents - check if parent2 immediately follows parent1
      // This handles cases like consecutive list items in different lists
      const grandParent1 = parent1.getParent();
      const grandParent2 = parent2.getParent();

      if (grandParent1 && grandParent1.getKey() === grandParent2?.getKey()) {
        const parentNextSibling = parent1.getNextSibling();
        return parentNextSibling !== null && parentNextSibling.getKey() === parent2.getKey();
      }

      return false;
    };

    // Now group them intelligently
    let i = 0;
    while (i < allDiffNodes.length) {
      const current = allDiffNodes[i];
      const nodes: LexicalNode[] = [current.node];
      const types: Set<'added' | 'removed' | 'modified'> = new Set([current.state]);

      // Check if this is part of a remove+add pair (replacement)
      // The order in the tree is removed-first then added-second
      if (current.state === 'removed' && i + 1 < allDiffNodes.length) {
        const next = allDiffNodes[i + 1];

        // If next is 'added', group them together as a replacement
        // We don't check adjacency here because consecutive removed+added pairs
        // are always meant to be replacements, even if they're in different paragraphs
        if (next.state === 'added') {
          nodes.push(next.node);
          types.add(next.state);
          i += 2; // Skip both nodes

          // Continue grouping if subsequent nodes are also added and adjacent
          while (i < allDiffNodes.length &&
                 allDiffNodes[i].state === 'added' &&
                 areNodesAdjacent(nodes[nodes.length - 1], allDiffNodes[i].node)) {
            nodes.push(allDiffNodes[i].node);
            types.add(allDiffNodes[i].state);
            i++;
          }

          // Extend across consecutive remove+add pairs that the LCS diff split
          // around a single equal whitespace token (e.g. word-by-word changes
          // within one phrase). Only short whitespace bridges are collapsed --
          // longer equal segments preserve their own groups so a bullet with
          // independent prefix and suffix changes stays clickable separately.
          while (
            i + 1 < allDiffNodes.length &&
            allDiffNodes[i].state === 'removed' &&
            allDiffNodes[i + 1].state === 'added' &&
            areNodesBridgedByShortWhitespace(
              nodes[nodes.length - 1],
              allDiffNodes[i].node,
            )
          ) {
            nodes.push(allDiffNodes[i].node);
            types.add(allDiffNodes[i].state);
            i++;
            nodes.push(allDiffNodes[i].node);
            types.add(allDiffNodes[i].state);
            i++;
            while (
              i < allDiffNodes.length &&
              allDiffNodes[i].state === 'added' &&
              areNodesAdjacent(nodes[nodes.length - 1], allDiffNodes[i].node)
            ) {
              nodes.push(allDiffNodes[i].node);
              types.add(allDiffNodes[i].state);
              i++;
            }
          }
        } else {
          // Not a replacement - fall through to group with other same-state nodes
          i += 1; // Start with current node

          // Look ahead for adjacent nodes with the same state
          while (i < allDiffNodes.length) {
            const nextNode = allDiffNodes[i];

            if (nextNode.state !== current.state) {
              break;
            }

            if (!areNodesAdjacent(nodes[nodes.length - 1], nextNode.node)) {
              break;
            }

            nodes.push(nextNode.node);
            types.add(nextNode.state);
            i++;
          }
        }
      }
      // Group consecutive nodes with the same state IF they're adjacent
      else {
        i += 1; // Start with current node

        // Look ahead for adjacent nodes with the same state
        // Only group if they're actually next to each other in the document
        while (i < allDiffNodes.length) {
          const nextNode = allDiffNodes[i];

          if (nextNode.state !== current.state) {
            break;
          }

          if (!areNodesAdjacent(nodes[nodes.length - 1], nextNode.node)) {
            break;
          }

          nodes.push(nextNode.node);
          types.add(nextNode.state);
          i++;
        }
      }

      // Create the group
      groups.push({
        id: `group-${groupId++}`,
        startNode: nodes[0],
        endNode: nodes[nodes.length - 1],
        nodes,
        types,
      });
    }
  });

  return groups;
}

export function scrollToChangeGroup(
  editor: LexicalEditor,
  groupIndex: number,
  groups: DiffChangeGroup[],
): void {
  if (groupIndex < 0 || groupIndex >= groups.length) {
    return;
  }

  const group = groups[groupIndex];
  const startNode = group.startNode;

  editor.update(() => {
    try {
      const element = editor.getElementByKey(startNode.getKey());
      if (!element) {
        return;
      }

      // Use CSS scroll-margin-top to create space from the top
      // This accounts for the DiffApprovalBar (~48px) plus breathing room
      const previousScrollMargin = (element as HTMLElement).style.scrollMarginTop;
      (element as HTMLElement).style.scrollMarginTop = '100px';

      // Use scrollIntoView with block: 'start' to position element below the margin
      element.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });

      // Restore previous scroll margin after a brief delay
      // (scrollIntoView is async but doesn't return a promise)
      setTimeout(() => {
        (element as HTMLElement).style.scrollMarginTop = previousScrollMargin;
      }, 100);
    } catch (error) {
      console.warn('Failed to scroll to change group:', error);
    }
  });
}
