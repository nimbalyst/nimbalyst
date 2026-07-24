import {describe, expect, it} from 'vitest';
import {$getRoot, $isElementNode} from 'lexical';
import {$isListItemNode} from '@lexical/list';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  getEditorTransformers,
} from '../../../../../markdown';
import {applyMarkdownReplace} from '../../../core/diffUtils';
import {$getDiffState} from '../../../core/DiffState';
import {$approveDiffs, $rejectDiffs} from '../../../core/diffPluginUtils';
import {createTestHeadlessEditor} from '../../utils/testConfig';
import {getAllNodes} from '../../utils';

describe('Checkbox state changes in diff', () => {
  it('should detect checking a checkbox as a diff', () => {
    const sourceMarkdown = `- [ ] task one
- [ ] task two
- [ ] task three
`;

    const targetMarkdown = `- [x] task one
- [ ] task two
- [ ] task three
`;

    const editor = createTestHeadlessEditor();
    const transformers = getEditorTransformers();

    // Load source
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

    // Verify diff was detected
    const result = editor.getEditorState().read(() => {
      const allNodes = getAllNodes(editor);
      const modifiedNodes = allNodes.filter(n => $getDiffState(n) === 'modified');
      return {
        hasModifiedNodes: modifiedNodes.length > 0,
        modifiedTypes: modifiedNodes.map(n => n.getType()),
      };
    });

    expect(result.hasModifiedNodes).toBe(true);
    expect(result.modifiedTypes).toContain('listitem');
  });

  it('should preserve checked state after approving diff', () => {
    const sourceMarkdown = `- [ ] task one
- [ ] task two
- [ ] task three
`;

    const targetMarkdown = `- [x] task one
- [ ] task two
- [x] task three
`;

    const editor = createTestHeadlessEditor();
    const transformers = getEditorTransformers();

    // Load source
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

    // Check state after diff but before approval
    const preDiffState = editor.getEditorState().read(() => {
      const allNodes = getAllNodes(editor);
      const listItems = allNodes.filter(n => $isListItemNode(n));
      return {
        markdown: $convertToEnhancedMarkdownString(transformers),
        listItemChecked: listItems.map(li => ({
          text: li.getTextContent(),
          checked: (li as any).getChecked?.(),
          diffState: $getDiffState(li),
          hasOriginalChecked: '__originalChecked' in li,
        })),
      };
    });

    console.log('Pre-approval state:', JSON.stringify(preDiffState, null, 2));

    // Approve all diffs
    editor.update(
      () => {
        $approveDiffs();
      },
      {discrete: true},
    );

    // Export and verify
    const exportedMarkdown = editor.getEditorState().read(() => {
      return $convertToEnhancedMarkdownString(transformers);
    });

    console.log('Post-approval markdown:', exportedMarkdown);

    expect(exportedMarkdown).toContain('- [x] task one');
    expect(exportedMarkdown).toContain('- [ ] task two');
    expect(exportedMarkdown).toContain('- [x] task three');
  });

  it('should restore original checked state after rejecting diff', () => {
    const sourceMarkdown = `- [ ] task one
- [x] task two
- [ ] task three
`;

    const targetMarkdown = `- [x] task one
- [ ] task two
- [x] task three
`;

    const editor = createTestHeadlessEditor();
    const transformers = getEditorTransformers();

    // Load source
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

    // Reject all diffs
    editor.update(
      () => {
        $rejectDiffs();
      },
      {discrete: true},
    );

    // Export and verify original state is restored
    const exportedMarkdown = editor.getEditorState().read(() => {
      return $convertToEnhancedMarkdownString(transformers);
    });

    expect(exportedMarkdown).toContain('- [ ] task one');
    expect(exportedMarkdown).toContain('- [x] task two');
    expect(exportedMarkdown).toContain('- [ ] task three');
  });

  it('should handle checkbox change within a larger document', () => {
    const sourceMarkdown = `# My Plan

Some description here.

## Tasks

- [ ] First task
- [ ] Second task
- [ ] Third task

## Notes

Some notes.
`;

    const targetMarkdown = `# My Plan

Some description here.

## Tasks

- [x] First task
- [ ] Second task
- [ ] Third task

## Notes

Some notes.
`;

    const editor = createTestHeadlessEditor();
    const transformers = getEditorTransformers();

    // Load source
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

    // Approve diffs
    editor.update(
      () => {
        $approveDiffs();
      },
      {discrete: true},
    );

    // Export and verify
    const exportedMarkdown = editor.getEditorState().read(() => {
      return $convertToEnhancedMarkdownString(transformers);
    });

    expect(exportedMarkdown).toContain('- [x] First task');
    expect(exportedMarkdown).toContain('- [ ] Second task');
    expect(exportedMarkdown).toContain('- [ ] Third task');
    // Verify the rest of the document is preserved
    expect(exportedMarkdown).toContain('# My Plan');
    expect(exportedMarkdown).toContain('Some description here.');
    expect(exportedMarkdown).toContain('## Notes');
  });
});
