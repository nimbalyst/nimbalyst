/**
 * Test for extra newline bug when applying multiple section edits
 *
 * Bug: When applying diffs that add paragraphs under section headers,
 * an extra blank paragraph appears between the header and the content.
 */

import { describe, it, expect } from 'vitest';
import { $getRoot, $isElementNode } from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  getEditorTransformers,
} from '../../../../../markdown/index';
import { applyMarkdownReplace } from '../../../core/diffUtils';
import { createTestHeadlessEditor } from '../../utils/testConfig';

describe('Multiple sections newline bug', () => {
  it('markdown parser adds trailing empty paragraph', () => {
    const editor = createTestHeadlessEditor();
    const transformers = getEditorTransformers();

    // Test: parse markdown that ends with a heading
    const markdown = '## Section Two\n';

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        $convertFromEnhancedMarkdownString(markdown, transformers, undefined, true, true);
      },
      { discrete: true }
    );

    // Check what nodes were created
    const nodes: any[] = [];
    editor.getEditorState().read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      children.forEach((node, index) => {
        nodes.push({
          index,
          type: node.getType(),
          text: node.getTextContent(),
        });
      });
    });

    console.log('Markdown:', JSON.stringify(markdown));
    console.log('Nodes created:', JSON.stringify(nodes, null, 2));

    // CORRECT BEHAVIOR: Parser creates 2 nodes (heading + empty paragraph from trailing \n)
    // This is NOT a bug - this is how markdown parsing works when preserveNewLines: true
    expect(nodes.length).toBe(2);
    expect(nodes[0].type).toBe('heading');
    expect(nodes[1].type).toBe('paragraph');
    expect(nodes[1].text).toBe(''); // Empty paragraph from trailing newline
  });

  it('should not add extra blank paragraphs when adding content under section headers', () => {
    const editor = createTestHeadlessEditor();
    const transformers = getEditorTransformers();

    // Setup: Create document with two section headers
    const preEditMarkdown = '# Test Doc\n\n## Section One\n\n## Section Two\n';

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        $convertFromEnhancedMarkdownString(preEditMarkdown, transformers, undefined, true, true);
      },
      { discrete: true }
    );

    // Get the markdown to verify initial state
    let currentMarkdown = '';
    editor.getEditorState().read(() => {
      currentMarkdown = $convertToEnhancedMarkdownString(transformers);
    });

    console.log('Initial markdown:', JSON.stringify(currentMarkdown));

    // Apply first diff: add paragraph under Section One
    let markdownBeforeFirstParse = '';
    let markdownAfterFirstParse = '';

    editor.update(
      () => {
        const original = $convertToEnhancedMarkdownString(transformers);
        console.log('Before first replacement:', JSON.stringify(original));

        // Manually apply the replacement to see what we SHOULD get
        const expectedAfterReplace = original.replace('## Section One\n\n', '## Section One\nFirst paragraph.\n');
        console.log('Expected markdown after text replacement:', JSON.stringify(expectedAfterReplace));
        markdownBeforeFirstParse = expectedAfterReplace;

        applyMarkdownReplace(
          editor,
          original,
          [{ oldText: '## Section One\n\n', newText: '## Section One\nFirst paragraph.\n' }],
          transformers
        );
      },
      { discrete: true }
    );

    // Check what we actually got
    editor.getEditorState().read(() => {
      markdownAfterFirstParse = $convertToEnhancedMarkdownString(transformers);
      console.log('Actual markdown after first replacement and re-export:', JSON.stringify(markdownAfterFirstParse));
      if (markdownBeforeFirstParse !== markdownAfterFirstParse) {
        console.log('⚠️  Markdown changed during parse/export cycle!');
        console.log('  Expected:', markdownBeforeFirstParse);
        console.log('  Got:', markdownAfterFirstParse);
      }
    });

    // Get markdown after first edit
    editor.getEditorState().read(() => {
      currentMarkdown = $convertToEnhancedMarkdownString(transformers);
    });

    console.log('After first edit:', JSON.stringify(currentMarkdown));

    // Apply second diff: add paragraph under Section Two
    // NOTE: After the first diff, the markdown export may or may not have a trailing newline
    // after "## Section Two" depending on whether it's at the end of the document
    editor.update(
      () => {
        const original = $convertToEnhancedMarkdownString(transformers);
        // Try with trailing newline first, if that fails try without
        const oldText1 = '## Section Two\n';
        const oldText2 = '## Section Two';
        const newText = '## Section Two\nSecond paragraph.\n';

        if (original.includes(oldText1)) {
          applyMarkdownReplace(
            editor,
            original,
            [{ oldText: oldText1, newText }],
            transformers
          );
        } else if (original.includes(oldText2)) {
          applyMarkdownReplace(
            editor,
            original,
            [{ oldText: oldText2, newText }],
            transformers
          );
        } else {
          throw new Error(`Could not find "## Section Two" in markdown: ${original}`);
        }
      },
      { discrete: true }
    );

    // Get final HTML structure
    const nodeStructure: any[] = [];
    editor.getEditorState().read(() => {
      const root = $getRoot();
      const children = root.getChildren();

      children.forEach((node, index) => {
        if ($isElementNode(node)) {
          const type = node.getType();
          const childCount = node.getChildrenSize();
          const textContent = node.getTextContent();

          nodeStructure.push({
            index,
            type,
            childCount,
            textContent: textContent.substring(0, 50),
          });

          // For debugging: if this is a heading with "Section Two", check what follows
          if (type === 'heading' && textContent.includes('Section Two')) {
            const nextNode = children[index + 1];
            if (nextNode && $isElementNode(nextNode)) {
              const nextType = nextNode.getType();
              const nextText = nextNode.getTextContent();
              const nextChildCount = nextNode.getChildrenSize();

              console.log('Node after "Section Two" header:');
              console.log('  Type:', nextType);
              console.log('  Text:', JSON.stringify(nextText));
              console.log('  Child count:', nextChildCount);
              console.log('  Is empty:', nextText === '');

              // Check if it's a blank paragraph
              if (nextType === 'paragraph' && nextText === '') {
                console.log('  ❌ FOUND THE BUG: Empty paragraph after Section Two header');

                // Check the node after that
                const nodeAfterBlank = children[index + 2];
                if (nodeAfterBlank && $isElementNode(nodeAfterBlank)) {
                  console.log('Node after blank paragraph:');
                  console.log('  Type:', nodeAfterBlank.getType());
                  console.log('  Text:', nodeAfterBlank.getTextContent());
                }
              }
            }
          }
        }
      });
    });

    console.log('\nFinal node structure:');
    console.log(JSON.stringify(nodeStructure, null, 2));

    // Check for the bug: there should NOT be an empty paragraph between
    // the "Section Two" heading and the "Second paragraph." content
    let foundBug = false;
    let sectionTwoIndex = -1;

    for (let i = 0; i < nodeStructure.length; i++) {
      const node = nodeStructure[i];
      if (node.type === 'heading' && node.textContent.includes('Section Two')) {
        sectionTwoIndex = i;
        break;
      }
    }

    if (sectionTwoIndex >= 0 && sectionTwoIndex + 1 < nodeStructure.length) {
      const nextNode = nodeStructure[sectionTwoIndex + 1];
      // Check if the next node is an empty paragraph
      if (nextNode.type === 'paragraph' && nextNode.textContent === '') {
        // Check if the node after that has "Second paragraph"
        if (sectionTwoIndex + 2 < nodeStructure.length) {
          const nodeAfterBlank = nodeStructure[sectionTwoIndex + 2];
          if (nodeAfterBlank.textContent.includes('Second paragraph')) {
            foundBug = true;
          }
        }
      }
    }

    expect(foundBug).toBe(false);
  });
});
