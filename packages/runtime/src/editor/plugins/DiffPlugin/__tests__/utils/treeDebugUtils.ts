/**
 * Utility to print the node tree with diff states for debugging tests
 * Similar to TreeViewPlugin but outputs plain text for console
 */

import { LexicalEditor, LexicalNode, $getRoot, $isElementNode } from 'lexical';
import { $getDiffState } from '../../core/DiffState';

interface TreeNodeInfo {
  key: string;
  type: string;
  text: string;
  diffState: string | null;
  children: TreeNodeInfo[];
}

/**
 * Recursively builds a tree structure of nodes with their diff states
 */
function buildNodeTree(node: LexicalNode): TreeNodeInfo {
  const diffState = $getDiffState(node);
  const type = node.getType();
  const key = node.getKey();

  let text = '';
  if ('getTextContent' in node && typeof node.getTextContent === 'function') {
    const fullText = node.getTextContent();
    // Truncate long text to keep output readable
    text = fullText.length > 50
      ? fullText.substring(0, 50) + '...'
      : fullText;
    // Escape newlines
    text = JSON.stringify(text).slice(1, -1);
  }

  const children: TreeNodeInfo[] = [];
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      children.push(buildNodeTree(child));
    }
  }

  return { key, type, text, diffState, children };
}

/**
 * Formats a tree node as a string with indentation
 */
function formatTreeNode(
  node: TreeNodeInfo,
  indent: string = '',
  isLast: boolean = true
): string {
  const prefix = indent + (isLast ? '└─ ' : '├─ ');
  const childIndent = indent + (isLast ? '   ' : '│  ');

  let line = `${prefix}(${node.key}) ${node.type}`;

  if (node.text) {
    line += ` "${node.text}"`;
  }

  if (node.diffState) {
    line += ` [${node.diffState}]`;
  }

  const lines = [line];

  for (let i = 0; i < node.children.length; i++) {
    const isLastChild = i === node.children.length - 1;
    lines.push(formatTreeNode(node.children[i], childIndent, isLastChild));
  }

  return lines.join('\n');
}

/**
 * Prints the entire editor tree with diff states to console
 * Useful for debugging diff test failures
 */
export function printEditorTree(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => {
    const root = $getRoot();
    const lines = ['root'];

    for (let i = 0; i < root.getChildren().length; i++) {
      const child = root.getChildren()[i];
      const isLast = i === root.getChildren().length - 1;
      lines.push(formatTreeNode(buildNodeTree(child), '', isLast));
    }

    return lines.join('\n');
  });
}

/**
 * Prints a summary of nodes by diff state
 */
export function printDiffStateSummary(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => {
    const root = $getRoot();
    const stats = {
      added: 0,
      removed: 0,
      modified: 0,
      unchanged: 0,
      total: 0
    };

    const addedNodes: string[] = [];
    const removedNodes: string[] = [];

    function traverse(node: LexicalNode) {
      stats.total++;
      const diffState = $getDiffState(node);

      if (diffState === 'added') {
        stats.added++;
        addedNodes.push(`(${node.getKey()}) ${node.getType()}`);
      } else if (diffState === 'removed') {
        stats.removed++;
        removedNodes.push(`(${node.getKey()}) ${node.getType()}`);
      } else if (diffState === 'modified') {
        stats.modified++;
      } else {
        stats.unchanged++;
      }

      if ($isElementNode(node)) {
        for (const child of node.getChildren()) {
          traverse(child);
        }
      }
    }

    for (const child of root.getChildren()) {
      traverse(child);
    }

    const lines = [
      '=== Diff State Summary ===',
      `Total nodes: ${stats.total}`,
      `Added: ${stats.added}`,
      `Removed: ${stats.removed}`,
      `Modified: ${stats.modified}`,
      `Unchanged: ${stats.unchanged}`,
      ''
    ];

    if (addedNodes.length > 0) {
      lines.push('Added nodes:');
      addedNodes.slice(0, 10).forEach(n => lines.push(`  ${n}`));
      if (addedNodes.length > 10) {
        lines.push(`  ... and ${addedNodes.length - 10} more`);
      }
      lines.push('');
    }

    if (removedNodes.length > 0) {
      lines.push('Removed nodes:');
      removedNodes.slice(0, 10).forEach(n => lines.push(`  ${n}`));
      if (removedNodes.length > 10) {
        lines.push(`  ... and ${removedNodes.length - 10} more`);
      }
      lines.push('');
    }

    return lines.join('\n');
  });
}
