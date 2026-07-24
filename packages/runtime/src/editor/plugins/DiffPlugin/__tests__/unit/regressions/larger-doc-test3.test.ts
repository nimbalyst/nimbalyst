/**
 * Test for large document with many changes - test3
 * This reveals the bug where unchanged content gets marked as modified
 */

import {describe, expect, it} from 'vitest';
import {$getRoot} from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
} from '../../../../../markdown/index';
import {createTestHeadlessEditor, MARKDOWN_TEST_TRANSFORMERS} from '../../utils/testConfig';
import {applyMarkdownDiffToDocument} from '../../../core/diffUtils';
import {$getDiffState} from '../../../core/DiffState';
import * as fs from 'fs';
import * as path from 'path';

describe('Larger document test3 - plan with many changes', () => {
  it('should NOT mark identical Risk sections as modified', () => {
    const oldMarkdown = fs.readFileSync(
      path.join(__dirname, '../larger/test3-old.md'),
      'utf8'
    );
    const newMarkdown = fs.readFileSync(
      path.join(__dirname, '../larger/test3-new.md'),
      'utf8'
    );

    const editor = createTestHeadlessEditor();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    console.log('\n=== TEST3 LARGE DOC WITH MANY CHANGES ===');

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

    // Find the "Risks and Mitigation" section
    const riskNodes = allNodes.filter(n =>
      n.text.includes('Risk:') || n.text.includes('Mitigation:')
    );

    console.log(`\n=== RISK SECTION NODES (${riskNodes.length}) ===`);
    riskNodes.forEach((n, i) => {
      const icon = n.diffState === null ? '✓' :
                   n.diffState === 'added' ? '➕' :
                   n.diffState === 'removed' ? '➖' :
                   n.diffState === 'modified' ? '🔄' : '?';
      console.log(`[${i}] ${icon} ${n.text.substring(0, 60)}`);
    });

    // The last 3 risk/mitigation pairs should be IDENTICAL between old and new
    // They are at the end of both documents:
    // - "Risk": Zhang-Shasha might be slow on large documents
    // - "Risk": Tree structure conversion might be complex
    // - "Risk": Tests might not catch all edge cases

    const identicalRisks = [
      'Zhang-Shasha might be slow',
      'Tree structure conversion might be complex',
      'Tests might not catch all edge cases',
    ];

    for (const riskText of identicalRisks) {
      const riskNode = allNodes.find(n => n.text.includes(riskText));
      const mitigationNode = allNodes.find(n =>
        n.text.includes('Mitigation:') &&
        allNodes.indexOf(n) === allNodes.indexOf(riskNode!) + 1
      );

      if (riskNode) {
        console.log(`\nChecking: "${riskText.substring(0, 30)}..."`);
        console.log(`  Risk diffState: ${riskNode.diffState}`);
        console.log(`  Mitigation diffState: ${mitigationNode?.diffState}`);

        // CRITICAL TEST: These should NOT be marked as modified!
        if (riskNode.diffState === 'modified') {
          console.log(`  ❌ IDENTICAL RISK MARKED AS MODIFIED!`);
        }
        if (mitigationNode?.diffState === 'modified') {
          console.log(`  ❌ IDENTICAL MITIGATION MARKED AS MODIFIED!`);
        }
      }
    }

    // The test: NO identical content should be marked as modified
    const identicalMarkedModified = riskNodes.filter(n =>
      identicalRisks.some(text => n.text.includes(text)) &&
      n.diffState === 'modified'
    );

    console.log(`\n=== RESULT ===`);
    if (identicalMarkedModified.length > 0) {
      console.log(`❌ ${identicalMarkedModified.length} identical nodes marked as modified!`);
      identicalMarkedModified.forEach(n => {
        console.log(`  - ${n.text.substring(0, 60)}`);
      });
    } else {
      console.log(`✓ All identical nodes correctly unmarked`);
    }

    expect(identicalMarkedModified.length).toBe(0);
  });
});
