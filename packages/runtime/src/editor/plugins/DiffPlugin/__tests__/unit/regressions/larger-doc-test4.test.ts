/**
 * Test for test4 - minor changes causing massive diff explosion
 * This reveals the threshold sensitivity problem
 */

import {describe, expect, it} from 'vitest';
import {$getRoot} from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
} from '../../../../../markdown/index';
import {createTestHeadlessEditor, MARKDOWN_TEST_TRANSFORMERS} from '../../utils/testConfig';
import {applyMarkdownDiffToDocument} from '../../../core/diffUtils';
import {$getDiffState} from '../../../core/DiffState';
import * as fs from 'fs';
import * as path from 'path';

describe('Larger document test4 - minor changes causing diff explosion', () => {
  it('should show minimal diffs for minimal changes', () => {
    const oldMarkdown = fs.readFileSync(
      path.join(__dirname, '../larger/test4-old.md'),
      'utf8'
    );
    const newMarkdown = fs.readFileSync(
      path.join(__dirname, '../larger/test4-new.md'),
      'utf8'
    );

    const editor = createTestHeadlessEditor();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    console.log('\n=== TEST4 DIFF EXPLOSION ===');

    // Apply diff
    applyMarkdownDiffToDocument(editor, oldMarkdown, newMarkdown, MARKDOWN_TEST_TRANSFORMERS);

    // Collect all nodes and their diff states
    const allNodes: Array<{type: string; text: string; diffState: any}> = [];
    editor.getEditorState().read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      for (const child of children) {
        const diffState = $getDiffState(child);
        const text = child.getTextContent();
        allNodes.push({
          type: child.getType(),
          text,
          diffState,
        });
      }
    });

    console.log(`\nTotal nodes: ${allNodes.length}`);

    const byState = {
      null: allNodes.filter(n => n.diffState === null).length,
      added: allNodes.filter(n => n.diffState === 'added').length,
      removed: allNodes.filter(n => n.diffState === 'removed').length,
      modified: allNodes.filter(n => n.diffState === 'modified').length,
    };

    console.log(`Unchanged (null): ${byState.null}`);
    console.log(`Added: ${byState.added}`);
    console.log(`Removed: ${byState.removed}`);
    console.log(`Modified: ${byState.modified}`);

    const totalChanges = byState.added + byState.removed + byState.modified;
    console.log(`Total changes: ${totalChanges}`);

    // The actual changes in the file:
    // 1. Line 13: "~600" → "\~600" (escaped tilde)
    // 2. Line 22-23: Table formatting change (| vs |---|)
    // 3. Line 210: "~100" → "\~100" (escaped tilde)
    //
    // Expected: ~3-6 modified nodes
    // Actual: 45 edits (WRONG!)

    console.log('\n=== CHANGED NODES ===');
    allNodes
      .filter(n => n.diffState !== null)
      .forEach((n, i) => {
        const icon = n.diffState === 'added' ? '➕' :
                     n.diffState === 'removed' ? '➖' :
                     n.diffState === 'modified' ? '🔄' : '?';
        const preview = n.text.substring(0, 60).replace(/\n/g, ' ');
        console.log(`[${i}] ${icon} ${n.type}: "${preview}"`);
      });

    console.log('\n=== RESULT ===');
    if (totalChanges > 10) {
      console.log(`❌ Diff explosion! ${totalChanges} changes for ~3 actual changes`);
    } else {
      console.log(`✓ Reasonable diff size: ${totalChanges} changes`);
    }

    // This test will fail until we fix the threshold sensitivity
    // The problem: small changes early in the document cause massive misalignment
    expect(totalChanges).toBeLessThan(10);
  });
});
