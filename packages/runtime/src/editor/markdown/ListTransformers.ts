/**
 * List transformers for markdown import/export with dynamic depth detection.
 * Supports flexible indentation on import (2-4 spaces) and configurable export.
 */

import type { ElementTransformer } from '@lexical/markdown';
import type { ListType } from '@lexical/list';
import type { ElementNode, LexicalNode } from 'lexical';

import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListNode,
  ListItemNode,
} from '@lexical/list';

import { $getDiffState } from '../plugins/DiffPlugin/core/DiffState';

// Regex patterns for different list types
export const ORDERED_LIST_REGEX = /^(\s*)(\d{1,})\.\s/;
export const UNORDERED_LIST_REGEX = /^(\s*)[-*+]\s/;
export const CHECK_LIST_REGEX = /^(\s*)(?:-\s)?\s?(\[(\s|x)?\])\s/i;

/**
 * Configuration for list import/export
 */
export interface ListConfig {
  // Number of spaces per indent level for export (default: 2)
  exportIndentSize?: number;
  // Minimum spaces to count as one indent level for import (default: 2)
  importMinIndentSize?: number;
  // Maximum spaces to count as one indent level for import (default: 4)
  importMaxIndentSize?: number;
  // Whether to auto-detect indent size from the document
  autoDetectIndent?: boolean;
}

// Default configuration
const DEFAULT_LIST_CONFIG: ListConfig = {
  exportIndentSize: 2,        // We use 2-space indents!
  importMinIndentSize: 2,     // Accept 2-4 space indents on import
  importMaxIndentSize: 4,
  autoDetectIndent: true,
};

// Global config that can be set
let globalListConfig: ListConfig = { ...DEFAULT_LIST_CONFIG };

// We no longer track detected indent size here since normalization handles it

/**
 * Set the global list configuration
 */
export function setListConfig(config: Partial<ListConfig>): void {
  globalListConfig = { ...DEFAULT_LIST_CONFIG, ...config };
  // No longer need to reset detected indent since normalization handles it
}

/**
 * Get the current list configuration
 */
export function getListConfig(): ListConfig {
  return { ...globalListConfig };
}

/**
 * Reset detected indent size (kept for backward compatibility)
 * @deprecated Normalization now handles indent detection
 */
export function resetDetectedIndent(): void {
  // No longer needed - kept for backward compatibility
}

// Indent detection has been moved to MarkdownNormalizer

/**
 * Calculate indent level from whitespace.
 * For import, we now assume markdown has been normalized to consistent spacing.
 * @param whitespaces The leading whitespace string
 * @param isImport Whether this is for import (true) or export (false)
 * @returns The calculated indent level
 */
export function getIndentLevel(whitespaces: string, isImport: boolean = true): number {
  const tabs = whitespaces.match(/\t/g);
  const spaces = whitespaces.match(/ /g);

  let indent = 0;

  // Tabs always count as 1 indent level
  if (tabs) {
    indent += tabs.length;
  }

  if (spaces) {
    const spaceCount = spaces.length;
    const config = getListConfig();

    if (isImport) {
      // After normalization, spaces should already be in multiples of the normalized size
      // We use the normalized indent size (default 2) to calculate levels
      const importSize = config.importMinIndentSize ?? 2;
      indent += Math.floor(spaceCount / importSize);
    } else {
      // For export, use configured size
      const exportSize = config.exportIndentSize ?? 2;
      indent += Math.floor(spaceCount / exportSize);
    }
  }

  return indent;
}

/**
 * Create the list replace function for a specific list type
 */
export function createListReplace(listType: ListType): ElementTransformer['replace'] {
  return (parentNode, children, match, isImport) => {
    const previousNode = parentNode.getPreviousSibling();
    const nextNode = parentNode.getNextSibling();
    const listItem = $createListItemNode(
      listType === 'check' ? match[3] === 'x' : undefined,
    );

    // Calculate indent FIRST, before adding to list
    const indent = getIndentLevel(match[1], true);

    if ($isListNode(nextNode) && nextNode.getListType() === listType) {
      const firstChild = nextNode.getFirstChild();
      if (firstChild !== null) {
        firstChild.insertBefore(listItem);
      } else {
        // should never happen, but let's handle gracefully, just in case.
        nextNode.append(listItem);
      }
      parentNode.remove();
    } else if (
      $isListNode(previousNode) &&
      previousNode.getListType() === listType
    ) {
      previousNode.append(listItem);
      parentNode.remove();
    } else {
      const list = $createListNode(
        listType,
        listType === 'number' ? Number(match[2]) : undefined,
      );
      list.append(listItem);
      parentNode.replace(list);
    }

    listItem.append(...children);
    if (!isImport) {
      listItem.select(0, 0);
    }

    // Set the indent level on the list item
    if (indent > 0) {
      listItem.setIndent(indent);
    }
  };
}

/**
 * Export a list node to markdown with configurable indentation
 */
export function listExport(
  listNode: ListNode,
  exportChildren: (node: ElementNode) => string,
  depth: number = 0,
  config?: ListConfig,
): string {
  const mergedConfig = { ...globalListConfig, ...config };
  const indentSize = mergedConfig.exportIndentSize ?? 2;
  const output = [];
  const children = listNode.getChildren();
  let index = 0;

  for (const listItemNode of children) {
    if ($isListItemNode(listItemNode)) {
      // Skip list items marked as removed in diff state
      const diffState = $getDiffState(listItemNode);
      if (diffState === 'removed') {
        continue;
      }

      // Check if this item contains a nested list as its only child
      if (listItemNode.getChildrenSize() === 1) {
        const firstChild = listItemNode.getFirstChild();
        if ($isListNode(firstChild)) {
          output.push(listExport(firstChild, exportChildren, depth + 1, config));
          continue;
        }
      }

      // Use the item's indent level if available, otherwise use depth
      const itemIndent = listItemNode.getIndent();
      const actualDepth = itemIndent !== undefined ? itemIndent : depth;
      const indent = ' '.repeat(actualDepth * indentSize);

      const listType = listNode.getListType();
      const prefix =
        listType === 'number'
          ? `${listNode.getStart() + index}. `
          : listType === 'check'
          ? `- [${listItemNode.getChecked() ? 'x' : ' '}] `
          : '- ';

      output.push(indent + prefix + exportChildren(listItemNode));
      index++;
    }
  }

  return output.join('\n');
}

/**
 * Create a list transformer for a specific list type
 */
export function createListTransformer(
  listType: ListType,
  regex: RegExp,
): ElementTransformer {
  return {
    dependencies: [ListNode, ListItemNode],
    export: (node: LexicalNode, exportChildren: (node: ElementNode) => string) => {
      if (!$isListNode(node)) {
        return null;
      }
      return listExport(node, exportChildren, 0, getListConfig());
    },
    regExp: regex,
    replace: createListReplace(listType),
    type: 'element',
  };
}

// Export the list transformers
export const UNORDERED_LIST: ElementTransformer = createListTransformer(
  'bullet',
  UNORDERED_LIST_REGEX,
);

export const ORDERED_LIST: ElementTransformer = createListTransformer(
  'number',
  ORDERED_LIST_REGEX,
);

export const CHECK_LIST: ElementTransformer = createListTransformer(
  'check',
  CHECK_LIST_REGEX,
);