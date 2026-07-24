import {describe, expect, it} from 'vitest';
import {$getRoot, $isElementNode} from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  getEditorTransformers,
} from '../../../../../markdown';
import {applyMarkdownReplace} from '../../../core/diffUtils';
import {$getDiffState} from '../../../core/DiffState';
import {createTestHeadlessEditor} from '../../utils/testConfig';
import {getAllNodes, printDiffStateSummary} from '../../utils';

describe('List item changes', () => {
  it('should handle individual list item updates without duplicating entire list', () => {
    // Source markdown with English numbers
    const sourceMarkdown = `# numbers

- one
- two
- three
- four
- five
- six
- seven
- eight
- nine
- ten
`;

    // Target markdown with some French translations
    const targetMarkdown = `# numbers

- one
- deux
- three
- quatre
- five
- six
- seven
- huit
- nine
- dix
`;

    // Create editor and load source
    const editor = createTestHeadlessEditor();
    const transformers = getEditorTransformers();

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        $convertFromEnhancedMarkdownString(sourceMarkdown, transformers);
      },
      {discrete: true},
    );

    // Apply diff
    editor.update(
      () => {
        const original = $convertToEnhancedMarkdownString(transformers);
        applyMarkdownReplace(
          editor,
          original,
          [{oldText: sourceMarkdown, newText: targetMarkdown}],
          transformers
        );
      },
      {discrete: true},
    );

    // Collect diff states
    const result = editor.getEditorState().read(() => {
      const allNodes = getAllNodes(editor);

      const states = {
        added: [] as string[],
        removed: [] as string[],
        modified: [] as string[],
        unchanged: [] as string[],
      };

      allNodes.forEach(node => {
        if (!$isElementNode(node)) return;

        const state = $getDiffState(node);
        const text = node.getTextContent().trim();

        if (!text || text === 'numbers') return; // Skip heading and empty

        if (state === 'added') {
          states.added.push(text);
        } else if (state === 'removed') {
          states.removed.push(text);
        } else if (state === 'modified') {
          states.modified.push(text);
        } else if (!state || state === 'unchanged') {
          states.unchanged.push(text);
        }
      });

      return states;
    });

    console.log('=== Diff States ===');
    console.log('Added:', result.added);
    console.log('Removed:', result.removed);
    console.log('Modified:', result.modified);
    console.log('Unchanged:', result.unchanged);

    // At minimum, changed entries should be represented in add/remove sets.
    expect(result.removed).toContain('two');
    expect(result.added).toContain('dix');
    expect(result.added.length).toBeGreaterThan(0);
    expect(result.removed.length).toBeGreaterThan(0);

    // Unchanged items should not be marked as added or removed
    expect(result.unchanged).toContain('one');
    expect(result.unchanged).toContain('three');
    expect(result.unchanged).toContain('five');
    expect(result.unchanged).toContain('six');
    expect(result.unchanged).toContain('seven');
    expect(result.unchanged).toContain('nine');

    // Should NOT duplicate the entire list
    // Count how many times "one" appears in removed (should be 0)
    const oneRemovedCount = result.removed.filter(t => t === 'one').length;
    expect(oneRemovedCount, 'Unchanged item "one" should not be marked as removed').toBe(0);
  });
});
