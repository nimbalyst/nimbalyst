/**
 * Test for nested list addition bug
 * When adding a sublist under an existing list item, subsequent items appear out of position
 */

import {describe, expect, it} from 'vitest';
import {$getRoot, COMMAND_PRIORITY_EDITOR} from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
} from '../../../../../markdown/index';
import {createTestHeadlessEditor, MARKDOWN_TEST_TRANSFORMERS} from '../../utils/testConfig';
import {$getDiffState} from '../../../core/DiffState';
import {APPLY_MARKDOWN_REPLACE_COMMAND} from '../../..';
import {applyMarkdownReplace} from '../../../core/exports';

describe('Nested list addition bug', () => {
  it('should show structure of nested list markdown', () => {
    const newMarkdown = `# numbers

- One
- Two
  - alpha
  - bravo
- Three
`;

    const editor = createTestHeadlessEditor();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(newMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    console.log('\n=== MARKDOWN IMPORT STRUCTURE ===');
    editor.getEditorState().read(() => {
      const root = $getRoot();
      const traverse = (node: any, indent: string = '', idx: number = 0) => {
        const type = node.getType();
        const text = node.getTextContent?.() || '';
        console.log(`${indent}[${idx}] ${type}: "${text.substring(0, 40).replace(/\n/g, '\\n')}"`);

        if (node.getChildren) {
          const children = node.getChildren();
          children.forEach((child: any, i: number) => traverse(child, indent + '  ', i));
        }
      };

      root.getChildren().forEach((child: any, i: number) => traverse(child, '', i));
    });
  });

  it('should correctly position items when adding sublists', async () => {
    const oldMarkdown = `# numbers

- One
- Two
- Three
`;

    const newMarkdown = `# numbers

- One
- Two
  - alpha
  - bravo
- Three
`;

    const editor = createTestHeadlessEditor();

    // Register the command handler
    editor.registerCommand(
      APPLY_MARKDOWN_REPLACE_COMMAND,
      (payload) => {
        const replacements = Array.isArray(payload) ? payload : payload?.replacements;
        applyMarkdownReplace(editor, oldMarkdown, replacements as any, MARKDOWN_TEST_TRANSFORMERS);
        return true;
      },
      COMMAND_PRIORITY_EDITOR
    );

    // Load old markdown
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    console.log('\n=== NESTED LIST ADDITION BUG ===');
    console.log('Old markdown:', oldMarkdown);
    console.log('New markdown:', newMarkdown);

    // Apply diff
    const replacements = [{ oldText: oldMarkdown, newText: newMarkdown }];
    const result = editor.dispatchCommand(APPLY_MARKDOWN_REPLACE_COMMAND, replacements);

    if (!result) {
      console.error('APPLY_MARKDOWN_REPLACE_COMMAND was not handled!');
      throw new Error('Command not handled');
    }

    // Wait for async operations
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        // Collect all nodes in order
        const allNodes: Array<{
          index: number;
          type: string;
          text: string;
          diffState: any;
        }> = [];

        editor.getEditorState().read(() => {
          const root = $getRoot();
          const children = root.getChildren();

          children.forEach((child, i) => {
            const diffState = $getDiffState(child);
            const text = child.getTextContent().trim();

            allNodes.push({
              index: i,
              type: child.getType(),
              text,
              diffState,
            });
          });
        });

        console.log('\n=== DOCUMENT STRUCTURE ===');
        allNodes.forEach((n) => {
          const icon =
            n.diffState === 'added' ? '➕' :
            n.diffState === 'removed' ? '➖' :
            n.diffState === 'modified' ? '🔄' : '  ';
          console.log(`[${n.index}] ${icon} ${n.type}: "${n.text.substring(0, 60)}"`);
        });

        // Log the actual tree structure with nested items
        console.log('\n=== DETAILED TREE STRUCTURE ===');
        editor.getEditorState().read(() => {
          const root = $getRoot();
          const traverse = (node: any, indent: string = '') => {
            const diffState = $getDiffState(node);
            const type = node.getType();
            const text = node.getTextContent?.() || '';
            const stateIcon = diffState === 'added' ? '➕' :
                            diffState === 'removed' ? '➖' :
                            diffState === 'modified' ? '🔄' : '  ';
            console.log(`${indent}${stateIcon} ${type}: "${text.substring(0, 40).replace(/\n/g, '\\n')}"`);

            if (node.getChildren) {
              const children = node.getChildren();
              children.forEach((child: any) => traverse(child, indent + '  '));
            }
          };

          root.getChildren().forEach((child: any) => traverse(child));
        });

        // Check that "Three" appears correctly as a list item
        // Need to look inside the list node, not at top-level nodes
        let foundThree = false;
        let threeText = '';
        let listItemTexts: string[] = [];

        editor.getEditorState().read(() => {
          const root = $getRoot();
          const children = root.getChildren();

          // Find the list node
          const listNode = children.find((child: any) => child.getType() === 'list');
          if (listNode) {
            const listItems = (listNode as any).getChildren();

            // Collect text from all list items
            listItemTexts = listItems.map((item: any) => item.getTextContent().trim());

            // Find the "Three" list item
            const threeListItem = listItems.find((item: any) => {
              const text = item.getTextContent().trim();
              return text === 'Three';
            });

            if (threeListItem) {
              foundThree = true;
              threeText = threeListItem.getTextContent().trim();
            }
          }
        });

        console.log('\n=== LIST ITEMS ===');
        listItemTexts.forEach((text: string, i: number) => {
          console.log(`[${i}] "${text}"`);
        });

        console.log('\n=== "Three" LIST ITEM ===');
        console.log('Found:', foundThree ? 'yes' : 'no');
        console.log('Text:', threeText);
        console.log('Text is exactly "Three":', threeText === 'Three');

        // The bug: "Three" appears as "ThreeTwo" or in wrong position
        // Expected: "Three" should be its own clean list item
        if (!foundThree) {
          throw new Error('Could not find "Three" list item');
        }
        expect(threeText).toBe('Three');

        resolve();
      }, 100);
    });
  });

  it('should correctly handle moving nested list from Two to One', async () => {
    const oldMarkdown = `# numbers

- One
- Two
  - alpha
  - bravo
- Three
`;

    const newMarkdown = `# numbers

- One
  - alpha
  - bravo
- Two
- Three
`;

    const editor = createTestHeadlessEditor();

    // Register the command handler
    editor.registerCommand(
      APPLY_MARKDOWN_REPLACE_COMMAND,
      (payload) => {
        const replacements = Array.isArray(payload) ? payload : payload?.replacements;
        applyMarkdownReplace(editor, oldMarkdown, replacements as any, MARKDOWN_TEST_TRANSFORMERS);
        return true;
      },
      COMMAND_PRIORITY_EDITOR
    );

    // Load old markdown
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    console.log('\n=== MOVE NESTED LIST FROM TWO TO ONE ===');

    // First check what structure the NEW markdown creates
    const tempEditor = createTestHeadlessEditor();
    tempEditor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(newMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    console.log('\\n=== EXPECTED STRUCTURE (from direct markdown import) ===');
    tempEditor.getEditorState().read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      const listNode = children.find((child: any) => child.getType() === 'list');
      if (listNode) {
        const items = (listNode as any).getChildren();
        items.forEach((item: any, i: number) => {
          const directText = item.getChildren().filter((c: any) => c.getType() === 'text')
            .map((c: any) => c.getTextContent()).join('');
          const hasNestedList = item.getChildren().some((c: any) => c.getType() === 'list');
          console.log(`  [${i}] listitem: directText="${directText}", hasNestedList=${hasNestedList}`);
        });
      }
    });

    // Apply diff
    const replacements = [{ oldText: oldMarkdown, newText: newMarkdown }];
    const result = editor.dispatchCommand(APPLY_MARKDOWN_REPLACE_COMMAND, replacements);

    if (!result) {
      console.error('APPLY_MARKDOWN_REPLACE_COMMAND was not handled!');
      throw new Error('Command not handled');
    }

    // Wait for async operations
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        let listItemTexts: string[] = [];

        editor.getEditorState().read(() => {
          const root = $getRoot();
          const children = root.getChildren();

          const listNode = children.find((child: any) => child.getType() === 'list');
          if (listNode) {
            const listItems = (listNode as any).getChildren();
            listItemTexts = listItems.map((item: any) => item.getTextContent().trim());
          }
        });

        console.log('\n=== FINAL LIST ITEMS ===');
        listItemTexts.forEach((text: string, i: number) => {
          console.log(`[${i}] "${text}"`);
        });

        // Expected: [0] "One\n\nalpha\n\nbravo", [1] "Two", [2] "Three"
        // Or: [0] "One", [1] wrapper for nested list, [2] "Two", [3] "Three"
        expect(listItemTexts.length).toBeGreaterThanOrEqual(3);
        expect(listItemTexts.some(t => t === 'Two')).toBe(true);
        expect(listItemTexts.some(t => t === 'Three')).toBe(true);
        expect(listItemTexts.some(t => t.includes('alpha'))).toBe(true);

        resolve();
      }, 100);
    });
  });
});
