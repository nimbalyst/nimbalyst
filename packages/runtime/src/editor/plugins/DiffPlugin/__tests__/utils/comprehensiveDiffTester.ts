/**
 * Comprehensive Diff Testing Utility
 *
 * Creates three separate editor instances to test the full diff workflow:
 * 1. Diff applied (showing red/green changes)
 * 2. Diff accepted (should match new markdown)
 * 3. Diff rejected (should match old markdown)
 *
 * Returns all three states with metadata for inspection and further testing.
 */

import type {LexicalEditor, LexicalNode} from 'lexical';
import type {Transformer} from '@lexical/markdown';
import {$getRoot} from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
} from '../../../../markdown';
import {applyMarkdownDiffToDocument} from '../../core/diffUtils';
import {$approveDiffs, $rejectDiffs} from '../../core/diffPluginUtils';
import {$getDiffState} from '../../core/DiffState';
import {createTestHeadlessEditor, MARKDOWN_TEST_TRANSFORMERS} from './testConfig';

export interface DiffNodeInfo {
  index: number;
  key: string;
  type: string;
  diffState: 'added' | 'removed' | 'modified' | null;
  text: string;
  textPreview: string; // First 60 chars
}

export interface DiffStats {
  totalNodes: number;
  addedNodes: number;
  removedNodes: number;
  modifiedNodes: number;
  unchangedNodes: number;
}

export interface EditorSnapshot {
  editor: LexicalEditor;
  markdown: string;
  nodes: DiffNodeInfo[];
  stats: DiffStats;
}

export interface MarkdownComparison {
  matches: boolean;
  normalizedActual: string;
  normalizedExpected: string;
  diff?: string;
}

export interface ComprehensiveDiffResult {
  // The three editor states
  withDiff: EditorSnapshot;
  afterAccept: EditorSnapshot;
  afterReject: EditorSnapshot;

  // Verification results
  acceptMatchesNew: MarkdownComparison;
  rejectMatchesOld: MarkdownComparison;

  // Success status
  success: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Normalize markdown for comparison
 */
function normalizeMarkdown(markdown: string): string {
  return markdown
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^(\s*)[\*\+](\s)/gm, '$1-$2');
}

/**
 * Compare two markdown strings
 */
function compareMarkdown(actual: string, expected: string): MarkdownComparison {
  const normalizedActual = normalizeMarkdown(actual);
  const normalizedExpected = normalizeMarkdown(expected);

  if (normalizedActual === normalizedExpected) {
    return {
      matches: true,
      normalizedActual,
      normalizedExpected,
    };
  }

  // Generate helpful diff for debugging
  const maxLen = Math.max(normalizedActual.length, normalizedExpected.length);
  let firstDiffPos = -1;
  for (let i = 0; i < maxLen; i++) {
    if (normalizedActual[i] !== normalizedExpected[i]) {
      firstDiffPos = i;
      break;
    }
  }

  const contextStart = Math.max(0, firstDiffPos - 50);
  const contextEnd = firstDiffPos + 100;

  const diff = `
First difference at position ${firstDiffPos}:

Expected (${normalizedExpected.length} chars):
...${normalizedExpected.substring(contextStart, contextEnd)}...

Actual (${normalizedActual.length} chars):
...${normalizedActual.substring(contextStart, contextEnd)}...
`;

  return {
    matches: false,
    normalizedActual,
    normalizedExpected,
    diff,
  };
}

/**
 * Collect nodes and their diff states from an editor
 */
function collectNodes(editor: LexicalEditor): DiffNodeInfo[] {
  const nodes: DiffNodeInfo[] = [];

  editor.getEditorState().read(() => {
    const root = $getRoot();
    const children = root.getChildren();

    children.forEach((child, index) => {
      const diffState = $getDiffState(child);
      const text = child.getTextContent();

      nodes.push({
        index,
        key: child.getKey(),
        type: child.getType(),
        diffState,
        text,
        textPreview: text.substring(0, 60).replace(/\n/g, ' '),
      });
    });
  });

  return nodes;
}

/**
 * Calculate diff statistics from nodes
 */
