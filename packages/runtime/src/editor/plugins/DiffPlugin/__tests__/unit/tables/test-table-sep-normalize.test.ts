/**
 * Test table separator normalization
 */

import {describe, expect, it} from 'vitest';
import {$getRoot} from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
} from '../../../../../markdown/index';
import {createTestHeadlessEditor, MARKDOWN_TEST_TRANSFORMERS} from '../../utils/testConfig';
import {canonicalizeForest} from '../../../core/canonicalTree';

describe('Table separator normalization', () => {
  it('should normalize table separators to same format', () => {
    const oldMd = '|---|---|---|\n';
    const newMd = '| --- | --- | --- |\n';

    const oldEditor = createTestHeadlessEditor();
    oldEditor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMd, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    const newEditor = createTestHeadlessEditor();
    newEditor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(newMd, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    const oldTree = oldEditor.getEditorState().read(() => {
      const root = $getRoot();
      const canonical = canonicalizeForest(root.getChildren());
      return canonical;
    });

    const newTree = newEditor.getEditorState().read(() => {
      const root = $getRoot();
      const canonical = canonicalizeForest(root.getChildren());
      return canonical;
    });

    console.log('\n=== OLD TREE ===');
    console.log('Nodes:', oldTree.length);
    oldTree.forEach((node, i) => {
      console.log(`[${i}] type=${node.type}, text="${node.text}"`);
      if (node.children) {
        node.children.forEach((child, ci) => {
          console.log(`  [${ci}] type=${child.type}, text="${child.text}"`);
        });
      }
    });

    console.log('\n=== NEW TREE ===');
    console.log('Nodes:', newTree.length);
    newTree.forEach((node, i) => {
      console.log(`[${i}] type=${node.type}, text="${node.text}"`);
      if (node.children) {
        node.children.forEach((child, ci) => {
          console.log(`  [${ci}] type=${child.type}, text="${child.text}"`);
        });
      }
    });

    // Check if paragraph nodes have same normalized text
    expect(oldTree[0]?.text).toBe(newTree[0]?.text);
  });
});
