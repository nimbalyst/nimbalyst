// @vitest-environment node
/**
 * An agent edit to a shared collaborative document lands as final text: no
 * pending red/green nodes, so every collaborator sees the same document. A file
 * on disk still gets the pending diff for its owner to review.
 *
 * Both cases go through the real APPLY_MARKDOWN_REPLACE_COMMAND handler with the
 * flag the mounted editor derives from its document path.
 */
import {describe, expect, it} from 'vitest';
import {$getRoot, $isElementNode, type LexicalEditor, type LexicalNode} from 'lexical';

import {agentEditsApplyDirectly} from '../../../../../ai/agentEditPolicy';
import {setLocalWikiRoot} from '../../../../../core/localWikiRoots';
import {DiffExtension} from '../../../../extensions/builtin/DiffExtension';
import {$convertFromEnhancedMarkdownString, $convertToEnhancedMarkdownString} from '../../../../markdown';
import {APPLY_MARKDOWN_REPLACE_COMMAND, type ApplyMarkdownReplaceResult} from '../../DiffCommands';
import {$getDiffState} from '../../core/DiffState';
import {createTestHeadlessEditor, MARKDOWN_TEST_TRANSFORMERS} from '../utils/testConfig';

const ORIGINAL = '# Plan\n\nShip the alpha on Friday.\n\nKeep this paragraph.\n';

function applyAgentEdit(documentPath: string): LexicalEditor {
  const editor = createTestHeadlessEditor();
  const unregister = (DiffExtension.register as unknown as (e: LexicalEditor) => () => void)(editor);
  editor.update(() => {
    $getRoot().clear();
    $convertFromEnhancedMarkdownString(ORIGINAL, MARKDOWN_TEST_TRANSFORMERS);
  }, {discrete: true});

  let result: ApplyMarkdownReplaceResult | undefined;
  editor.dispatchCommand(APPLY_MARKDOWN_REPLACE_COMMAND, {
    replacements: [
      {oldText: 'Ship the alpha on Friday.', newText: 'Ship the beta on Monday.'},
      {oldText: '# Plan', newText: '# Release plan'},
    ],
    acceptChanges: agentEditsApplyDirectly(documentPath),
    onResult: (r) => { result = r; },
  });
  unregister();
  expect(result).toEqual({ok: true});
  return editor;
}

function diffStates(editor: LexicalEditor): string[] {
  return editor.getEditorState().read(() => {
    const states: string[] = [];
    const visit = (node: LexicalNode) => {
      const state = $getDiffState(node);
      if (state) states.push(state);
      if ($isElementNode(node)) node.getChildren().forEach(visit);
    };
    $getRoot().getChildren().forEach(visit);
    return states;
  });
}

function markdown(editor: LexicalEditor): string {
  return editor.getEditorState().read(() =>
    $convertToEnhancedMarkdownString(MARKDOWN_TEST_TRANSFORMERS, {includeFrontmatter: false}),
  );
}

describe('agent edits by document kind', () => {
  it('a collab:// document gets final text with no pending diff nodes', () => {
    const editor = applyAgentEdit('collab://org:acme:doc:plan');

    expect(diffStates(editor)).toEqual([]);
    const text = markdown(editor);
    expect(text).toContain('# Release plan');
    expect(text).toContain('Ship the beta on Monday.');
    expect(text).not.toContain('alpha');
    expect(text).toContain('Keep this paragraph.');
  });

  /**
   * The history compare view (`DiffPreviewEditor`) renders red/green by
   * dispatching the bare-array payload. Applying directly is opt-in per agent
   * edit, never a property of the command, so version compare keeps its diff.
   */
  it('the bare-array payload the history compare view dispatches still renders red/green', () => {
    const editor = createTestHeadlessEditor();
    const unregister = (DiffExtension.register as unknown as (e: LexicalEditor) => () => void)(editor);
    editor.update(() => {
      $getRoot().clear();
      $convertFromEnhancedMarkdownString(ORIGINAL, MARKDOWN_TEST_TRANSFORMERS);
    }, {discrete: true});

    editor.dispatchCommand(APPLY_MARKDOWN_REPLACE_COMMAND, [
      {oldText: 'Ship the alpha on Friday.', newText: 'Ship the beta on Monday.'},
    ]);
    unregister();

    const states = diffStates(editor);
    expect(states).toContain('added');
    expect(states).toContain('removed');
  });

  it('an open Personal page gets final text, like a shared page', () => {
    const editor = applyAgentEdit('personal-doc://ideas');

    expect(diffStates(editor)).toEqual([]);
    expect(markdown(editor)).toContain('Ship the beta on Monday.');
  });

  // The wiki folder is wherever the host resolved it, not a fixed path.
  it('a page file inside the registered Local wiki folder gets final text; a file beside it does not', () => {
    setLocalWikiRoot('/workspace', '/workspace/docs/my-wiki/');
    try {
      const page = applyAgentEdit('/workspace/docs/my-wiki/Plans/Q3 goals.md');
      expect(diffStates(page)).toEqual([]);
      expect(markdown(page)).toContain('Ship the beta on Monday.');

      expect(agentEditsApplyDirectly('/workspace/docs/my-wiki-old/Plan.md')).toBe(false);
      expect(agentEditsApplyDirectly('/workspace/nimbalyst-local/wiki/Plan.md')).toBe(false);
    } finally {
      setLocalWikiRoot('/workspace', null);
    }
    expect(agentEditsApplyDirectly('/workspace/docs/my-wiki/Plans/Q3 goals.md')).toBe(false);
  });

  it('a markdown file on disk still gets pending diff nodes for review', () => {
    const editor = applyAgentEdit('/workspace/notes/plan.md');

    expect(diffStates(editor).length).toBeGreaterThan(0);
    // The removed text is still in the tree, awaiting Keep or Revert.
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toContain('alpha');
  });
});