function calculateStats(nodes: DiffNodeInfo[]): DiffStats {
  return {
    totalNodes: nodes.length,
    addedNodes: nodes.filter(n => n.diffState === 'added').length,
    removedNodes: nodes.filter(n => n.diffState === 'removed').length,
    modifiedNodes: nodes.filter(n => n.diffState === 'modified').length,
    unchangedNodes: nodes.filter(n => n.diffState === null).length,
  };
}

/**
 * Create an editor snapshot with markdown and node info
 */
function createSnapshot(
  editor: LexicalEditor,
  transformers: Transformer[]
): EditorSnapshot {
  const nodes = collectNodes(editor);
  const stats = calculateStats(nodes);

  let markdown = '';
  editor.getEditorState().read(() => {
    markdown = $convertToEnhancedMarkdownString(transformers);
  });

  return {
    editor,
    markdown,
    nodes,
    stats,
  };
}

/**
 * Main comprehensive diff tester
 *
 * Creates three separate editors and applies/accepts/rejects diffs.
 * Returns all three states for inspection and verification.
 *
 * Usage:
 * ```typescript
 * const result = testComprehensiveDiff(oldMarkdown, newMarkdown);
 *
 * // Inspect diff state
 * expect(result.withDiff.stats.addedNodes).toBe(3);
 *
 * // Verify accept worked
 * expect(result.acceptMatchesNew.matches).toBe(true);
 * expect(result.afterAccept.markdown).toBe(newMarkdown);
 *
 * // Verify reject worked
 * expect(result.rejectMatchesOld.matches).toBe(true);
 * expect(result.afterReject.markdown).toBe(oldMarkdown);
 *
 * // Do custom inspections
 * const h1Node = result.withDiff.nodes.find(n =>
 *   n.type === 'heading' && n.diffState === 'added'
 * );
 * expect(h1Node.index).toBe(0); // H1 at beginning
 * ```
 */
