/**
 * Regression test: List items with bold text should NOT show as changed
 * when they haven't been modified.
 *
 * Bug: When $applyInlineTextDiff is called with identical source and target
 * children that contain bold (formatted) text, it treats the identical content
 * as a "pure formatting change" because sourceText === targetText, and marks
 * all children as removed+added. This happens because the function checks
 * text equality but doesn't first check if the children structures are actually
 * identical.
 */

import {$getRoot, $isElementNode, type LexicalNode} from 'lexical';
import {createHeadlessEditor} from '@lexical/headless';
import {
  $convertFromEnhancedMarkdownString,
} from '../../../../../markdown';
import {
  assertApproveProducesTarget,
  assertRejectProducesOriginal,
  setupMarkdownReplaceTestWithFullReplacement,
} from '../../utils/replaceTestUtils';
import {createTestEditor, MARKDOWN_TEST_TRANSFORMERS, TEST_NODES} from '../../utils/testConfig';
import {$getDiffState} from '../../../core/DiffState';
import {$applyInlineTextDiff} from '../../../core/inlineTextDiff';
import type {SerializedLexicalNode, SerializedTextNode} from 'lexical';

function getAllNodes(editor: any): LexicalNode[] {
  return editor.getEditorState().read(() => {
    const root = $getRoot();
    const allNodes: LexicalNode[] = [];
    function traverse(node: LexicalNode): void {
      allNodes.push(node);
      if ($isElementNode(node)) {
        for (const child of node.getChildren()) {
          traverse(child);
        }
      }
    }
    for (const child of root.getChildren()) {
      traverse(child);
    }
    return allNodes;
  });
}

/**
 * Get serialized children of a list item from the editor state JSON
 * (exportJSON on nodes doesn't include recursive children, but toJSON on state does)
 */
function getListItemChildrenFromState(editor: any): SerializedLexicalNode[] {
  const state = editor.getEditorState().toJSON();
  const root = state.root;
  // root -> list -> listitem -> children (text nodes)
  const list = root.children?.[0];
  const listItem = list?.children?.[0];
  return listItem?.children || [];
}

