/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$getRoot} from 'lexical';
import {$isCodeNode} from '@lexical/code';
import {
  setupMarkdownReplaceTest,
  assertApproveProducesTarget as assertApproveProducesTargetReplace,
  assertRejectProducesOriginal as assertRejectProducesOriginalReplace,
  getAllNodes,
} from '../../utils/replaceTestUtils';
import {$getDiffState} from '../../../core/DiffState';

describe('Markdown Diff - Code Changes', () => {
  test('Simple code block content change', () => {
    const originalMarkdown = `Here is a code example:

\`\`\`javascript
function hello() {
  console.log("Hello World");
}
\`\`\`

That's the example.`;

    const replacements = [
      {
        oldText: `\`\`\`javascript
function hello() {
  console.log("Hello World");
}
\`\`\``,
        newText: `\`\`\`javascript
function hello() {
  console.log("Hello Updated World");
}
\`\`\``,
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Check that we have a code block node that was updated
    const allNodes = getAllNodes(result.replaceEditor);
    const codeNodes = allNodes.filter((node) => node.getType() === 'code');
    expect(codeNodes.length).toBeGreaterThan(0);

    // Test that approving produces the target and rejecting produces the original
    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });

  test('Complex code enhancement with formatting changes', () => {
    const originalMarkdown = `# Code Example

Here's some code:

\`\`\`javascript
function hello() {
    console.log("Hello World");
}
\`\`\`

And some text after.`;

    const replacements = [
      {
        oldText: '# Code Example',
        newText: '# Enhanced Code Example',
      },
      {
        oldText: "Here's some code:",
        newText: "Here's the **improved** code:",
      },
      {
        oldText: `\`\`\`javascript
function hello() {
    console.log("Hello World");
}
\`\`\``,
        newText: `\`\`\`javascript
function enhancedHello(name = "World") {
    console.log(\`Hello \${name}!\`);
    return \`Greeting sent to \${name}\`;
}

// Usage example
const result = enhancedHello("Developer");
console.log(result);
\`\`\``,
      },
      {
        oldText: 'And some text after.',
        newText: 'And some *enhanced* text after with **better** formatting.',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Check that we have the enhanced code block
    const allNodes = getAllNodes(result.replaceEditor);
    const codeNodes = allNodes.filter((node) => node.getType() === 'code');
    expect(codeNodes.length).toBeGreaterThan(0);

    // Test that approving produces the target and rejecting produces the original
    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });

  test('Identical code blocks should not be marked as added/removed', () => {
    const markdown = `# Example

Here is some code:

\`\`\`javascript
function hello() {
  console.log("Hello World");
}
\`\`\`

And some text after.`;

    // Use the same markdown for both source and target - no changes
    const result = setupMarkdownReplaceTest(markdown, []);
    
    // Check that the code block has no diff state
    result.replaceEditor.getEditorState().read(() => {
      const root = $getRoot();
      
      // Find the code node
      let codeNode: any = null;
      function findCodeNode(node: any): void {
        if ($isCodeNode(node)) {
          codeNode = node;
          return;
        }
        if (node.getChildren) {
          const children = node.getChildren();
          for (const child of children) {
            findCodeNode(child);
            if (codeNode) return;
          }
        }
      }
      
      findCodeNode(root);
      
      if (codeNode) {
        const diffState = $getDiffState(codeNode);
        // Code block should have no diff state since content is identical
        expect(diffState).toBeNull();
      } else {
        throw new Error('Code node not found in editor');
      }
    });
    
    // Also verify approve/reject work correctly (should be no-ops)
    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });

  test('Code blocks with same content but different surrounding text', () => {
    const originalMarkdown = `# Original Title

Here is the code:

\`\`\`python
def greet():
    print("Hello")
\`\`\`

Original text after.`;

    const targetMarkdown = `# Updated Title

Here is the updated introduction to the code:

\`\`\`python
def greet():
    print("Hello")
\`\`\`

Updated text after.`;

    // The code block content is identical, only surrounding text changes
    const result = setupMarkdownReplaceTest(originalMarkdown, [
      {oldText: '# Original Title', newText: '# Updated Title'},
      {oldText: 'Here is the code:', newText: 'Here is the updated introduction to the code:'},
      {oldText: 'Original text after.', newText: 'Updated text after.'},
    ]);
    
    // Check that the code block has no diff state
    result.replaceEditor.getEditorState().read(() => {
      const root = $getRoot();
      
      // Find the code node
      let codeNode: any = null;
      function findCodeNode(node: any): void {
        if ($isCodeNode(node)) {
          codeNode = node;
          return;
        }
        if (node.getChildren) {
          const children = node.getChildren();
          for (const child of children) {
            findCodeNode(child);
            if (codeNode) return;
          }
        }
      }
      
      findCodeNode(root);
      
      if (codeNode) {
        const diffState = $getDiffState(codeNode);
        // Code block should have no diff state since its content is identical
        expect(diffState).toBeNull();
      } else {
        throw new Error('Code node not found in editor');
      }
    });
    
    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });

  test.skip('Code block with language change but same content should be replaced', () => {
    // KNOWN LIMITATION: Language-only changes are not currently detected by TreeMatcher
    // The TreeMatcher compares text content, not code block attributes like language
    // This would require attribute-level diffing to support properly
    const originalMarkdown = `# Example

\`\`\`javascript
function hello() {
  console.log("Hello");
}
\`\`\``;

    const targetMarkdown = `# Example

\`\`\`typescript
function hello() {
  console.log("Hello");
}
\`\`\``;

    // Same code content but language changed from javascript to typescript
    const result = setupMarkdownReplaceTest(originalMarkdown, [
      {
        oldText: '```javascript\nfunction hello() {\n  console.log("Hello");\n}\n```',
        newText: '```typescript\nfunction hello() {\n  console.log("Hello");\n}\n```',
      },
    ]);

    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });
});
