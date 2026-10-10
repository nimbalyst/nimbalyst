// @vitest-environment node
import {$getRoot} from 'lexical';
import {
  setupMarkdownReplaceTest,
  assertApproveProducesTarget,
  assertRejectProducesOriginal,
} from '../../utils/replaceTestUtils';
import {$getDiffState} from '../../../core/DiffState';
import {$isQuadrantNode} from '../../../../QuadrantPlugin/QuadrantNodeCore';

const fence = (point: string) => `\`\`\`2x2
x: Low -> High
y: Low -> High
- ${point}
\`\`\``;

describe('Markdown Diff - 2x2 quadrant changes', () => {
  test('an edited 2x2 body shows the new chart, and approve/reject settle on target/original', () => {
    const originalMarkdown = `# Priorities\n\n${fence('First: 0.25, 0.75')}`;
    const result = setupMarkdownReplaceTest(originalMarkdown, [
      {oldText: fence('First: 0.25, 0.75'), newText: fence('First: 0.9, 0.1')},
    ]);

    // The live block renders from the node's source, so the pending diff must
    // already carry the agent's body -- a 'modified' marker on the old source
    // draws the old chart and the edit never shows.
    result.replaceEditor.getEditorState().read(() => {
      const quadrants = $getRoot().getChildren().filter($isQuadrantNode);
      const shown = quadrants.filter((node) => $getDiffState(node) !== 'removed');
      expect(shown).toHaveLength(1);
      expect(shown[0].getSource()).toContain('First: 0.9, 0.1');
      expect($getDiffState(shown[0])).not.toBeNull();
    });

    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });
});