describe('Bold list items false positive bug', () => {
  test('$applyInlineTextDiff should not create diff markers when source and target bold children are identical', () => {
    const editor = createTestEditor();

    // Create a list item with bold text
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(
        '- **Apple** - YummApple - Yum',
        MARKDOWN_TEST_TRANSFORMERS,
      );
    }, {discrete: true});

    // Get the serialized children of the list item from state JSON
    const listItemChildren = getListItemChildrenFromState(editor);
    console.log('List item children:', JSON.stringify(listItemChildren, null, 2));

    // Verify we got the expected structure: [bold "Apple", regular " - YummApple - Yum"]
    expect(listItemChildren.length).toBe(2);
    expect((listItemChildren[0] as SerializedTextNode).text).toBe('Apple');
    expect((listItemChildren[0] as SerializedTextNode).format).toBe(1); // bold
    expect((listItemChildren[1] as SerializedTextNode).text).toBe(' - YummApple - Yum');
    expect((listItemChildren[1] as SerializedTextNode).format).toBe(0); // regular

    // Apply inline text diff with IDENTICAL source and target children
    editor.update(() => {
      const root = $getRoot();
      const list = root.getFirstChild()!;
      if ($isElementNode(list)) {
        const listItem = list.getFirstChild()!;
        if ($isElementNode(listItem)) {
          $applyInlineTextDiff(listItem, listItemChildren, listItemChildren);
        }
      }
    }, {discrete: true});

    // Check: NO nodes should have added/removed diff state when content is identical
    const allNodes = getAllNodes(editor);
    const nodesWithDiffState = editor.getEditorState().read(() => {
      return allNodes
        .map((n) => ({
          type: n.getType(),
          text: n.getTextContent().substring(0, 50),
          diffState: $getDiffState(n),
        }))
        .filter((n) => n.diffState !== null && n.diffState !== undefined);
    });

    console.log('Nodes with diff state after identical inline diff:', JSON.stringify(nodesWithDiffState, null, 2));

    // BUG: The "pure formatting change" code path triggers because sourceText === targetText,
    // even though the children are structurally identical. It should detect identical children
    // and not create any diff markers.
    const addedOrRemoved = nodesWithDiffState.filter(
      (n) => n.diffState === 'added' || n.diffState === 'removed'
    );
    expect(addedOrRemoved).toEqual([]);
  });

  test('$applyInlineTextDiff with different formatting should create diff markers', () => {
    const editor = createTestEditor();

    // Create a list item with bold text
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(
        '- Apple - YummApple - Yum',
        MARKDOWN_TEST_TRANSFORMERS,
      );
    }, {discrete: true});

    // Source: plain text "Apple - YummApple - Yum"
    const sourceChildren: SerializedLexicalNode[] = [
      {type: 'text', text: 'Apple - YummApple - Yum', format: 0, detail: 0, mode: 'normal', style: '', version: 1} as any,
    ];

    // Target: bold "Apple" + regular " - YummApple - Yum" (formatting change)
    const targetChildren: SerializedLexicalNode[] = [
      {type: 'text', text: 'Apple', format: 1, detail: 0, mode: 'normal', style: '', version: 1} as any,
      {type: 'text', text: ' - YummApple - Yum', format: 0, detail: 0, mode: 'normal', style: '', version: 1} as any,
    ];

    // Apply inline text diff - this SHOULD create diff markers (real formatting change)
    editor.update(() => {
      const root = $getRoot();
      const list = root.getFirstChild()!;
      if ($isElementNode(list)) {
        const listItem = list.getFirstChild()!;
        if ($isElementNode(listItem)) {
          $applyInlineTextDiff(listItem, sourceChildren, targetChildren);
        }
      }
    }, {discrete: true});

    const allNodes = getAllNodes(editor);
    const nodesWithDiffState = editor.getEditorState().read(() => {
      return allNodes
        .map((n) => ({
          type: n.getType(),
          text: n.getTextContent().substring(0, 50),
          diffState: $getDiffState(n),
        }))
        .filter((n) => n.diffState !== null && n.diffState !== undefined);
    });

    console.log('Nodes with diff state after formatting change:', JSON.stringify(nodesWithDiffState, null, 2));

    // This is a real formatting change, so we should see diff markers
    const addedOrRemoved = nodesWithDiffState.filter(
      (n) => n.diffState === 'added' || n.diffState === 'removed'
    );
    expect(addedOrRemoved.length).toBeGreaterThan(0);
  });

  test('Unchanged bold list items should not appear in diff when new items are added', () => {
    const originalMarkdown = `- **Apple** - YummApple - Yum
- **Banana** - TastyBanana - Tasty`;

    const targetMarkdown = `- **Apple** - YummApple - Yum
- **Banana** - TastyBanana - Tasty
- Mango - Sweet
- Strawberry - Juicy`;

    const result = setupMarkdownReplaceTestWithFullReplacement(
      originalMarkdown,
      targetMarkdown,
    );

    const {addNodes, removeNodes} = result.getDiffNodes();
    const addTexts = result.replaceEditor
      .getEditorState()
      .read(() => addNodes.map((n) => n.getTextContent()));
    const removeTexts = result.replaceEditor
      .getEditorState()
      .read(() => removeNodes.map((n) => n.getTextContent()));

    for (const text of removeTexts) {
      expect(text).not.toContain('Apple');
      expect(text).not.toContain('Banana');
    }

    expect(addTexts.some((t) => t.includes('Mango'))).toBe(true);
    expect(addTexts.some((t) => t.includes('Strawberry'))).toBe(true);

    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Bold list items with text modifications - only modified items should show diff', () => {
    const originalMarkdown = `- **Apple** - YummApple - Yum
- **Banana** - TastyBanana - Tasty
- **Mango** - Sweet
- **Strawberry** - Juicy`;

    const targetMarkdown = `- **Apple** - YummApple - Yum
- **Banana** - TastyBanana - Tasty
- **Mango** - Very Sweet
- **Strawberry** - Extra Juicy`;

    const result = setupMarkdownReplaceTestWithFullReplacement(
      originalMarkdown,
      targetMarkdown,
    );

    const {addNodes, removeNodes} = result.getDiffNodes();
    const addTexts = result.replaceEditor
      .getEditorState()
      .read(() => addNodes.map((n) => n.getTextContent()));
    const removeTexts = result.replaceEditor
      .getEditorState()
      .read(() => removeNodes.map((n) => n.getTextContent()));

    for (const text of [...addTexts, ...removeTexts]) {
      expect(text).not.toContain('Apple');
      expect(text).not.toContain('Banana');
    }

    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });
});