export function testComprehensiveDiff(
  oldMarkdown: string,
  newMarkdown: string,
  transformers: Transformer[] = MARKDOWN_TEST_TRANSFORMERS
): ComprehensiveDiffResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // EDITOR 1: Diff applied (showing red/green)
  const editor1 = createTestHeadlessEditor();
  editor1.update(() => {
    const root = $getRoot();
    root.clear();
    $convertFromEnhancedMarkdownString(oldMarkdown, transformers);
  }, { discrete: true });

  try {
    applyMarkdownDiffToDocument(editor1, oldMarkdown, newMarkdown, transformers);
  } catch (error) {
    errors.push(`Failed to apply diff: ${error instanceof Error ? error.message : String(error)}`);
  }

  const withDiff = createSnapshot(editor1, transformers);

  // Verify some changes were detected (unless documents are identical)
  if (oldMarkdown.trim() !== newMarkdown.trim()) {
    const hasChanges =
      withDiff.stats.addedNodes > 0 ||
      withDiff.stats.removedNodes > 0 ||
      withDiff.stats.modifiedNodes > 0;

    if (!hasChanges) {
      warnings.push('No diff markers found, but old and new markdown differ');
    }
  }

  // EDITOR 2: Diff accepted (should match new markdown)
  const editor2 = createTestHeadlessEditor();
  editor2.update(() => {
    const root = $getRoot();
    root.clear();
    $convertFromEnhancedMarkdownString(oldMarkdown, transformers);
  }, { discrete: true });

  try {
    applyMarkdownDiffToDocument(editor2, oldMarkdown, newMarkdown, transformers);
    editor2.update(() => { $approveDiffs(); }, { discrete: true });
  } catch (error) {
    errors.push(`Failed to accept diffs: ${error instanceof Error ? error.message : String(error)}`);
  }

  const afterAccept = createSnapshot(editor2, transformers);
  const acceptMatchesNew = compareMarkdown(afterAccept.markdown, newMarkdown);

  if (!acceptMatchesNew.matches) {
    errors.push(`After accepting, markdown does not match new:${acceptMatchesNew.diff}`);
  }

  // EDITOR 3: Diff rejected (should match old markdown)
  const editor3 = createTestHeadlessEditor();
  editor3.update(() => {
    const root = $getRoot();
    root.clear();
    $convertFromEnhancedMarkdownString(oldMarkdown, transformers);
  }, { discrete: true });

  try {
    applyMarkdownDiffToDocument(editor3, oldMarkdown, newMarkdown, transformers);
    editor3.update(() => { $rejectDiffs(); }, { discrete: true });
  } catch (error) {
    errors.push(`Failed to reject diffs: ${error instanceof Error ? error.message : String(error)}`);
  }

  const afterReject = createSnapshot(editor3, transformers);
  const rejectMatchesOld = compareMarkdown(afterReject.markdown, oldMarkdown);

  if (!rejectMatchesOld.matches) {
    errors.push(`After rejecting, markdown does not match old:${rejectMatchesOld.diff}`);
  }

  return {
    withDiff,
    afterAccept,
    afterReject,
    acceptMatchesNew,
    rejectMatchesOld,
    success: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Print a comprehensive report for debugging
 */
export function printDiffReport(result: ComprehensiveDiffResult): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════');
  lines.push('            COMPREHENSIVE DIFF REPORT');
  lines.push('═══════════════════════════════════════════════════════\n');

  // Status
  lines.push(`Status: ${result.success ? '✓ SUCCESS' : '✗ FAILED'}`);
  if (result.errors.length > 0) {
    lines.push(`\nErrors (${result.errors.length}):`);
    result.errors.forEach(err => lines.push(`  • ${err}`));
  }
  if (result.warnings.length > 0) {
    lines.push(`\nWarnings (${result.warnings.length}):`);
    result.warnings.forEach(warn => lines.push(`  • ${warn}`));
  }
  lines.push('');

  // Stats comparison
  lines.push('───────────────────────────────────────────────────────');
  lines.push('                    STATISTICS');
  lines.push('───────────────────────────────────────────────────────');
  lines.push(`                 Diff    Accept  Reject`);
  lines.push(`Total nodes:     ${String(result.withDiff.stats.totalNodes).padEnd(7)} ${String(result.afterAccept.stats.totalNodes).padEnd(7)} ${result.afterReject.stats.totalNodes}`);
  lines.push(`Added:           ${String(result.withDiff.stats.addedNodes).padEnd(7)} ${String(result.afterAccept.stats.addedNodes).padEnd(7)} ${result.afterReject.stats.addedNodes}`);
  lines.push(`Removed:         ${String(result.withDiff.stats.removedNodes).padEnd(7)} ${String(result.afterAccept.stats.removedNodes).padEnd(7)} ${result.afterReject.stats.removedNodes}`);
  lines.push(`Modified:        ${String(result.withDiff.stats.modifiedNodes).padEnd(7)} ${String(result.afterAccept.stats.modifiedNodes).padEnd(7)} ${result.afterReject.stats.modifiedNodes}`);
  lines.push(`Unchanged:       ${String(result.withDiff.stats.unchangedNodes).padEnd(7)} ${String(result.afterAccept.stats.unchangedNodes).padEnd(7)} ${result.afterReject.stats.unchangedNodes}`);
  lines.push('');

  // Verification results
  lines.push('───────────────────────────────────────────────────────');
  lines.push('                  VERIFICATION');
  lines.push('───────────────────────────────────────────────────────');
  lines.push(`Accept matches new: ${result.acceptMatchesNew.matches ? '✓' : '✗'}`);
  lines.push(`Reject matches old: ${result.rejectMatchesOld.matches ? '✓' : '✗'}`);
  lines.push('');

  // Node details for diff state
  lines.push('───────────────────────────────────────────────────────');
  lines.push('              NODES WITH DIFF STATE');
  lines.push('───────────────────────────────────────────────────────');
  result.withDiff.nodes.forEach(node => {
    if (node.diffState) {
      const icon =
        node.diffState === 'added' ? '➕' :
        node.diffState === 'removed' ? '➖' :
        '🔄';
      lines.push(`[${node.index}] ${icon} ${node.type}: "${node.textPreview}"`);
    }
  });
  lines.push('');

  lines.push('═══════════════════════════════════════════════════════');

  return lines.join('\n');
}
