/**
 * Debug test to check how bold text structure is represented
 */

import {describe, it} from 'vitest';
import {$getRoot} from 'lexical';
import {$convertFromEnhancedMarkdownString} from '../../../../markdown';
import {createTestHeadlessEditor, MARKDOWN_TEST_TRANSFORMERS} from '../utils/testConfig';
import {canonicalizeForest} from '../../core/canonicalTree';

describe('Debug: Bold Text Structure', () => {
  it('should show the structure of bold text in canonical tree', () => {
    const markdown = `**Risk**: Something\n**Mitigation**: Do it\n`;

    const editor = createTestHeadlessEditor();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(markdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    let tree: any[] = [];
    editor.getEditorState().read(() => {
      tree = canonicalizeForest($getRoot().getChildren());
    });

    console.log('\n=== CANONICAL TREE STRUCTURE ===');
    console.log(`Total root nodes: ${tree.length}`);

    for (let i = 0; i < tree.length; i++) {
      const node = tree[i];
      console.log(`\n[${i}] ${node.type} (id=${node.id})`);
      console.log(`  text: "${node.text}"`);
      console.log(`  attrs:`, JSON.stringify(node.attrs, null, 2));
      console.log(`  children: ${node.children?.length || 0}`);

      if (node.children && node.children.length > 0) {
        for (let j = 0; j < node.children.length; j++) {
          const child = node.children[j];
          console.log(`    [${j}] ${child.type} (id=${child.id})`);
          console.log(`      text: "${child.text}"`);
          console.log(`      attrs:`, JSON.stringify(child.attrs, null, 2));
          if (child.children && child.children.length > 0) {
            console.log(`      children: ${child.children.length}`);
            for (let k = 0; k < child.children.length; k++) {
              const grandchild = child.children[k];
              console.log(`        [${k}] ${grandchild.type}: "${grandchild.text}"`);
            }
          }
        }
      }

      // Check serialized children
      console.log(`  serialized.children: ${node.serialized.children?.length || 0}`);
      if (node.serialized.children && node.serialized.children.length > 0) {
        console.log(`    Types:`, node.serialized.children.map((c: any) => c.type).join(', '));
      }
    }
  });

  it('should compare two identical bold paragraphs', () => {
    const markdown1 = `**Risk**: Something\n`;
    const markdown2 = `**Risk**: Something\n`;

    const editor1 = createTestHeadlessEditor();
    editor1.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(markdown1, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    const editor2 = createTestHeadlessEditor();
    editor2.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(markdown2, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    let tree1: any[] = [];
    editor1.getEditorState().read(() => {
      tree1 = canonicalizeForest($getRoot().getChildren());
    });

    let tree2: any[] = [];
    editor2.getEditorState().read(() => {
      tree2 = canonicalizeForest($getRoot().getChildren());
    });

    console.log('\n=== COMPARISON ===');
    console.log(`Tree1 text: "${tree1[0].text}"`);
    console.log(`Tree2 text: "${tree2[0].text}"`);
    console.log(`Text matches: ${tree1[0].text === tree2[0].text}`);

    console.log(`\nTree1 attrs:`, JSON.stringify(tree1[0].attrs));
    console.log(`Tree2 attrs:`, JSON.stringify(tree2[0].attrs));
    console.log(`Attrs match: ${JSON.stringify(tree1[0].attrs) === JSON.stringify(tree2[0].attrs)}`);

    console.log(`\nTree1 children: ${tree1[0].children?.length || 0}`);
    console.log(`Tree2 children: ${tree2[0].children?.length || 0}`);

    console.log(`\nTree1 serialized.children: ${tree1[0].serialized.children?.length || 0}`);
    console.log(`Tree2 serialized.children: ${tree2[0].serialized.children?.length || 0}`);
  });
});
