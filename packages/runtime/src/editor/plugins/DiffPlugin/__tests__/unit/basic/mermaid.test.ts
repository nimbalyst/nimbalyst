/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$getRoot} from 'lexical';
import {
  setupMarkdownReplaceTest,
  assertApproveProducesTarget as assertApproveProducesTargetReplace,
  assertRejectProducesOriginal as assertRejectProducesOriginalReplace,
  getAllNodes,
} from '../../utils/replaceTestUtils';
import {$getDiffState} from '../../../core/DiffState';
import {MERMAID_TRANSFORMER} from '../../../../MermaidPlugin/MermaidTransformer';
import {MARKDOWN_TEST_TRANSFORMERS} from '../../utils/testConfig';

// Include mermaid transformer for these tests
// MERMAID_TRANSFORMER must come BEFORE CODE transformer so it matches first
const MERMAID_TEST_TRANSFORMERS = [MERMAID_TRANSFORMER, ...MARKDOWN_TEST_TRANSFORMERS];

describe('Markdown Diff - Mermaid Diagram Changes', () => {
  test('Simple pie chart value change (40 -> 60)', () => {
    const originalMarkdown = `# Mermaidsmall

\`\`\`mermaid
pie title Project Time Distribution
    "Development" : 40
    "Testing" : 20
    "Documentation" : 15
    "Meetings" : 10
    "Code Review" : 15
\`\`\``;

    const replacements = [
      {
        oldText: `\`\`\`mermaid
pie title Project Time Distribution
    "Development" : 40
    "Testing" : 20
    "Documentation" : 15
    "Meetings" : 10
    "Code Review" : 15
\`\`\``,
        newText: `\`\`\`mermaid
pie title Project Time Distribution
    "Development" : 60
    "Testing" : 20
    "Documentation" : 15
    "Meetings" : 10
    "Code Review" : 15
\`\`\``,
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements, {
      transformers: MERMAID_TEST_TRANSFORMERS,
    });

    // Check that we have mermaid nodes (old and new after diff)
    const allNodes = getAllNodes(result.replaceEditor);
    const mermaidNodes = allNodes.filter((node) => node.getType() === 'mermaid');
    expect(mermaidNodes.length).toBeGreaterThan(0);

    // Check that there are diff markers - this is the key assertion
    // If mermaid diffing isn't working, there will be no add/remove nodes
    const {addNodes, removeNodes} = result.getDiffNodes();

    // For a content change in mermaid, we expect either:
    // 1. Update with add/remove markers (inline diff)
    // 2. Old node marked as removed, new node marked as added (block replacement)
    const hasDiffMarkers = addNodes.length > 0 || removeNodes.length > 0;
    expect(hasDiffMarkers).toBe(true);

    // Test that approving produces the target and rejecting produces the original
    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });

  test('Mermaid flowchart node text change', () => {
    const originalMarkdown = `# Flow

\`\`\`mermaid
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Do Something]
    B -->|No| D[End]
\`\`\``;

    const replacements = [
      {
        oldText: `\`\`\`mermaid
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Do Something]
    B -->|No| D[End]
\`\`\``,
        newText: `\`\`\`mermaid
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Execute Action]
    B -->|No| D[End]
\`\`\``,
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements, {
      transformers: MERMAID_TEST_TRANSFORMERS,
    });

    // Check for diff markers
    const {addNodes, removeNodes} = result.getDiffNodes();
    const hasDiffMarkers = addNodes.length > 0 || removeNodes.length > 0;
    expect(hasDiffMarkers).toBe(true);

    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });

  test('Identical mermaid diagrams should not have diff markers', () => {
    const markdown = `# Diagram

\`\`\`mermaid
graph LR
    A --> B --> C
\`\`\`

Some text after.`;

    // Use the same markdown for both source and target - no changes
    const result = setupMarkdownReplaceTest(markdown, [], {
      transformers: MERMAID_TEST_TRANSFORMERS,
    });

    // Check that the mermaid node has no diff state
    result.replaceEditor.getEditorState().read(() => {
      const root = $getRoot();

      // Find the mermaid node
      let mermaidNode: any = null;
      function findMermaidNode(node: any): void {
        if (node.getType() === 'mermaid') {
          mermaidNode = node;
          return;
        }
        if (node.getChildren) {
          const children = node.getChildren();
          for (const child of children) {
            findMermaidNode(child);
            if (mermaidNode) return;
          }
        }
      }

      findMermaidNode(root);

      if (mermaidNode) {
        const diffState = $getDiffState(mermaidNode);
        // Mermaid node should have no diff state since content is identical
        expect(diffState).toBeNull();
      } else {
        throw new Error('Mermaid node not found in editor');
      }
    });

    // Also verify approve/reject work correctly (should be no-ops)
    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });

  test('Mermaid diagram with same content but different surrounding text', () => {
    const originalMarkdown = `# Original Title

Here is the diagram:

\`\`\`mermaid
sequenceDiagram
    Alice->>Bob: Hello
    Bob->>Alice: Hi
\`\`\`

Original text after.`;

    // The mermaid content is identical, only surrounding text changes
    const result = setupMarkdownReplaceTest(originalMarkdown, [
      {oldText: '# Original Title', newText: '# Updated Title'},
      {oldText: 'Here is the diagram:', newText: 'Here is the updated diagram:'},
      {oldText: 'Original text after.', newText: 'Updated text after.'},
    ], {
      transformers: MERMAID_TEST_TRANSFORMERS,
    });

    // Check that the mermaid node has no diff state since its content is unchanged
    result.replaceEditor.getEditorState().read(() => {
      const root = $getRoot();

      // Find the mermaid node
      let mermaidNode: any = null;
      function findMermaidNode(node: any): void {
        if (node.getType() === 'mermaid') {
          mermaidNode = node;
          return;
        }
        if (node.getChildren) {
          const children = node.getChildren();
          for (const child of children) {
            findMermaidNode(child);
            if (mermaidNode) return;
          }
        }
      }

      findMermaidNode(root);

      if (mermaidNode) {
        const diffState = $getDiffState(mermaidNode);
        // Mermaid node should have no diff state since its content is identical
        expect(diffState).toBeNull();
      } else {
        throw new Error('Mermaid node not found in editor');
      }
    });

    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });

  test('Adding a new mermaid diagram', () => {
    const originalMarkdown = `# Document

Some text here.`;

    const replacements = [
      {
        oldText: 'Some text here.',
        newText: `Some text here.

\`\`\`mermaid
graph TD
    A --> B
\`\`\``,
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements, {
      transformers: MERMAID_TEST_TRANSFORMERS,
    });

    // Check that we have a mermaid node that was added
    const {addNodes} = result.getDiffNodes();
    const addedMermaid = addNodes.some(node => node.getType() === 'mermaid');
    expect(addedMermaid).toBe(true);

    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });

  test('Removing a mermaid diagram', () => {
    const originalMarkdown = `# Document

Some text here.

\`\`\`mermaid
graph TD
    A --> B
\`\`\`

More text.`;

    const replacements = [
      {
        oldText: `Some text here.

\`\`\`mermaid
graph TD
    A --> B
\`\`\`

More text.`,
        newText: `Some text here.

More text.`,
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements, {
      transformers: MERMAID_TEST_TRANSFORMERS,
    });

    // Check that we have a mermaid node that was removed
    const {removeNodes} = result.getDiffNodes();
    const removedMermaid = removeNodes.some(node => node.getType() === 'mermaid');
    expect(removedMermaid).toBe(true);

    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });
});
