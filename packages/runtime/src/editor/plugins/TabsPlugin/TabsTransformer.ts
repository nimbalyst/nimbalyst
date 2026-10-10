/**
 * Markdown import/export for the tabs block. Each panel is a `<details>`
 * whose `<summary>` is the tab name, inside a `<div data-tabs>` wrapper:
 *
 *   <div data-tabs>
 *   <details data-tab>
 *   <summary>Overview</summary>
 *
 *   Panel **markdown**
 *
 *   </details>
 *   <details data-tab>
 *   <summary>API</summary>
 *
 *   - more markdown
 *
 *   </details>
 *   </div>
 *
 * `<details>` rather than a plain `<div data-tab="Name">` (the columns shape)
 * because GitHub and other viewers drop `data-*` attributes: there a panel
 * reads as a collapsible section titled with its tab name instead of an
 * unlabeled run of text. The blank lines keep the inner markdown parseable.
 *
 * Attribute text on either tag is kept verbatim, so unknown attributes (and an
 * author's `open`) survive. The opener of each tag must sit alone on its line.
 *
 * Parameterized by the transformer set used for panel content, like
 * `createLayoutTransformer`, so it stays loadable without React.
 */

import type { MultilineElementTransformer, Transformer } from '@lexical/markdown';
import type { LexicalNode } from 'lexical';

import { $convertNodeToEnhancedMarkdownString } from '../../markdown/EnhancedMarkdownExport';
import { $convertFromEnhancedMarkdownString } from '../../markdown/EnhancedMarkdownImport';
import { $createTabPanelNode, $createTabsNode, $isTabPanelNode, $isTabsNode, TabPanelNode, TabsNode } from './TabsNodes';

const TABS_START_REGEX = /^<div((?=[^>]*\sdata-tabs(?=[\s=>]))\s[^>]*)>[ \t]*$/;
const PANEL_OPEN_REGEX = /^<details((?=[^>]*\sdata-tab(?=[\s=>]))\s[^>]*)>[ \t]*$/;
const SUMMARY_REGEX = /^<summary>(.*)<\/summary>[ \t]*$/;
const DIV_CLOSE_LINE_REGEX = /^<\/div>[ \t]*$/;
const DETAILS_CLOSE_LINE_REGEX = /^<\/details>[ \t]*$/;
const OPEN_TAG_REGEX = /<(div|details)\b[^>]*>/gi;
const CLOSE_TAG_REGEX = /<\/(div|details)\s*>/gi;
const FENCE_OPEN_REGEX = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_REGEX = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

interface Fence {
  char: string;
  length: number;
}

function openFence(line: string): Fence | null {
  const match = line.match(FENCE_OPEN_REGEX);
  if (!match) return null;
  const char = match[1][0];
  if (char === '`' && match[2].includes('`')) return null;
  return { char, length: match[1].length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = line.match(FENCE_CLOSE_REGEX);
  return !!match && match[1][0] === fence.char && match[1].length >= fence.length;
}

interface ScannedPanel {
  attrs: string;
  summary: string;
  lines: string[];
}

/**
 * Finds the panels of the tabs block opening at `startLineIndex`. Returns null
 * whenever consuming the wrapper could drop a line -- unterminated, no panels,
 * text between panels, a panel without a one-line `<summary>`, or a closing
 * tag that would end a panel mid-line -- so the lines import as ordinary text
 * (where a lone `<details>` still becomes a collapsible).
 *
 * Inside a panel, `<div>`/`<details>` tags are counted wherever they sit and
 * fenced code is skipped, so only the panel's own `</details>` line ends it.
 */
export function scanTabs(lines: string[], startLineIndex: number): { panels: ScannedPanel[]; endLineIndex: number } | null {
  const panels: ScannedPanel[] = [];
  let current: ScannedPanel | null = null;
  let depth = 0;
  let fence: Fence | null = null;

  for (let i = startLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    if (!current) {
      const panelOpen = line.match(PANEL_OPEN_REGEX);
      if (panelOpen) {
        const summary = (lines[i + 1] ?? '').match(SUMMARY_REGEX);
        if (!summary) return null;
        current = { attrs: panelOpen[1], summary: summary[1], lines: [] };
        panels.push(current);
        depth = 0;
        i += 1;
      } else if (DIV_CLOSE_LINE_REGEX.test(line)) {
        return panels.length > 0 ? { panels, endLineIndex: i } : null;
      } else if (line.trim() !== '') {
        return null;
      }
      continue;
    }

    if (fence) {
      if (closesFence(line, fence)) fence = null;
      current.lines.push(line);
      continue;
    }
    const opened = openFence(line);
    if (opened) {
      fence = opened;
      current.lines.push(line);
      continue;
    }
    if (depth === 0 && DETAILS_CLOSE_LINE_REGEX.test(line)) {
      current = null;
      continue;
    }
    depth += (line.match(OPEN_TAG_REGEX)?.length ?? 0) - (line.match(CLOSE_TAG_REGEX)?.length ?? 0);
    if (depth < 0) return null;
    current.lines.push(line);
  }
  return null;
}

export function createTabsTransformer(getTransformers: () => Transformer[]): MultilineElementTransformer {
  return {
    dependencies: [TabsNode, TabPanelNode],
    export: (node: LexicalNode) => {
      if (!$isTabsNode(node)) return null;
      const output = [`<div${node.getAttrs()}>`];
      for (const panel of node.getChildren()) {
        if (!$isTabPanelNode(panel)) continue;
        const body = $convertNodeToEnhancedMarkdownString(getTransformers(), panel);
        output.push(`<details${panel.getAttrs()}>`, `<summary>${panel.getSummary()}</summary>`, ...(body ? ['', body, ''] : []), '</details>');
      }
      output.push('</div>');
      return output.join('\n');
    },
    regExpStart: TABS_START_REGEX,
    regExpEnd: undefined,
    handleImportAfterStartMatch: ({ lines, rootNode, startLineIndex, startMatch }) => {
      const scanned = scanTabs(lines, startLineIndex);
      if (!scanned) return null;

      const tabs = $createTabsNode(startMatch[1]);
      for (const scannedPanel of scanned.panels) {
        const panel = $createTabPanelNode(scannedPanel.summary, scannedPanel.attrs);
        const body = scannedPanel.lines.join('\n').replace(/^\n+|\n+$/g, '');
        if (body) $convertFromEnhancedMarkdownString(body, getTransformers(), panel, true, false);
        tabs.append(panel);
      }
      rootNode.append(tabs);
      return [true, scanned.endLineIndex];
    },
    replace: () => false,
    type: 'multiline-element',
  };
}
