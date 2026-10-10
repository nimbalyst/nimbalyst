/**
 * Markdown import/export for column layouts, as HTML wrappers around plain
 * markdown (the same approach as `<details>` for collapsibles):
 *
 *   <div data-columns="1fr 1fr">
 *   <div data-column>
 *
 *   Left column **markdown**
 *
 *   </div>
 *   <div data-column>
 *
 *   - right column
 *
 *   </div>
 *   </div>
 *
 * The blank lines keep the inner markdown parseable by CommonMark renderers,
 * which otherwise treat everything up to the next blank line as raw HTML.
 *
 * Parameterized by the transformer set used for column content, like
 * `createTableTransformer`, so it stays loadable without React.
 */

import type { MultilineElementTransformer, Transformer } from '@lexical/markdown';
import type { LexicalNode } from 'lexical';

import { $convertNodeToEnhancedMarkdownString } from '../../markdown/EnhancedMarkdownExport';
import { $convertFromEnhancedMarkdownString } from '../../markdown/EnhancedMarkdownImport';
import { $createLayoutContainerNode, $isLayoutContainerNode, LayoutContainerNode } from './LayoutContainerNode';
import { $createLayoutItemNode, $isLayoutItemNode, LayoutItemNode } from './LayoutItemNode';

const COLUMNS_START_REGEX = /^<div\s+data-columns="([^"]*)"\s*>\s*$/;
const COLUMN_OPEN_REGEX = /^<div\s+data-column\s*>\s*$/;
const DIV_CLOSE_LINE_REGEX = /^<\/div>\s*$/;
const DIV_OPEN_TAG_REGEX = /<div\b[^>]*>/gi;
const DIV_CLOSE_TAG_REGEX = /<\/div\s*>/gi;
const FENCE_OPEN_REGEX = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_REGEX = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

interface Fence {
  char: string;
  length: number;
}

/** A CommonMark fence opener; a backtick fence's info string may not contain a backtick. */
function openFence(line: string): Fence | null {
  const match = line.match(FENCE_OPEN_REGEX);
  if (!match) return null;
  const char = match[1][0];
  if (char === '`' && match[2].includes('`')) return null;
  return { char, length: match[1].length };
}

/** Closed only by the same character, at least as long, with nothing after it. */
function closesFence(line: string, fence: Fence): boolean {
  const match = line.match(FENCE_CLOSE_REGEX);
  return !!match && match[1][0] === fence.char && match[1].length >= fence.length;
}

function countMatches(line: string, regex: RegExp): number {
  return line.match(regex)?.length ?? 0;
}

/**
 * Finds the column bodies of the layout opening at `startLineIndex`. Returns
 * null whenever consuming the wrapper could drop a line -- unterminated, no
 * columns, text between column wrappers, or a `</div>` that would end a
 * column mid-line -- so the lines import as ordinary text instead.
 *
 * Inside a column, `<div>` and `</div>` tags are counted wherever they sit on
 * a line, and fenced code is skipped, so only the column's own closing line
 * ends it.
 */
function scanColumns(
  lines: string[],
  startLineIndex: number,
): { columns: string[][]; endLineIndex: number } | null {
  const columns: string[][] = [];
  let current: string[] = [];
  let depth = 1;
  let fence: Fence | null = null;

  for (let i = startLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    if (depth === 1) {
      if (COLUMN_OPEN_REGEX.test(line)) {
        depth = 2;
        current = [];
        columns.push(current);
      } else if (DIV_CLOSE_LINE_REGEX.test(line)) {
        return columns.length > 0 ? { columns, endLineIndex: i } : null;
      } else if (line.trim() !== '') {
        return null;
      }
      continue;
    }

    if (fence) {
      if (closesFence(line, fence)) fence = null;
      current.push(line);
      continue;
    }
    const opened = openFence(line);
    if (opened) {
      fence = opened;
      current.push(line);
      continue;
    }
    if (depth === 2 && DIV_CLOSE_LINE_REGEX.test(line)) {
      depth = 1;
      continue;
    }
    depth += countMatches(line, DIV_OPEN_TAG_REGEX) - countMatches(line, DIV_CLOSE_TAG_REGEX);
    if (depth < 2) return null;
    current.push(line);
  }
  return null;
}

export function createLayoutTransformer(
  getTransformers: () => Transformer[],
): MultilineElementTransformer {
  return {
    dependencies: [LayoutContainerNode, LayoutItemNode],
    export: (node: LexicalNode) => {
      if (!$isLayoutContainerNode(node)) return null;
      const output = [`<div data-columns="${node.getTemplateColumns()}">`];
      for (const item of node.getChildren()) {
        if (!$isLayoutItemNode(item)) continue;
        const body = $convertNodeToEnhancedMarkdownString(getTransformers(), item);
        output.push('<div data-column>', ...(body ? ['', body, ''] : []), '</div>');
      }
      output.push('</div>');
      return output.join('\n');
    },
    regExpStart: COLUMNS_START_REGEX,
    regExpEnd: undefined,
    handleImportAfterStartMatch: ({ lines, rootNode, startLineIndex, startMatch }) => {
      const scanned = scanColumns(lines, startLineIndex);
      if (!scanned) return null;

      const container = $createLayoutContainerNode(startMatch[1]);
      for (const columnLines of scanned.columns) {
        const item = $createLayoutItemNode();
        const body = columnLines.join('\n').replace(/^\n+|\n+$/g, '');
        if (body) {
          $convertFromEnhancedMarkdownString(body, getTransformers(), item, true, false);
        }
        container.append(item);
      }
      rootNode.append(container);
      return [true, scanned.endLineIndex];
    },
    replace: () => false,
    type: 'multiline-element',
  };
}
